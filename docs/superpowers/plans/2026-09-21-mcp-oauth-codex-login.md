# Codex MCP OAuth認証 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** long-term-memoryのリモートMCPを、PATを手入力せず `codex mcp login long-term-memory` で認証・利用できるようにする。

**Architecture:** Firebase AuthenticationはWebの本人確認と`@okakam.net`制限に残し、同じCloud Run/Next.jsアプリにDCR対応のOAuth 2.1 authorization serverを追加する。OAuth tokenはFirestore（local/testはSQLite）にhashだけを保存するopaque tokenとし、MCP到達後もFirestore membership・owner権限・shared curator gateを必ず再評価する。PATはcurator、CI、Cloud Run smokeとの互換用として維持する。

**Tech Stack:** Next.js 16 App Router、TypeScript、React 19、Zod 4、Node.js `crypto`、Firebase Admin SDK、Cloud Firestore、better-sqlite3、Vitest、@modelcontextprotocol/sdk 1.29。

**Spec:** `docs/superpowers/specs/2026-09-21-mcp-oauth-codex-login-design.md`

## Global Constraints

- OAuthからFirebaseログインへ戻すブラウザー向けredirectも公開issuerを使い、受信`Request.url`やCloud Run内部hostを使わない。

- productionのissuerは、末尾`/`、query、fragmentを除いた`MCP_PUBLIC_URL`であり、公開MCP URLは`https://ltm.okakam.net`とする。
- `MCP_OAUTH_ENABLED=1`では`AUTH_REQUIRED=1`とHTTPSの`MCP_PUBLIC_URL`を必須にし、不正設定でOAuth code/tokenを発行しない。
- 初期リリースのOAuth client registrationはDCRだけを広告する。CIMD、事前登録client、OIDC ID token、implicit/password/client-credentials grantは実装しない。
- authorization code、access token、refresh token、transaction IDは256 bit以上の暗号学的乱数を使い、永続層・ログ・例外・文書にはSHA-256 hashとprefixだけを残す。
- access tokenのTTLは15分、authorization codeは60秒、authorization transactionは10分、refresh tokenは30日とする。refresh tokenは毎回rotateし、旧token再利用時は同familyを失効する。
- DCRは正確に1件の`http://127.0.0.1[:port]/<callback-path>`、`grant_types: ['authorization_code', 'refresh_token']`、`response_types: ['code']`、`token_endpoint_auth_method: 'none'`、任意の`scope: 'mcp:access'`、任意の`application_type: 'native'`だけを受け入れる。callback portは任意で、認可時はport差だけを許容する。未指定のDCR metadataは許可値へ正規化し、unsupported valueは`invalid_client_metadata`で拒否する。
- OAuth rate limitは固定10分windowとし、DCRはglobal 30かつIP hash 5、authorizeはIP hash 20、tokenはclient ID + IP hash 60、revokeはIP hash 30を上限にする。IPはCloud Runの`X-Forwarded-For`先頭だけをadmission keyとして使い、認可identityには使わない。
- OAuthの許可scopeは`mcp:access`だけとする。project roleはtokenへ複製せず、毎リクエストの`assertProjectAccess`を正本とする。
- Firebase ID tokenをMCP Bearer tokenとして受け付けない。OAuth access tokenと既存`ltm_` PATだけを許可する。
- `__shared__` writeはOAuthでは許可せず、`LTM_CURATOR_USER_ID`と`LTM_MAINTENANCE_TOKEN`を満たす既存PAT curatorだけを許可する。
- metadata、OAuth endpointは`Cache-Control: no-store`を返す。token/code/cookieをログ出力しない。`/oauth/authorize`のqueryはredact対象とする。
- local開発の既定は`AUTH_REQUIRED=0`、`MCP_OAUTH_ENABLED=0`のままとし、OAuthのunit/route testはfake identityとin-memory SQLiteで行う。
- 実装は`feature/mcp-oauth-codex-login`ブランチで行い、`develop`と`main`へ直接commitしない。

---

## File Structure

| パス | 責務 |
| --- | --- |
| `src/lib/oauth/{types,config,crypto,redirect}.ts` | 型、feature flag、issuer、乱数/hash、DCR callback検証 |
| `src/lib/oauth/{store,sqlite-store,firestore-store}.ts` | OAuth client/code/token/grant/rate-limitの永続化とtest injection |
| `src/lib/oauth/{identity,service,http}.ts` | Firebase sessionの利用者解決、OAuth protocol、HTTP error/challenge |
| `src/app/.well-known/**/route.ts` | protected-resource / authorization-server metadata |
| `src/app/oauth/{authorize,token,register,revoke}/route.ts` | DCR、PKCE、authorization code、token、revoke endpoint |
| `src/components/OAuthAuthorizationPage.tsx` | tokenを表示しないserver-rendered同意フォーム |
| `src/app/sign-{in,up}/**`、`FirebaseAuthForm.tsx` | Firebaseログイン後の安全なOAuth transaction復帰 |
| `src/lib/mcp/{principal,context,transport}.ts` | OAuth/PAT共通principalとMCP 401 challenge |
| `src/app/api/auth/oauth-grants/route.ts`、`OAuthGrantSettings.tsx` | 接続一覧と本人による失効 |
| `.env.example`、workflow、正本docs、tests | feature flag、Codex導入、PAT互換、Cloud Run受入確認 |

### Task 1: OAuth基礎型、設定、秘密値ユーティリティ、redirect URI検証

**Files:**

- Create: `src/lib/oauth/types.ts`
- Create: `src/lib/oauth/config.ts`
- Create: `src/lib/oauth/crypto.ts`
- Create: `src/lib/oauth/redirect.ts`
- Test: `tests/lib/oauth/config.test.ts`
- Test: `tests/lib/oauth/crypto.test.ts`
- Test: `tests/lib/oauth/redirect.test.ts`

**Interfaces:**

- Produces: `export const MCP_OAUTH_SCOPE = 'mcp:access' as const`。
- Produces: `export type OAuthCredentialPrincipal = { userId: string; credentialId: string; credentialKind: 'oauth' }`。
- Produces: SQLite/Firestoreで共用するsnake_case record型 `OAuthClient`、`OAuthAuthorizationTransaction`、`OAuthAuthorizationCode`、`OAuthAccessToken`、`OAuthRefreshToken`、`OAuthGrantSummary`、`OAuthTokenSet`。各recordは`id`、`user_id`、`client_id`、`grant_id`、`scope`、`resource`、`created_at`、`expires_at`、`revoked_at`の該当項目を持ち、secretを保持する項目は`*_hash`と`*_prefix`だけにする。`OAuthTokenSet`は永続recordの`grant`、`accessToken`、`refreshToken`を一組にする。
- Produces: `export type ConsumeAuthorizationCodeInput = { codeHash: string; clientId: string; redirectUri: string }`、`export type RotateRefreshTokenInput = { refreshTokenHash: string; clientId: string; resource: string | null; now: string; next: OAuthTokenSet }`、`export type OAuthRefreshTokenRotation = { grant: OAuthGrantSummary; tokenSet: OAuthTokenSet } | null`、`export type OAuthRateLimitInput = { bucket: 'register' | 'authorize' | 'token' | 'revoke'; keyHash: string; limit: number; windowSeconds: 600; now: string }`。
- Produces: `getOAuthConfiguration(): { enabled: boolean; issuer: URL; resource: URL; metadataUrl: URL; accessTokenTtlSeconds: 900; refreshTokenTtlSeconds: 2592000; authorizationCodeTtlSeconds: 60; transactionTtlSeconds: 600 }`。
- Produces: `newOpaqueSecret(prefix: string): string`、`hashOpaqueSecret(secret: string): string`、`secretPrefix(secret: string): string`、`constantTimeEqual(left: string, right: string): boolean`。
- Produces: `validateDcrRedirectUri(value: string): URL`、`redirectUriMatches(registered: string, requested: string): boolean`、`getOAuthRateLimitPolicy(bucket: 'register' | 'authorize' | 'token' | 'revoke'): { windowSeconds: 600; limit: number; scope: 'global' | 'ip' | 'client-ip' }`、`getOAuthRateLimitKey(request: Request, clientId?: string): { ipHash: string; clientId: string | null }`。

- [ ] **Step 1: 設定とredirect URIの失敗テストを書く**

```ts
test('OAuth有効時はHTTPS issuerとAUTH_REQUIRED=1を要求する', () => {
  process.env.MCP_OAUTH_ENABLED = '1';
  process.env.AUTH_REQUIRED = '0';
  process.env.MCP_PUBLIC_URL = 'http://example.test';
  expect(() => getOAuthConfiguration()).toThrow(/AUTH_REQUIRED=1/);
});

test('loopback callbackはportだけを可変にする', () => {
  expect(redirectUriMatches(
    'http://127.0.0.1/callback/abc',
    'http://127.0.0.1:53124/callback/abc',
  )).toBe(true);
  expect(redirectUriMatches(
    'http://127.0.0.1/callback/abc',
    'http://127.0.0.1:53124/callback/other',
  )).toBe(false);
  expect(redirectUriMatches(
    'http://localhost/callback/abc',
    'http://localhost:53124/callback/abc',
  )).toBe(false);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run tests/lib/oauth/config.test.ts tests/lib/oauth/redirect.test.ts`

Expected: FAIL。`getOAuthConfiguration`と`redirectUriMatches`が未定義である。

- [ ] **Step 3: 固定型・設定・URI判定を実装する**

```ts
export const MCP_OAUTH_SCOPE = 'mcp:access' as const;

export function redirectUriMatches(registered: string, requested: string): boolean {
  const left = new URL(registered);
  const right = new URL(requested);
  if (left.protocol === 'http:' && left.hostname === '127.0.0.1'
    && right.protocol === 'http:' && right.hostname === '127.0.0.1') {
    validateDcrRedirectUri(registered);
    validateDcrRedirectUri(requested);
    return left.pathname === right.pathname && left.search === right.search;
  }
  return left.href === right.href;
}
```

`validateDcrRedirectUri`は有効なportを任意で持つ`http://127.0.0.1`の非root callback pathだけを受け入れ、port 0、query、fragment、custom scheme、wildcard、`localhost`、IPv6、HTTPSを拒否する。`redirectUriMatches`はIPv4 loopback callbackではport差だけを無視してpathを照合し、それ以外のURIは完全一致させる。enabled時の`getOAuthConfiguration`は`AUTH_REQUIRED=1`、HTTPS、hostname、query/fragmentなしのissuerを強制し、resourceを`new URL('/api/mcp', issuer)`、metadata URLを`/.well-known/oauth-protected-resource/api/mcp`とする。

- [ ] **Step 4: 秘密値のテストと実装を追加する**

```ts
test('opaque secretは毎回異なり、hashとprefixは本文を含まない', () => {
  const first = newOpaqueSecret('ltm_oat_');
  const second = newOpaqueSecret('ltm_oat_');
  expect(first).toMatch(/^ltm_oat_[A-Za-z0-9_-]+$/);
  expect(first).not.toBe(second);
  expect(hashOpaqueSecret(first)).not.toContain(first);
  expect(secretPrefix(first)).toBe(first.slice(0, 12));
});
```

Node.js `randomBytes(32).toString('base64url')`、SHA-256、`timingSafeEqual`を使う。token本文を例外へ埋め込まない。

- [ ] **Step 5: focused testを成功させる**

Run: `pnpm exec vitest run tests/lib/oauth/config.test.ts tests/lib/oauth/crypto.test.ts tests/lib/oauth/redirect.test.ts`

Expected: PASS。

- [ ] **Step 6: commitする**

```bash
git add src/lib/oauth tests/lib/oauth
git commit -m "feat: add OAuth configuration and security primitives"
```

### Task 2: OAuth永続storeとSQLite/Firestore migration

**Files:**

- Create: `src/lib/oauth/store.ts`
- Create: `src/lib/oauth/sqlite-store.ts`
- Create: `src/lib/oauth/firestore-store.ts`
- Modify: `src/lib/auth/schema.sql`
- Modify: `src/lib/auth/migrate.ts`
- Modify: `src/lib/auth/connection.ts`
- Modify: `src/lib/storage/firestore-metadata.ts`
- Test: `tests/lib/oauth/sqlite-store.test.ts`
- Test: `tests/lib/oauth/firestore-store.test.ts`
- Test: `tests/lib/auth/migrate.test.ts`

**Interfaces:**

- Consumes: Task 1の型とsecret helper。
- Produces: `OAuthStoreLike`、`getOAuthStore()`、`setOAuthStoreForTests()`、`resetOAuthStoreForTests()`。
- Produces: `FirestoreTransaction.list(collectionPath: string): Promise<FirestoreDocument[]>`。transaction内のsubcollection readを、同じtransactionのrevoke/rotation writeより前に完了させる。
- Produces: `registerClient`、`getClient`、`createAuthorizationTransaction`、`consumeAuthorizationTransaction`、`createAuthorizationCode`、`consumeAuthorizationCode`、`createTokenSet`、`findAccessTokenByHash`、`findRefreshTokenByHash`、`rotateRefreshToken`、`revokeAccessTokenByHash`、`revokeRefreshTokenFamilyByHash`、`listGrants`、`revokeGrant`。

- [ ] **Step 1: store contractの失敗テストを書く**

```ts
async function assertStoreContract(store: OAuthStoreLike) {
  await store.registerClient(client);
  await store.createAuthorizationCode(code);
  expect(await store.consumeAuthorizationCode({
    codeHash: code.code_hash, clientId: client.client_id, redirectUri: client.redirect_uris[0],
  })).toMatchObject({ user_id: 'user-1' });
  await expect(store.consumeAuthorizationCode({
    codeHash: code.code_hash, clientId: client.client_id, redirectUri: client.redirect_uris[0],
  })).resolves.toBeNull();
}
```

SQLiteとFirestore fake gatewayに同じcontractを適用する。Firestore contractでは、access/refresh/code/transactionを`sha256` document IDで`get`して全collectionをlistしないこと、grant/family失効は`oauthGrantCredentials/<grant_id>/tokens`だけをtransaction内でlistすることをfake gatewayのcall logで検証する。さらにaccess token hashの失効は当該access tokenだけを、refresh token hashの失効は同familyのaccess/refresh tokenと未使用codeを失効すること、refresh requestの`resource`省略は元recordのresourceを継承し、異なるresourceは拒否することを検証する。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run tests/lib/oauth/sqlite-store.test.ts tests/lib/oauth/firestore-store.test.ts`

Expected: FAIL。OAuth store moduleとschemaが存在しない。

- [ ] **Step 3: schema/migrationを追加する**

`schema.sql`へ`oauth_clients`、`oauth_authorization_transactions`、`oauth_authorization_codes`、`oauth_access_tokens`、`oauth_refresh_tokens`、`oauth_grants`、`oauth_rate_limits`を追加し、`CURRENT_AUTH_VERSION`を2へ上げる。token tableは`token_hash UNIQUE`、`token_prefix`、`user_id`、`client_id`、`grant_id`、`scope`、`resource`、期限、失効日時を持つ。refresh tableは`family_id`と`replaced_at`を持つ。既存`mcp_tokens`は変更しない。

- [ ] **Step 4: SQLiteとFirestore adapterを実装する**

```ts
export interface OAuthStoreLike {
  registerClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  createAuthorizationTransaction(value: OAuthAuthorizationTransaction): Promise<void>;
  getAuthorizationTransaction(id: string): Promise<OAuthAuthorizationTransaction | null>;
  consumeAuthorizationTransaction(input: { id: string; csrfHash: string; userId: string }): Promise<OAuthAuthorizationTransaction | null>;
  createAuthorizationCode(value: OAuthAuthorizationCode): Promise<void>;
  consumeAuthorizationCode(input: ConsumeAuthorizationCodeInput): Promise<OAuthAuthorizationCode | null>;
  createTokenSet(value: OAuthTokenSet): Promise<void>;
  findAccessTokenByHash(hash: string): Promise<OAuthAccessToken | null>;
  findRefreshTokenByHash(hash: string): Promise<OAuthRefreshToken | null>;
  rotateRefreshToken(input: RotateRefreshTokenInput): Promise<OAuthRefreshTokenRotation | null>;
  revokeAccessTokenByHash(tokenHash: string, revokedAt: string): Promise<boolean>;
  revokeRefreshTokenFamilyByHash(tokenHash: string, revokedAt: string): Promise<boolean>;
  revokeByGrantId(grantId: string, revokedAt: string): Promise<void>;
  listGrants(userId: string): Promise<OAuthGrantSummary[]>;
  revokeGrant(userId: string, grantId: string, revokedAt: string): Promise<boolean>;
  takeRateLimit(input: OAuthRateLimitInput): Promise<boolean>;
}
```

`SqliteOAuthStore`は`IndexStore.transaction`でauthorization transaction/code consume、access/refresh token set作成、refresh rotation、grant revokeを原子的に行う。`revokeAccessTokenByHash`はaccess recordだけを、`revokeRefreshTokenFamilyByHash`は見つけたrefresh recordのfamilyに属するaccess/refresh tokenと未使用codeを失効する。`FirestoreOAuthStore`は`oauthClients/<clientId>`、`oauthAuthorizationTransactions/<transaction_hash>`、`oauthAuthorizationCodes/<code_hash>`、`oauthAccessTokens/<token_hash>`、`oauthRefreshTokens/<token_hash>`を固定pathにして`FirestoreGateway.get`でO(1)参照する。grantごとのcredential reverse indexは`oauthGrantCredentials/<grant_id>/tokens/<token_hash>`とし、grant/family失効時だけ`FirestoreTransaction.list`でそのsubcollectionを同じtransaction内に読み、続く失効writeを原子的に行う。`AdminFirestoreTransaction.list`は`transaction.get(firestore.collection(collectionPath))`のsnapshotを`FirestoreDocument[]`へ変換し、fake gatewayもtransaction list call logを残す。`takeRateLimit`はFirestore transactionとSQLite updateで固定window counterを原子的に増やし、期限切れbucketを0として扱い、許容数を超えたら`false`を返す。Firestore counterの`expires_at`はTimestampで保存する。`firestore-metadata.ts`から`createFirestoreGateway()`をexportして既存fake gatewayを再利用する。

- [ ] **Step 5: focused testを成功させる**

Run: `pnpm exec vitest run tests/lib/auth/migrate.test.ts tests/lib/oauth/sqlite-store.test.ts tests/lib/oauth/firestore-store.test.ts`

Expected: PASS。既存PAT migrationを壊さず、OAuth code一回消費、rotation、revokeが通る。

- [ ] **Step 6: commitする**

```bash
git add src/lib/auth/schema.sql src/lib/auth/migrate.ts src/lib/auth/connection.ts src/lib/storage/firestore-metadata.ts src/lib/oauth tests/lib/auth/migrate.test.ts tests/lib/oauth
git commit -m "feat: persist OAuth credentials"
```

### Task 3: OAuth業務ロジック、PKCE、rate limit、Firebase identity境界

**Files:**

- Create: `src/lib/oauth/identity.ts`
- Create: `src/lib/oauth/service.ts`
- Create: `src/lib/oauth/http.ts`
- Test: `tests/lib/oauth/service.test.ts`
- Test: `tests/lib/oauth/identity.test.ts`
- Test: `tests/lib/oauth/http.test.ts`

**Interfaces:**

- Consumes: `OAuthStoreLike`（Task 2）、設定/crypto/redirect（Task 1）、既存`getFirebasePrincipal`。
- Produces: `OAuthIdentityProvider.getPrincipal(request: Request): Promise<{ userId: string; email: string | null } | null>`と`FirebaseOAuthIdentityProvider`。
- Produces: `OAuthAuthorizationRequest = { clientId: string; redirectUri: string; responseType: 'code'; scope: 'mcp:access'; resource: string; state: string | null; codeChallenge: string; codeChallengeMethod: 'S256' }`、`OAuthAuthorizationStart = { transactionId: string; csrfToken: string; clientName: string; scope: 'mcp:access' }`、`OAuthAuthorizationApproval = { redirectUri: string; state: string | null; code?: string; error?: 'access_denied' }`、`OAuthTokenResponse = { accessToken: string; refreshToken: string; expiresIn: 900; scope: 'mcp:access' }`。
- Produces: `DcrClientRegistrationInput = { clientName: string | null; applicationType?: 'native'; redirectUris: [string]; grantTypes: ['authorization_code', 'refresh_token']; responseTypes: ['code']; tokenEndpointAuthMethod: 'none' }`と`DcrClientRegistrationSchema`。schemaは1件の`redirect_uris`を必須にし、任意`scope`は`mcp:access`だけを許可してparse後には保持しない。任意`application_type`は`native`だけを許可し、指定値はparse結果と登録responseに返す。未指定のgrant/response/auth methodを許可値へ正規化し、unknown fieldは拒否する。登録responseには許可scope `mcp:access`を返す。
- Produces: `OAuthService`の公開signature `beginAuthorization(input: OAuthAuthorizationRequest): Promise<OAuthAuthorizationStart>`、`approveAuthorization(input: { transactionId: string; csrfToken: string; userId: string; approved: boolean }): Promise<OAuthAuthorizationApproval>`、`exchangeAuthorizationCode(input: { clientId: string; code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenResponse>`、`refreshAccessToken(input: { clientId: string; refreshToken: string; resource?: string | null }): Promise<OAuthTokenResponse>`、`verifyAccessToken(token: string): Promise<OAuthCredentialPrincipal>`、`registerPublicClient(input: DcrClientRegistrationInput): Promise<OAuthClient>`、`revokeToken(token: string): Promise<void>`、`listGrants(userId: string): Promise<OAuthGrantSummary[]>`、`revokeGrant(userId: string, grantId: string): Promise<boolean>`。
- Produces: `OAuthService.beginAuthorization`、`approveAuthorization`、`exchangeAuthorizationCode`、`refreshAccessToken`、`verifyAccessToken`、`registerPublicClient`、`revokeToken`、`listGrants`、`revokeGrant`。
- Produces: `oauthErrorResponse`、`oauthUnauthorizedResponse`、`oauthInsufficientScopeResponse`。

- [ ] **Step 1: OAuth lifecycleの失敗テストを書く**

```ts
test('PKCEを照合して一回だけaccess/refresh tokenを発行する', async () => {
  const started = await service.beginAuthorization(validAuthorizationRequest);
  const approval = await service.approveAuthorization({
    transactionId: started.transactionId, csrfToken: started.csrfToken, userId: 'user-1', approved: true,
  });
  const first = await service.exchangeAuthorizationCode({
    clientId: 'client-1', code: approval.code, redirectUri: callback, codeVerifier: verifier,
  });
  expect(first.accessToken).toMatch(/^ltm_oat_/);
  await expect(service.exchangeAuthorizationCode({
    clientId: 'client-1', code: approval.code, redirectUri: callback, codeVerifier: verifier,
  })).rejects.toMatchObject({ code: 'invalid_grant' });
});
```

PKCE不一致、scope不正、resource不一致、期限切れtransaction、拒否、refresh replay、grant revoke、rate limit超過もtestする。`DcrClientRegistrationSchema`に複数redirect URI、`client_credentials`、`token_endpoint_auth_method: 'client_secret_post'`、`response_types: ['token']`、未対応scope、`application_type: 'web'`、port 0/localhost callbackを渡した場合に`invalid_client_metadata`となり、Codexの`application_type: 'native'`、`scope: 'mcp:access'`、動的port付きIPv4 loopback callbackを受理し、指定されたnative metadataをregistration responseへ返すこと、欠けた許可metadataは規定値へ正規化することもtestする。rate limitはDCR global/IP、authorize IP、token client/IP、revoke IPごとの固定window境界、同時transaction、期限切れcounter、429 `Retry-After`を検証する。refresh requestで`resource`を送らない場合はgrant時のresourceを継承し、異なるresourceを送った場合は`invalid_target`を返すこともtestする。`verifyAccessToken`は期限・失効・resource・scopeを検証し、成功時だけOAuth principalを返す。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run tests/lib/oauth/service.test.ts tests/lib/oauth/identity.test.ts tests/lib/oauth/http.test.ts`

Expected: FAIL。OAuth service/identity/http moduleが存在しない。

- [ ] **Step 3: Firebase identity providerとtransaction開始を実装する**

`FirebaseOAuthIdentityProvider`は`getFirebasePrincipal(request)`だけを呼び、`allowBearer: true`を渡さない。session cookieがない場合は`null`を返す。`beginAuthorization`はDCR client、redirect URI、`response_type=code`、`code_challenge_method=S256`、resource、scopeを検証して10分期限のtransactionとCSRF secretを返す。clientの`state`はtransactionに保存し、redirect時にそのまま返す。

- [ ] **Step 4: code/token/refresh/revokeを実装する**

```ts
export async function verifyAccessToken(token: string): Promise<OAuthCredentialPrincipal> {
  const record = await store.findAccessTokenByHash(hashOpaqueSecret(token));
  if (!record || record.revoked_at || Date.parse(record.expires_at) <= Date.now()) {
    throw new OAuthProtocolError('invalid_token', 'access token is invalid');
  }
  if (record.scope !== MCP_OAUTH_SCOPE || record.resource !== config.resource.href) {
    throw new OAuthProtocolError('insufficient_scope', 'mcp:access is required');
  }
  return { userId: record.user_id, credentialId: record.id, credentialKind: 'oauth' };
}
```

PKCE S256は`createHash('sha256').update(codeVerifier).digest('base64url')`と`constantTimeEqual`で照合する。token responseは`access_token`、`token_type: 'Bearer'`、`expires_in: 900`、`refresh_token`、`scope: 'mcp:access'`だけを返す。refresh requestの`resource`がない場合は元refresh recordのresourceを使い、存在して異なる場合は`invalid_target`にする。refreshでは新tokenを作り旧tokenを失効し、旧token再利用は同familyのgrant/tokenを失効する。`revokeToken`はaccess hashを先に失効し、見つからなければrefresh hashからfamilyを失効し、どちらも見つからなくても成功として終える。rate limitは`getOAuthRateLimitKey`のIP hashのみをadmission keyとして使い、任意headerをprincipalや権限に渡さない。OAuth errorには内部例外、token本文、hashを入れない。

- [ ] **Step 5: metadata/challenge helperを実装する**

```ts
export function oauthUnauthorizedResponse(metadataUrl: URL): Response {
  return new Response('authentication required', {
    status: 401,
    headers: {
      'cache-control': 'no-store',
      'www-authenticate': `Bearer resource_metadata="${metadataUrl.href}"`,
    },
  });
}
```

authorization-server metadataにはissuer、`authorization_endpoint`、token/register/revoke endpoint、`response_types_supported: ['code']`、`grant_types_supported: ['authorization_code', 'refresh_token']`、`code_challenge_methods_supported: ['S256']`、`token_endpoint_auth_methods_supported: ['none']`、`scopes_supported: ['mcp:access']`を含める。CIMD/issuer-bound callback capabilityは広告しない。

- [ ] **Step 6: focused testを成功させる**

Run: `pnpm exec vitest run tests/lib/oauth/service.test.ts tests/lib/oauth/identity.test.ts tests/lib/oauth/http.test.ts`

Expected: PASS。PKCE、single-use code、refresh replay family revoke、scope/resource、token redaction、rate limitが検証済みになる。

- [ ] **Step 7: commitする**

```bash
git add src/lib/oauth tests/lib/oauth
git commit -m "feat: add OAuth authorization service"
```

### Task 4: OAuth discovery、DCR、token、revoke、authorization endpointのApp Router実装

**Files:**

- Create: `src/app/.well-known/oauth-protected-resource/api/mcp/route.ts`
- Create: `src/app/.well-known/oauth-authorization-server/route.ts`
- Create: `src/app/oauth/authorize/route.ts`
- Create: `src/app/oauth/token/route.ts`
- Create: `src/app/oauth/register/route.ts`
- Create: `src/app/oauth/revoke/route.ts`
- Create: `src/components/OAuthAuthorizationPage.tsx`
- Test: `tests/app/oauth-metadata-routes.test.ts`
- Test: `tests/app/oauth-protocol-routes.test.ts`

**Interfaces:**

- Consumes: `OAuthService`、`OAuthIdentityProvider`、HTTP helpers（Task 3）。
- Produces: spec記載のOAuth HTTP endpoints。`/oauth/authorize`はpageを同居させず、Next.js 16のRoute Handler制約に従い、`react-dom/server`を直接importしないescaped server HTML helperを返す。
- Produces: `OAuthAuthorizationPage({ transactionId, csrfToken, clientName, scope }: Props): ReactElement`。

- [ ] **Step 1: metadata/DCR/token endpointの失敗テストを書く**

```ts
test('metadataはDCRとPKCE S256を広告しCIMDを広告しない', async () => {
  setProductionOAuthEnvironment();
  const response = await authorizationServerMetadata.GET();
  const body = await response.json();
  expect(body).toMatchObject({
    issuer: 'https://ltm.okakam.net',
    registration_endpoint: 'https://ltm.okakam.net/oauth/register',
    code_challenge_methods_supported: ['S256'],
  });
  expect(body).not.toHaveProperty('client_id_metadata_document_supported');
});
```

route testにはport有無両方の有効な`127.0.0.1` callback、port 0/localhost/IPv6 callback、`client_credentials` grant、implicit response type、client secret auth methodのDCR拒否、form-urlencoded token request、code交換、refresh、revoke、endpoint別429/`Retry-After`、同意POSTでFirebase sessionが消えた場合にcodeを発行せずsign-inへ戻ること、`cache-control: no-store`、OAuth標準errorを含める。test store/fake identityはTask 2/3のinjection APIで設定する。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run tests/app/oauth-metadata-routes.test.ts tests/app/oauth-protocol-routes.test.ts`

Expected: FAIL。route moduleが存在しない。

- [ ] **Step 3: discovery、DCR、token、revoke routeを実装する**

protected-resource metadataの`resource`は`https://ltm.okakam.net/api/mcp`、`authorization_servers`はissuer配列、`scopes_supported`は`['mcp:access']`、`resource_name`は`long-term-memory`とする。disabled時は404、enabled設定不正時は500を返す。

`/oauth/register`はJSONだけ、`/oauth/token`と`/oauth/revoke`は`application/x-www-form-urlencoded`だけを受け付ける。`/oauth/register`は`DcrClientRegistrationSchema`で`redirect_uris`、grant/response/auth method、任意scope、任意`application_type`を正規化・検証する。scope指定は`mcp:access`だけ、application type指定は`native`だけを許可し、unsupported valueは`invalid_client_metadata`にする。registration responseは許可scope `mcp:access`を返し、requestに`application_type: 'native'`があれば同値を返す。content type/method違反はOAuth `invalid_request`または405を返す。各endpointの最初にTask 1のrate limit policyを評価し、超過時は`Retry-After`付き429/`temporarily_unavailable`を返す。`/oauth/revoke`はaccess tokenなら当該tokenだけ、refresh tokenなら同familyを失効する`OAuthService.revokeToken`を呼び、unknown tokenにも204を返してtoken存在を開示しない。

- [ ] **Step 4: authorize routeと同意HTMLを実装する**

未ログイン時の`/sign-in?oauth_transaction=<id>` redirectは設定済みの公開issuer (`MCP_PUBLIC_URL`) をoriginとし、受信`Request.url`からredirectを組み立てない。

`GET /oauth/authorize`はOAuth parameterでtransactionを開始する。Firebase sessionがなければserver保存transaction IDだけを`ltm_oauth_tx` HttpOnly/Secure/SameSite=Lax cookieへ入れ、`/sign-in?oauth_transaction=<id>`へ302する。sessionがあればtransactionを照合し、同意ページを返す。

`POST /oauth/authorize`はcookie、form transaction ID、CSRF secret、approve/denyを照合した後、`OAuthIdentityProvider.getPrincipal(request)`でFirebase sessionを再確認して得た`userId`だけを`approveAuthorization`へ渡す。sessionが消えていた場合はtransactionをconsumeせず、同じtransaction cookieのまま`/sign-in?oauth_transaction=<id>`へ302する。承認時はcode/stateを、拒否時は`error=access_denied`とstateを、検証済みredirect URIへ302で返す。検証前のerrorは400で返し、未検証URIへredirectしない。HTMLへFirebase ID token、OAuth token、authorization codeを表示しない。

- [ ] **Step 5: focused testを成功させる**

Run: `pnpm exec vitest run tests/app/oauth-metadata-routes.test.ts tests/app/oauth-protocol-routes.test.ts`

Expected: PASS。Codexが必要とするmetadata/DCR/PKCE/token/revokeとbrowser authorizationの契約が検証済みになる。

- [ ] **Step 6: commitする**

```bash
git add src/app/.well-known src/app/oauth src/components/OAuthAuthorizationPage.tsx tests/app/oauth-metadata-routes.test.ts tests/app/oauth-protocol-routes.test.ts
git commit -m "feat: expose OAuth endpoints for MCP"
```

### Task 5: FirebaseログインからOAuth認可画面への安全な復帰

**Files:**

- Modify: `src/app/sign-in/[[...sign-in]]/page.tsx`
- Modify: `src/app/sign-up/[[...sign-up]]/page.tsx`
- Modify: `src/components/FirebaseAuthForm.tsx`
- Test: `tests/app/oauth-login-continuation.test.ts`
- Test: `tests/components/firebase-auth-form.test.ts`

**Interfaces:**

- Consumes: `oauth_transaction` query、`/oauth/authorize?oauth_transaction=<id>`（Task 4）。
- Produces: `FirebaseAuthForm({ mode, continuation }: { mode: 'sign-in' | 'sign-up'; continuation?: string | null })`。
- Produces: sign-in/sign-up pageが256 bit `ltm_oatx_`形式の`oauth_transaction`だけを受け入れ、相対OAuth continuation以外をclientへ渡さない。

- [ ] **Step 1: login復帰の失敗テストを書く**

```ts
test('sign-in pageは有効なOAuth transactionだけを安全な相対URLへ変換する', async () => {
  const markup = renderToStaticMarkup(await SignInPage({
    searchParams: Promise.resolve({ oauth_transaction: 'ltm_oatx_0123456789abcdef0123456789abcdef01234567890' }),
  }));
  expect(markup).toContain('oauth_transaction=ltm_oatx_0123456789abcdef0123456789abcdef01234567890');
  expect(markup).not.toContain('https://evil.example');
});
```

component testでは`establishSession`成功後に`router.push('/oauth/authorize?oauth_transaction=...')`を呼ぶこと、transactionなしでは`'/'`へ進むこと、sign-in/sign-up間のリンクがtransactionを保持することを確認する。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run tests/app/oauth-login-continuation.test.ts tests/components/firebase-auth-form.test.ts`

Expected: FAIL。page propsと`FirebaseAuthForm`のcontinuation contractが未実装である。

- [ ] **Step 3: server pageで安全なcontinuationを組み立てる**

`searchParams`から`oauth_transaction`だけを読み、`z.string().regex(/^ltm_oatx_[A-Za-z0-9_-]{43}$/)`で256 bit transaction IDとして検証する。成功時だけ`/oauth/authorize?oauth_transaction=${encodeURIComponent(id)}`を作る。`next`、`return_to`、外部URL、任意pathは受け入れない。sign-up pageも同じ規則を使う。

- [ ] **Step 4: client formの遷移を実装する**

```ts
async function complete(credential: Awaited<ReturnType<typeof signInWithPassword>>) {
  await establishSession(credential);
  router.push(continuation ?? '/');
  router.refresh();
}
```

`FirebaseAuthForm`にoptional `continuation` propを追加する。sign-in画面にはtransactionを保持したsign-up link、sign-up画面にはtransactionを保持したsign-in linkを表示する。tokenやOAuth parameter全体をclient stateへ保存しない。

- [ ] **Step 5: focused testを成功させる**

Run: `pnpm exec vitest run tests/app/oauth-login-continuation.test.ts tests/components/firebase-auth-form.test.ts tests/lib/auth/firebase-client.test.ts`

Expected: PASS。通常ログインとOAuthログイン復帰の両方が維持される。

- [ ] **Step 6: commitする**

```bash
git add src/app/sign-in src/app/sign-up src/components/FirebaseAuthForm.tsx tests/app/oauth-login-continuation.test.ts tests/components/firebase-auth-form.test.ts
git commit -m "feat: resume OAuth authorization after Firebase login"
```

### Task 6: MCP transportへのOAuth principal統合とPAT互換

**Files:**

- Create: `src/lib/mcp/principal.ts`
- Modify: `src/lib/mcp/context.ts`
- Modify: `src/lib/mcp/transport.ts`
- Modify: `src/app/api/mcp/route.ts`
- Test: `tests/lib/mcp/oauth-auth-required.test.ts`
- Modify: `tests/lib/mcp/auth-required.test.ts`
- Modify: `tests/lib/mcp/stateless.test.ts`

**Interfaces:**

- Consumes: `OAuthService.verifyAccessToken(token)`と`oauthUnauthorizedResponse`（Task 3）、既存PAT検証。
- Produces: `type McpPrincipal = { userId: string; credentialId: string; credentialKind: 'oauth' | 'pat' }` と `requireMcpPrincipal(req: Request): Promise<McpPrincipal>`。
- Produces: `ToolContext.principal?: { userId: string; credentialId?: string; credentialKind?: 'oauth' | 'pat' }`。

- [ ] **Step 1: OAuth MCP認証の失敗テストを書く**

```ts
test('OAuth Bearerはmembershipを再評価し、credentialなしはresource metadata付き401になる', async () => {
  process.env.AUTH_REQUIRED = '1';
  process.env.MCP_OAUTH_ENABLED = '1';
  const missing = await request();
  expect(missing.status).toBe(401);
  expect(missing.headers.get('www-authenticate')).toContain('oauth-protected-resource/api/mcp');

  const denied = await request({ authorization: 'Bearer ' + outsiderAccessToken });
  expect(denied.status).toBe(403);
});
```

OAuth ownerの`reindex`成功、OAuth memberの`reindex`拒否、OAuthの`__shared__` write拒否、PAT owner/curatorの既存成功、失効OAuth tokenの401、Firebase ID token形式の401も追加する。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run tests/lib/mcp/oauth-auth-required.test.ts tests/lib/mcp/auth-required.test.ts`

Expected: FAIL。OAuth principal resolverと`WWW-Authenticate` headerがない。

- [ ] **Step 3: 共通principal resolverを実装する**

```ts
export async function requireMcpPrincipal(req: Request): Promise<McpPrincipal> {
  const token = bearerToken(req);
  if (token.startsWith('ltm_oat_')) return oauthPrincipal(await verifyAccessToken(token));
  if (token.startsWith('ltm_')) return patPrincipal(await requirePatPrincipal(req));
  throw new UnauthorizedMcpError();
}
```

既存PAT exportを壊さず、必要なら`src/lib/auth/pat.ts`から`requirePatPrincipal`をexportして互換wrapperを残す。未知prefix、Firebase ID token、Basic schemeは401にする。

- [ ] **Step 4: transportとCORSを更新する**

`handleMcpRequest`は`MCP_OAUTH_ENABLED=1`かつ認証エラー時にOAuth metadata付き401を返す。OAuth scope不足だけは403/`insufficient_scope`を返す。shared write判定は`principal.credentialKind === 'pat'`、`principal.userId === LTM_CURATOR_USER_ID`、`grantsSharedWrite(maintenanceToken)`の三条件すべてを要求し、OAuth credentialではcurator UIDとmaintenance tokenを持っていても403にする。その後に`assertProjectAccess`、tool contextを評価する。`canWriteShared`にも同じ`credentialKind === 'pat'`条件を入れる。stateless session keyは`credentialId`を含め、別OAuth credentialのcontextを共有しない。

`OPTIONS /api/mcp`は既存`Authorization`を維持し、OAuth専用の秘密headerを追加しない。GET/DELETEの405契約も変えない。

- [ ] **Step 5: focused testを成功させる**

Run: `pnpm exec vitest run tests/lib/mcp/oauth-auth-required.test.ts tests/lib/mcp/auth-required.test.ts tests/lib/mcp/stateless.test.ts tests/lib/auth/pat.test.ts`

Expected: PASS。OAuth追加後もPAT、session isolation、shared write、stateless transportが回帰しない。

- [ ] **Step 6: commitする**

```bash
git add src/lib/mcp src/lib/auth/pat.ts src/app/api/mcp/route.ts tests/lib/mcp tests/lib/auth/pat.test.ts
git commit -m "feat: accept OAuth credentials for MCP requests"
```

### Task 7: OAuth grant管理APIとSettings UI

**Files:**

- Create: `src/app/api/auth/oauth-grants/route.ts`
- Create: `src/components/OAuthGrantSettings.tsx`
- Modify: `src/app/settings/tokens/page.tsx`
- Modify: `tests/app/auth.routes.test.ts`
- Modify: `tests/app/token-settings-page.test.ts`
- Create: `tests/components/oauth-grant-settings.test.ts`

**Interfaces:**

- Consumes: `OAuthService.listGrants(userId)` and `OAuthService.revokeGrant(userId, grantId)`（Task 3）、`requireWebPrincipal`、`assertSameOrigin`。
- Produces: `GET /api/auth/oauth-grants: OAuthGrantSummary[]` and `DELETE /api/auth/oauth-grants?grant_id=<uuid>: 204`。
- Produces: `OAuthGrantSettings({ initialGrants }: { initialGrants: OAuthGrantSummary[] })`。

- [ ] **Step 1: OAuth grant API/UIの失敗テストを書く**

```ts
test('OAuth grant一覧は本人の接続だけを返し、同一originのDELETEだけを受け付ける', async () => {
  mocks.requireWebPrincipal.mockResolvedValue({ userId: 'user-1' });
  const listed = await GET();
  expect(await listed.json()).toEqual([expect.objectContaining({ id: 'grant-1', client_name: 'Codex' })]);
  const foreignOrigin = await DELETE(new Request('https://example.test/api/auth/oauth-grants?grant_id=grant-1', {
    method: 'DELETE', headers: { origin: 'https://evil.example', host: 'example.test' },
  }));
  expect(foreignOrigin.status).toBe(403);
});
```

component testではclient名、scope、作成/最終利用日時、失効ボタン、失効後に一覧から消えることを確認する。token本文、hash、refresh family IDをmarkupに出さない。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run tests/app/auth.routes.test.ts tests/app/token-settings-page.test.ts tests/components/oauth-grant-settings.test.ts`

Expected: FAIL。OAuth grants APIとcomponentが存在しない。

- [ ] **Step 3: APIとSettings UIを実装する**

GETは`requireWebPrincipal(req)`で利用者を解決し、その`userId`のgrantだけを返す。DELETEは`assertSameOrigin`、principal、UUID validation、`revokeGrant`の順で実行し、存在しない/他人のgrantも204を返す。

`TokenSettingsPage`はPAT一覧とOAuth grant一覧を並行取得して`PatTokenSettings`を維持しつつ`OAuthGrantSettings`を追加する。見出しは`Codex / OAuth 接続`、失効説明は「この接続のaccess tokenとrefresh tokenを無効化します」とする。OAuth access tokenを発行・表示するUIは作らない。

- [ ] **Step 4: focused testを成功させる**

Run: `pnpm exec vitest run tests/app/auth.routes.test.ts tests/app/token-settings-page.test.ts tests/components/oauth-grant-settings.test.ts`

Expected: PASS。PAT発行UIの既存回帰とOAuth grant revokeが両立する。

- [ ] **Step 5: commitする**

```bash
git add src/app/api/auth/oauth-grants src/app/settings/tokens/page.tsx src/components/OAuthGrantSettings.tsx tests/app tests/components
git commit -m "feat: manage OAuth grants in settings"
```

### Task 8: feature flag、Cloud Run deployment、運用ドキュメント、Codex導入手順

**Files:**

- Modify: `.env.example`
- Modify: `.github/workflows/cloud-run.yml`
- Modify: `docs/reproduction-spec.md`
- Modify: `docs/post-mcp-setup.md`
- Modify: `docs/google-cloud-cli-setup.md`
- Modify: `docs/cloud-run-production-deployment.md`
- Modify: `AGENTS.md`
- Modify: `tests/docs/post-mcp-setup.test.ts`
- Create: `tests/deploy/mcp-oauth-deployment.test.ts`

**Interfaces:**

- Consumes: `MCP_OAUTH_ENABLED`、`MCP_PUBLIC_URL`、既存PAT/maintenance tokenの運用契約。
- Produces: Cloud Run deploymentへの`MCP_OAUTH_ENABLED=${{ vars.MCP_OAUTH_ENABLED }}`注入。
- Produces: Codex利用者向けの`codex mcp login long-term-memory`手順と、curator/CI用PATを維持する手順。

- [ ] **Step 1: deploymentとドキュメントの失敗テストを書く**

```ts
test('Cloud Run deployはOAuth feature flagをEnvironment variableから注入する', async () => {
  const workflow = await readFile('.github/workflows/cloud-run.yml', 'utf8');
  expect(workflow).toContain('MCP_OAUTH_ENABLED=${{ vars.MCP_OAUTH_ENABLED }}');
});

test('Codex手順はBearer PATを残さずOAuth loginを案内し、curator PATは維持する', async () => {
  const setup = await readFile('docs/post-mcp-setup.md', 'utf8');
  expect(setup).toContain('codex mcp remove long-term-memory');
  expect(setup).toContain('codex mcp login long-term-memory');
  expect(setup).toContain('LTM_MAINTENANCE_TOKEN');
});
```

既存の`設置手順はClaude CodeとCodexの冪等配置と自己検証を定義する` testを更新し、一般Codex sectionに`--bearer-token-env-var LTM_MCP_TOKEN`がないことと、curator/Cloud Run sectionには同PAT設定が残ることを別々に検証する。OAuth login文言だけで既存PAT依存を一括削除したと見なさない。

- [ ] **Step 2: 失敗を確認する**

Run: `pnpm exec vitest run tests/docs/post-mcp-setup.test.ts tests/deploy/mcp-oauth-deployment.test.ts`

Expected: FAIL。OAuth feature flagとCodex OAuth導入手順がまだない。

- [ ] **Step 3: feature flagとworkflowの段階的rolloutを実装する**

`.env.example`に`MCP_OAUTH_ENABLED=0`を追加する。`.github/workflows/cloud-run.yml`のCloud Run `--set-env-vars`へ`MCP_OAUTH_ENABLED=${{ vars.MCP_OAUTH_ENABLED }}`を追加し、Production Environment variableとして管理する。OAuthのtoken signing key・client secret・Firebase service account JSONは追加しない。

`docs/cloud-run-production-deployment.md`には、初回コードdeployは`MCP_OAUTH_ENABLED=0`で既存PAT smokeを確認し、metadata/DCR/browser受入の直前に`1`へ変更する二段階rolloutを記載する。`AUTH_REQUIRED=1`、HTTPSの`MCP_PUBLIC_URL`、`MCP_ALLOWED_ORIGINS`、`CLOUD_RUN_URL`の整合を必須とし、OAuth障害時はflagを`0`に戻してPAT利用を継続するrollbackを明記する。

- [ ] **Step 4: 利用者・運用者向けドキュメントを更新する**

`docs/reproduction-spec.md`を、Firebase sessionによるbrowser本人確認、DCR/PKCE OAuth、hash保存のopaque credential、requestごとのmembership再評価、OAuth grant失効、PATの限定用途へ更新する。local既定でOAuthをoffとする理由も記録する。

`docs/post-mcp-setup.md`の一般Codex手順を次へ置き換える。既存の`--bearer-token-env-var LTM_MCP_TOKEN`設定を削除してからOAuth loginを実行する。`project_id`には利用者がアクセスを持つproject slugを入れる。

```bash
codex mcp remove long-term-memory
codex mcp add long-term-memory \
  --url "https://ltm.okakam.net/api/mcp?project_id=<project-slug>"
codex mcp login long-term-memory
```

同じ文書でClaude Code curator、CI、Cloud Run smokeには既存PAT/`LTM_MAINTENANCE_TOKEN`を使い続けることを明記し、OAuth access tokenを環境変数やリポジトリへ貼り付けないようにする。

`docs/google-cloud-cli-setup.md`にはFirebase Authorized domainsへOAuth browser hostを追加する確認（custom domain有効後は`ltm.okakam.net`、移行中は実際の`run.app` hostも対象）、Cloud Run/Firebase deployを別操作に保つこと、rate counter用TTLを有効化・確認する次の手順を記載する。

```bash
gcloud firestore fields ttls update expires_at \
  --collection-group=oauthRateLimits \
  --enable-ttl
gcloud firestore fields ttls list \
  --collection-group=oauthRateLimits
```

TTL削除の遅延を認可・rate windowの正本にしないことも明記する。`AGENTS.md`には、FirebaseをWeb IdP、Cloud RunのOAuth authorization serverをMCP credential発行者、PATをmachine/curator互換用とする現在の正本境界を追記する。

- [ ] **Step 5: focused testを成功させる**

Run: `pnpm exec vitest run tests/docs/post-mcp-setup.test.ts tests/deploy/mcp-oauth-deployment.test.ts`

Expected: PASS。workflow、Codex OAuth移行、PAT限定利用、rollout/rollback手順が同期する。

- [ ] **Step 6: commitする**

```bash
git add .env.example .github/workflows/cloud-run.yml AGENTS.md docs tests/docs/post-mcp-setup.test.ts tests/deploy/mcp-oauth-deployment.test.ts
git commit -m "docs: document Codex MCP OAuth rollout"
```

### Task 9: ローカル回帰、Production OAuth受入、記録とrollback確認

**Files:**

- Create: `docs/eval/cloud-run-smoke.json`

**Interfaces:**

- Consumes: OAuth unit/route/MCP tests、Cloud Run production workflow、実際のbrowserと`codex mcp` CLI。
- Produces: credentialを含まないPAT/OAuth smoke結果と、OAuthをoffへ戻せることの記録。

- [ ] **Step 1: OAuthとMCPのfocused regressionを実行する**

Run:

```bash
pnpm exec vitest run \
  tests/lib/oauth/config.test.ts \
  tests/lib/oauth/crypto.test.ts \
  tests/lib/oauth/redirect.test.ts \
  tests/lib/oauth/sqlite-store.test.ts \
  tests/lib/oauth/firestore-store.test.ts \
  tests/lib/oauth/service.test.ts \
  tests/lib/oauth/identity.test.ts \
  tests/lib/oauth/http.test.ts \
  tests/app/oauth-metadata-routes.test.ts \
  tests/app/oauth-protocol-routes.test.ts \
  tests/app/oauth-login-continuation.test.ts \
  tests/components/firebase-auth-form.test.ts \
  tests/lib/mcp/oauth-auth-required.test.ts \
  tests/lib/mcp/auth-required.test.ts \
  tests/lib/mcp/stateless.test.ts \
  tests/app/auth.routes.test.ts \
  tests/components/oauth-grant-settings.test.ts
```

Expected: PASS。OAuth codeのsingle use、refresh replay revoke、DCR/PKCE、Firebaseログイン復帰、MCP membership、PAT/curator互換、grant失効が通る。

- [ ] **Step 2: リポジトリの必須検証を実行する**

Run:

```bash
pnpm test
pnpm lint
pnpm exec tsc --noEmit
NODE_ENV=production pnpm build
git diff --check
docker compose -f .devcontainer/compose.yaml config --quiet
```

Expected: PASS。失敗時はOAuth以外の既存失敗と区別して記録し、失敗を隠すskipやtestの緩和は行わない。

- [ ] **Step 3: Git Flow release後にProductionへflag offの互換deployを行う**

Task 1–8のimplementation PRを`feature/mcp-oauth-codex-login → develop`でマージし、`develop → main` release PRをマージする。main commitのpush workflowまたはmain限定manual dispatchだけでdeployする。Production Environmentのwrite権限を持つdeploy実行者は`MCP_OAUTH_ENABLED=0`、`AUTH_REQUIRED=1`、`MCP_PUBLIC_URL=https://ltm.okakam.net`を確認してからdeployする。OAuthが無効な状態で既存PATを用い、initialize、tools/list、save、get、update、link、reindex、search、deleteのCloud Run smokeを実行する。curatorの`__shared__` writeも既存維持操作で確認する。token本文はshell history、log、`docs/eval`へ残さない。

- [ ] **Step 4: Production OAuthを有効化してbrowser/Codex受入を行う**

flag offのPAT smokeがすべて通った場合だけ、deploy実行者がProduction Environmentの`MCP_OAUTH_ENABLED`を`1`へ変更して再deployする。資格情報を出力しない形でmetadataを確認する。

```bash
curl --fail --silent --show-error \
  https://ltm.okakam.net/.well-known/oauth-protected-resource/api/mcp
curl --fail --silent --show-error \
  https://ltm.okakam.net/.well-known/oauth-authorization-server
```

新しいCodex設定でログインする。

```bash
codex mcp remove long-term-memory
codex mcp add long-term-memory \
  --url "https://ltm.okakam.net/api/mcp?project_id=<project-slug>"
codex mcp login long-term-memory
```

browserでは許可済み`@okakam.net` accountによるFirebase sign-in、同意、callback、Codex接続、MCP initialize/tools/list/read/write/reindexを確認する。対象外account、存在しないproject、memberのreindex、OAuth credentialでの`__shared__` write、失効済みgrantは拒否されることも確認する。最後にPAT curator/CI smokeをもう一度実行し、OAuth追加後もmachine経路が維持されることを確認する。

- [ ] **Step 5: 結果をcredentialなしで記録し、rollback判定を行う**

`docs/eval/cloud-run-smoke.json`へ日時、commit SHA、Cloud Run URL、`pat_smoke`、`oauth_metadata`、`oauth_codex_login`、`oauth_mcp_tools`、`negative_authorization`、`curator_pat_regression`、`rollback_exercised`を`passed`、`failed`、`not_run`のいずれかで記録する。token、email、cookie、authorization code、hash、project固有のprivate dataは含めない。

flag offのPAT smoke、OAuth metadata、Codex login、OAuth MCP toolsのいずれかが失敗した場合、deploy実行者が`MCP_OAUTH_ENABLED=0`に戻して再deployし、PAT smokeが通ることを確認してから原因を調査する。flag offのPAT smokeが失敗した場合はOAuth rolloutを続行しない。

- [ ] **Step 6: mainへ直接commitせず、実環境記録PRを作成する**

```bash
git switch develop
git pull --ff-only origin develop
git switch -c docs/mcp-oauth-production-smoke-<main-sha>
git add docs/eval/cloud-run-smoke.json
git commit -m "docs: record MCP OAuth production smoke"
git push -u origin docs/mcp-oauth-production-smoke-<main-sha>
gh pr create --base develop --head docs/mcp-oauth-production-smoke-<main-sha> \
  --title "docs: record MCP OAuth production smoke" \
  --body "Production main SHA: <main-sha>"
```

この記録PRはproduction済みmain commitの受入証跡を`develop`へ戻すもので、production codeを変更しない。実行者は実際のcredentialや個人情報が混入していないことを`git diff --check`と目視で確認してからcommitする。

---

## 要件対応表

| 設計要件 | 実装タスク | 検証 |
| --- | --- | --- |
| FirebaseをWeb IdPとして残し将来の置換境界を作る | 3, 5 | identity fake、ログイン復帰route/component test |
| DCR、OAuth metadata、PKCE S256、authorization code | 1, 3, 4 | config/redirect/service/protocol test、Production metadata |
| opaque token hash、TTL、refresh rotation/replay revoke | 1, 2, 3 | SQLite/Firestore contract、service test |
| DCR metadata制限、O(1) credential lookup、Firestore-backed rate limit | 1, 2, 3, 4, 8 | DCR/Firestore call log/rate-limit route test、TTL設定確認 |
| MCPのOAuth/PAT両対応、membership再評価、shared curator gate | 6 | MCP auth/stateless/PAT regression、Production smoke |
| 本人によるgrant表示・失効 | 2, 3, 7 | auth route/component test、失効後のbrowser受入 |
| flagによる安全な段階rolloutとPAT rollback | 8, 9 | workflow/doc test、flag off/onのCloud Run smoke |
| Codexのtoken手入力なしログイン | 4, 8, 9 | metadata/DCR test、`codex mcp login` browser受入 |

## Plan Self-Review

- [ ] `rg -n -i 'T(BD|O[D]O)|F[I]XME|implement[[:space:]]later|fill[[:space:]]in[[:space:]]details' docs/superpowers/plans/2026-09-21-mcp-oauth-codex-login.md` が出力なしであることを確認する。
- [ ] Task 1–8が対象ファイル、公開interface、失敗テスト、実装手順、focused test、commit単位を持ち、Task 9がGit Flowに矛盾しない実環境受入・rollback・記録PR手順を持つことを確認する。
- [ ] 設計書のDCRのみ、PKCE、Firebase境界、opaque hash、grant revoke、PAT互換、flag rollout、Codex受入の全項目が要件対応表で追跡できることを確認する。
