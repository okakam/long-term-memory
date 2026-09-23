# Codex MCP OAuth認証設計

## 状態

設計承認済み・実装計画再点検済み。実装は未着手。実装の正本は `docs/superpowers/plans/2026-09-21-mcp-oauth-codex-login.md` とし、対象は `long-term-memory` のリモートMCPを、PATを手入力せず `codex mcp login long-term-memory` で認証できるようにすることである。

## 1. 目的と完了条件

現在のMCPは `POST /api/mcp?project_id=<slug>` にPAT (`Authorization: Bearer ltm_...`) を要求する。Codex側も `bearer_token_env_var` を持つ設定になっており、OAuth discoveryも認可エンドポイントも提供していない。この構成を、Codex CLIのMCP OAuthログインに対応した構成へ移行する。

完了時には、次を満たす。

- 利用者はPATを作成・コピーせず、MCP URLを登録してから `codex mcp login long-term-memory` を実行できる。
- ブラウザで既存のlong-term-memoryアカウントへログインし、認可を完了すると、Codexが保存したOAuth credentialでMCPを利用できる。
- OAuth access tokenでも、各MCPリクエストごとにFirestoreのproject membershipと既存のtool別権限を検証する。
- `__shared__` への書き込みはOAuthログインでは許可せず、既存どおりcurator principalと`LTM_MAINTENANCE_TOKEN`の二重条件を維持する。
- GitHub Actions、remote curator、Cloud Run smokeの機械処理は、移行期間中も既存PATで継続できる。

CodexはStreamable HTTP MCPにOAuth、CIMD、DCRをサポートし、OAuth対応サーバーに対して `codex mcp login <server-name>` を実行する。[OpenAI公式MCPドキュメント](https://developers.openai.com/codex/mcp/)

## 2. 採用方式

Firebase AuthenticationはWebの本人確認と`@okakam.net`制限を担い続ける。FirebaseをMCP OAuth authorization serverとして直接使うのではなく、同一Cloud RunのNext.jsアプリにOAuth 2.1 authorization server層を追加する。

Firebase session cookieを確認できる利用者だけがOAuth認可コードを得る。OAuth access tokenから得たFirebase UID相当の`userId`を既存の`assertProjectAccess`へ渡し、project membershipを認可の正本として維持する。したがって、OAuth tokenにproject roleを複製しない。membershipを削除した場合は、未失効tokenでも次のMCPリクエストから拒否される。

初期リリースはDynamic Client Registration（DCR）を提供する。authorization server metadataでCIMD capabilityを広告しないため、Codexの既定`auto`はDCRを選択する。受入確認では、既定の`codex mcp login long-term-memory`に加え、`--oauth-client-registration dcr`も確認する。CIMD、事前登録client、client credentials grant、OIDC ID token発行は初期リリースの対象外とする。

この選択により、Firebaseのユーザー・session・メールドメイン制限・Firestore membershipを置換しない。将来、SSO、複数アプリ共通ID、外部IdPの必須要件が生じた場合だけ、OAuth層の`IdentityProvider`境界の実装を差し替える。今回、Firebaseを全面置換する実装は行わない。

## 3. 公開エンドポイントとMCP discovery

本番のissuerは`MCP_PUBLIC_URL`を末尾`/`なしで正規化した `https://ltm.okakam.net` とする。query、fragment、Cloud Run直接URLをissuerへ混在させない。`MCP_OAUTH_ENABLED=1`の本番環境では、`AUTH_REQUIRED=1`とHTTPSの`MCP_PUBLIC_URL`を必須にする。不正な組合せではOAuth tokenを発行せず、設定エラーとして起動・route検証を失敗させる。

OAuth層は次を提供する。

| エンドポイント | 役割 |
| --- | --- |
| `GET /.well-known/oauth-protected-resource/api/mcp` | MCP resource `https://ltm.okakam.net/api/mcp`、authorization server、`mcp:access` scopeを返すRFC 9728 metadata |
| `GET /.well-known/oauth-authorization-server` | issuer、authorization/token/registration/revocation endpoint、PKCE S256、DCR、scopeを返すauthorization server metadata |
| `GET /oauth/authorize` | client、redirect URI、PKCE、scope、resourceを検証し、ログインまたは認可画面を開始する |
| `POST /oauth/authorize` | 同一認可transactionの同意または拒否を処理し、authorization codeまたはOAuth errorをredirect URIへ返す |
| `POST /oauth/token` | authorization code grantとrefresh token grantを処理する |
| `POST /oauth/register` | Codex用public clientをDCRで登録する |
| `POST /oauth/revoke` | access tokenまたはrefresh tokenと、そのrefresh token familyを失効する |
| `GET /api/auth/oauth-grants` | 本人のOAuth接続一覧を返す |
| `DELETE /api/auth/oauth-grants?grant_id=<id>` | 本人がOAuth接続を失効する |

OAuth metadata、protected-resource metadataは認証不要・`Cache-Control: no-store`で返す。`/api/mcp`がcredentialなしまたは無効なOAuth credentialを受けた場合は、HTTP 401と次の形式の`WWW-Authenticate`を返す。

```text
Bearer resource_metadata="https://ltm.okakam.net/.well-known/oauth-protected-resource/api/mcp"
```

OAuth tokenに`mcp:access`がない場合はHTTP 403、`error="insufficient_scope"`、必要scope、同じresource metadata URLを返す。PATの失効・形式不正も、tokenの有無や種類を開示せず同じ401契約を使う。

初期DCRは`http://127.0.0.1[:port]/<callback-path>`形式のIPv4 loopback callbackだけを登録可能にする。authorize時はscheme、host、pathを一致させ、`127.0.0.1`のportだけを可変とする。`localhost`、`[::1]`、HTTPS、custom scheme、port 0、root path、query、fragmentを持つURIは拒否する。Native Appのloopback redirectはlistenerの空きportを使うため、登録時とauthorize時のport差を許可する（[RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3)）。

## 4. OAuthデータモデル

OAuth専用の`OAuthStoreLike`を新設し、既存PATを持つ`AuthStoreLike`へ無関係な責務を広げない。cloudではFirestore adapter、local/testではSQLite adapterを実装する。OAuth秘密値の平文はFirestore、SQLite、ログ、例示用設定、MCP応答に保存しない。

| 論理データ | 主なフィールド | 保存・寿命 |
| --- | --- | --- |
| OAuth client | client ID、表示名、redirect URI、grant type、作成日時 | `oauthClients/<client_id>`。DCRのpublic clientだけを受け付ける |
| 認可transaction | transaction hash、client ID、redirect URI、PKCE challenge、scope、resource、同意前後の状態、期限 | `oauthAuthorizationTransactions/<sha256(transaction)>`。Firebaseログインから認可画面へ復帰するために10分だけ保持する |
| authorization code | code hash、user ID、client ID、redirect URI、PKCE challenge、scope、resource、発行/利用/失効日時 | `oauthAuthorizationCodes/<code_hash>`。60秒、一回だけ交換可能 |
| access token | token ID、token hash、prefix、user ID、client ID、scope、resource、発行/最終利用/期限/失効日時 | `oauthAccessTokens/<token_hash>`。15分。`mcp:access`を持つopaque bearer token |
| refresh token | token ID、token hash、family ID、user ID、client ID、scope、resource、発行/期限/失効/置換日時 | `oauthRefreshTokens/<token_hash>`。30日。利用ごとにrotateし、旧token再利用時はfamily全体を失効 |
| OAuth grant | grant ID、user ID、client ID、scope、作成/最終利用/失効日時 | `oauthGrants/<user_id>/grants/<grant_id>`と`oauthGrantCredentials/<grant_id>/tokens/<token_hash>`。Settings一覧とgrant単位の失効に使う |
| rate-limit counter | endpoint、rate key hash、time bucket、count、expiry | `oauthRateLimits/<endpoint>:<scope>:<key_hash>:<bucket>`。Firestore TTLで削除する |

authorization code、access token、refresh token、transaction IDは少なくとも256 bitの暗号学的乱数から生成する。永続保存するsecretは既存PATと同様にSHA-256 hashとprefixだけとし、Firestoreではhashをdocument IDにしてMCP request、token exchange、revokeをO(1)参照する。grant失効とrefresh family失効は`oauthGrantCredentials` subcollectionをtransaction内で列挙するため、全OAuth credential collectionの走査を行わない。既存Firestore gatewayにはtransaction内collection readを追加し、credential subcollectionのreadと失効writeを同じFirestore transactionで完結させる。opaque tokenを採用するため、OAuth signing keyやJWT key rotationは追加しない。

access tokenのresourceは`https://ltm.okakam.net/api/mcp`に固定する。MCP URLの`project_id` queryはresource metadataのresourceへ含めず、各リクエストの既存membership検証へ渡す。これにより、同一利用者が所属する複数projectを一つのCodex接続から安全に利用でき、queryの書き換えだけで未所属projectへアクセスすることはできない。

## 5. 認証・認可フロー

```text
Codex CLI
  -> protected-resource metadata / authorization-server metadata
  -> DCR: public clientとloopback callbackを登録
  -> GET /oauth/authorize (PKCE S256, state, resource)
Browser
  -> Firebase session cookieを確認
  -> 未ログインなら /sign-in を経て同じOAuth transactionへ復帰
  -> project権限に関係しないMCP接続同意画面
  -> loopback callbackへ code + state をredirect
Codex CLI
  -> POST /oauth/token (code + PKCE verifier)
  -> opaque access token / rotating refresh tokenを安全なcredential storeへ保存
  -> POST /api/mcp?project_id=<slug> (Bearer OAuth access token)
Cloud Run
  -> OAuth token検証 -> userId
  -> 既存のproject membership・tool別権限・shared curator gateを検証
```

`/oauth/authorize`は、client ID、redirect URI、`response_type=code`、`code_challenge_method=S256`、resource、scopeを検証する。許可するscopeは`mcp:access`だけであり、要求scopeが空の場合はこのscopeを用いる。認可画面は接続するclient表示名、MCP server名、付与するアクセス範囲、既存のproject membershipが各呼び出しで再確認されることを表示する。

本人確認は既存Firebase session cookieで行う。sessionがない場合、認可requestの全parameterを信頼しないreturn URLへコピーせず、サーバー保存の短命transaction IDだけをHttpOnly・Secure・SameSite=Lax cookieで保持して既存`/sign-in`へ遷移する。サインイン成功後にtransactionを再読込みして認可画面へ戻す。Firebase principal作成時の`@okakam.net`完全一致検証を再利用するため、許可外メールはOAuth codeを得られない。

`POST /oauth/authorize`はCSRF tokenとtransaction cookieを照合し、同意済みのauthorization codeを一度だけ発行する。拒否、期限切れ、無効client、redirect URI不一致はOAuth標準errorを用い、検証済みredirect URIへだけ返す。検証前エラーはredirectせず400を返す。

`POST /oauth/token`はpublic clientのauthorization code grantとrefresh token grantだけを受け付ける。authorization code exchangeではclient、redirect URI、resource、PKCE verifierをcode記録と照合した後、codeを原子的に使用済みにし、access/refresh tokenを発行する。refreshでは新しいaccess/refresh tokenを発行して旧refresh tokenを即時失効する。失効済みrefresh tokenの再利用はtoken漏えいとして扱い、同じfamilyの全tokenを失効する。

MCP transportはBearer tokenをOAuth access tokenとして先に検証し、OAuth tokenではない`ltm_` prefixだけを既存PAT検証へ渡す。OAuth tokenとPATのprincipalは共通の`{ userId, credentialId, credentialKind }`に正規化する。`assertProjectAccess`、ownerだけの`reindex`、shared scopeのcurator principalとmaintenance tokenの二重条件はその後に従来どおり評価する。Firebase ID tokenをMCPのBearer tokenとして受け付けない。

## 6. セキュリティ境界

- 本番OAuth endpointとissuerはHTTPSだけを許可する。`MCP_OAUTH_ENABLED=1`かつ`AUTH_REQUIRED=0`の構成ではtokenを発行しない。
- PKCE S256は必須とし、plain method、implicit flow、password grant、client credentials grantを実装しない。
- DCRはpublic native clientを対象にする。requestは正確に1件の`redirect_uris`、任意`client_name`、任意`grant_types`、任意`response_types`、任意`token_endpoint_auth_method`、任意`scope`、任意`application_type: 'native'`だけを読み、未指定のgrant/response/auth methodは`['authorization_code', 'refresh_token']`、`['code']`、`'none'`へ正規化する。`scope`は省略可能だが指定時は`mcp:access`だけ、`application_type`は指定時`native`だけを受け付け、指定値をregistration responseにも返す。これ以外のscope/application type/grant/response/auth methodとmetadataの未知fieldは`invalid_client_metadata`で拒否し、未知fieldは保存しない。redirect URIは有効なportを任意で持つ`http://127.0.0.1`の非root callbackだけを受け付け、認可時はport差のみ許容する。wildcard、custom scheme、query、fragment、port 0、`localhost`、IPv6、HTTPSを拒否する。
- OAuth endpointsは`Cache-Control: no-store`を返す。authorization code、access token、refresh token、Firebase ID token、cookieを構造化ログ、例外本文、analyticsへ出力しない。queryを含むauthorize requestもrequest loggingではredactする。
- `/oauth/authorize`の同意POSTはCSRF防御を必須にする。token、register、revokeにはcookie認証を使わず、client/tokenの検証だけを行う。Settingsのgrant一覧・失効は既存Firebase sessionとsame-origin検証を必須にする。
- DCR、authorize、token、revokeにはFirestore-backedの固定window rate limitを適用し、process-local counterだけには依存しない。DCRはglobal 30/10分に加えCloud Runが付与する`X-Forwarded-For`先頭の正規化IP hashごとに5/10分、authorizeはIP hashごとに20/10分、tokenは`client_id + IP hash`ごとに60/10分、revokeはIP hashごとに30/10分とする。forwarded IPは認可identityには使わずrate-limit admission keyとしてのみ扱い、`X-Real-IP`など任意headerは読まない。IPが欠ける/不正なら`unknown` bucketに集約し、DCR global bucketも必ず評価する。超過は`Retry-After`付き429とOAuth `temporarily_unavailable`を返す。counterはFirestore Timestampの`expires_at`を持ち、`oauthRateLimits` collection groupの`expires_at`をTTL fieldに設定する。TTL削除は遅延し得るため、window判定は常に`expires_at`をアプリ側でも評価する。
- revokeまたはSettingsでgrantを失効すると、対応するaccess token、refresh token、未使用codeを失効する。member削除は既存membership検証により即時にMCP利用を止める。
- `__shared__` writeはOAuth scopeやOAuth grantで許可しない。`LTM_CURATOR_USER_ID`と`LTM_MAINTENANCE_TOKEN`を持つ既存PAT機械処理だけが維持書き込みを行う。

## 7. 互換性とロールアウト

OAuthを有効にするまでの既存PAT動作は維持する。production deployではまずコードとmetadata endpointを導入し、`MCP_OAUTH_ENABLED=0`のまま既存PAT smokeを確認する。その後、`MCP_OAUTH_ENABLED=1`、`AUTH_REQUIRED=1`、正規化済み`MCP_PUBLIC_URL=https://ltm.okakam.net`を同一releaseへ設定してOAuthを有効化する。

OAuth有効化後も、以下はPATを使い続ける。

- GitHub ActionsのCloud Run smoke用`LTM_MCP_TOKEN`
- remote curatorの`LTM_MCP_TOKEN`と`LTM_MAINTENANCE_TOKEN`
- `/settings/tokens`で既に発行された利用者PAT

Codex利用者向けの移行手順は、既存のBearer設定を削除してOAuth専用設定へ登録し直すものとする。明示Bearer tokenはCodex OAuth credentialより優先されるため、`bearer_token_env_var = "LTM_MCP_TOKEN"`を残したままOAuthログインを案内しない。

```bash
codex mcp remove long-term-memory
codex mcp add long-term-memory \
  --url "https://ltm.okakam.net/api/mcp?project_id=<project-slug>"
codex mcp login long-term-memory
```

OAuth rolloutに失敗した場合は、`MCP_OAUTH_ENABLED=0`へ戻してPAT経路を継続する。OAuth tokenを失効してもPATは自動失効しない。PAT廃止は、curator/CIをOAuth以外のmachine credentialへ移す別設計を承認した場合だけ検討する。

Git Flowでは、実装PRを`feature/mcp-oauth-codex-login`から`develop`へ作成し、`develop → main`のrelease PRがマージされたmain commitだけをProductionへdeployする。Production Environmentの設定変更・flag rollbackは、そのEnvironmentのwrite権限を持つdeploy実行者が担う。main deploy後のsmoke記録はmainへ直接commitせず、対象main SHAを含む別の`docs/mcp-oauth-production-smoke-*` branchから`develop`へdocumentation PRとして提出する。flag offのPAT smoke、metadata、Codex login、OAuth MCP toolsのいずれかが失敗した場合はOAuth有効化を中止し、deploy実行者が`MCP_OAUTH_ENABLED=0`へ戻して再deployする。

## 8. 変更範囲

実装計画では、少なくとも次を対象にする。

- OAuth protocol、token、client、grant、rate limit、identity providerのdomain modelとFirestore/SQLite adapter
- OAuth metadata、authorize、token、register、revoke、grant管理のNext.js routeと認可画面
- `src/lib/mcp/transport.ts`とPAT検証のOAuth principal統合、`WWW-Authenticate`契約
- Firebaseサインイン後にOAuth authorization transactionへ復帰するWeb UI
- `.env.example`、`docs/reproduction-spec.md`、`docs/post-mcp-setup.md`、`docs/google-cloud-cli-setup.md`、`docs/cloud-run-production-deployment.md`、`AGENTS.md`の正本更新
- unit、route integration、security regression、Codex CLI手動smokeの追加

`docs/mcp-config.cloud-run.json`、curator scripts、Cloud Run smokeのPAT契約は、OAuth rolloutの初期リリースでは互換性確認対象であり、OAuth設定へ置換しない。

## 9. 受入条件

ローカルではOAuth storeとFirebase identity providerをfakeにしたunit/integration testを実行し、実在するtokenやFirebase設定は使わない。本番のbrowser loginは外部認証情報を必要とするため、別途実環境smokeとして記録する。

- protected-resource metadataとauthorization-server metadataが正しいissuer、endpoint、`mcp:access`、DCR、PKCE S256を返す。
- DCRはCodex native metadata、任意の有効なportを持つ`http://127.0.0.1`のcallbackだけを登録し、unsupported application type/scope、port以外のURI不一致、`localhost`、IPv6、非loopback HTTP、HTTPS、wildcard、unsupported grant/response/auth methodを拒否する。
- rate limitはDCR global/IP、authorize IP、token client/IP、revoke IPの各上限、429/OAuth error、transaction競合、TTL期限切れcounterを検証する。
- 無効client、PKCE不一致、code再利用、code期限切れ、redirect URI不一致、resource不一致、scope不正をOAuth errorとして拒否する。
- refresh tokenはrotateし、旧token再利用時は同familyを失効する。Settings失効と`/oauth/revoke`はアクセス/refresh tokenを直ちに無効化する。
- OAuth access tokenで、owner/member/非memberのread・write・reindex権限、`__shared__` write拒否、member削除後の即時拒否を検証する。
- PATによる通常project利用、curatorのshared write、Cloud Run smoke scriptは回帰しない。
- 実環境で許可ドメインのユーザーが、Bearer設定なしの`codex mcp add`後に`codex mcp login long-term-memory`を完了できる。`initialize`、`tools/list`、read、write、ownerの`reindex`を確認する。
- 許可外Firebaseアカウント、未ログインbrowser、取り消し済みOAuth grant、失効token、未所属projectはMCPアクセスを得られない。

## 10. 非目標と再評価条件

この設計はFirebase Authenticationを全面置換しない。Email/Password、Googleログイン、Firebase Blocking Functions、`@okakam.net`制限、既存session cookie、FirestoreのUID/membershipは維持する。

次のいずれかが確定した場合は、OAuth層だけでなく認証基盤全体を置換する新しい設計を作成する。

- Firebase以外の企業SSOまたは複数外部IdPが必須になる。
- long-term-memory以外の複数サービスで統一したOIDC subjectとsession管理が必要になる。
- OAuth client管理、監査、条件付きアクセスを専用IdPの運用機能へ委譲する要件が生じる。
- Firebase UIDを維持するより、明示的なアカウント移行とmembership再紐付けの方が安全・低コストだと実測で判断できる。

この再評価条件が満たされない限り、FirebaseをIdP、Cloud Run内のOAuth層をMCP authorization server、Firestore membershipをresource authorizationの正本とする。
