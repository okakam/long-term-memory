# プロジェクト管理とWeb UI刷新 設計書

## 目的

Firebaseでログイン済みの利用者がDashboardからプロジェクトを作成し、ownerとしてmemberを管理できるようにする。同時に、ログイン、OAuth同意、Dashboardを、認証情報を漏らさず小さい画面でも操作できる一貫したUIへ刷新する。これにより、`codex mcp login long-term-memory`で得たOAuth credentialが、利用者自身が管理するproject membershipで実際にMCPへ接続できる状態を作る。

## 前提と決定

- Firebase Authenticationは本人確認、Firestoreの`projects/<slug>/members/<uid>`はMCP/Web双方の認可正本という既存境界を維持する。OAuthの同意はmembershipを作成・変更しない。
- プロジェクト作成者は自動的に`owner`になる。ownerだけがmemberの追加、role変更、削除を行える。`member`は通常のread/writeを行えるが、member管理と`reindex`はできない。
- Dashboardからのmember追加は、既に`@okakam.net`で登録済みの利用者のメールアドレスを入力して行う。サーバーはFirebase Admin SDKでメールアドレスをUIDへ解決してから既存membershipを保存する。UIDを画面で入力・共有させない。
- 既存の`user_id`を指定するmember APIは後方互換として残す。Web UIはemail入力のみを使う。member一覧には、解決できたメールアドレスとUID（補助情報）を表示する。Firebaseからユーザーを解決できない既存recordはUIDだけを表示する。
- project slugは既存の`assertMemoryName`契約を使う。`__shared__`は作成・member管理の対象外で、read-onlyのままとする。
- 外部のCSS、フォント、画像、UIライブラリは追加しない。Next.js/Reactと既存CSSだけで、pearl系の明るい背景、charcoalの文字色、indigoを主要アクセントにした静かな管理画面を作る。装飾的なキャッチフレーズ、利用者名の歓迎文、架空の機能、過度なanalyticsは表示しない。`prefers-reduced-motion`、キーボードfocus、コントラストを扱う。
- UIの表示ブランドは`Long term memory`に統一する。MCP server name、Codex設定名、project slugとして使う`long-term-memory`は変更しない。

## 画面と操作フロー

### Dashboard

Dashboardは「利用状況」と「アクセス管理」を一つの画面で扱う。上部に控えめなブランド、現在の期間、project filter、project作成ボタンを置く。選択projectとmember管理を第一に表示し、利用状況はKPI、日次推移、tool/project/errorの各compact panelへ整理する。既存の7/30/90日フィルタとtelemetry集計条件は変えない。

アクセス管理はDashboard内の`プロジェクト管理`カードで行う。

1. 利用者が`新しいプロジェクト`を選び、slugを入力して作成する。成功時にownerとして一覧へ追加し、そのprojectを選択する。
2. ownerが選択projectの`メンバーを管理`を開く。登録済み`@okakam.net`メールアドレスと`member`/`owner` roleを指定して追加する。
3. ownerはroleを変更でき、他者を削除できる。最後のownerを消す、または自分自身のowner roleを下げる操作はUIでは禁止する。APIは既存のrole保存契約を保ち、最後のowner保護はこの変更で追加する。
4. 空の状態では「projectを作成するとCodex OAuth MCPの接続先にできる」ことと、`codex mcp add` URLの`project_id`がslugであることだけを説明する。token、OAuth code、callback URLは表示しない。

### ログイン／サインアップ

画面全体を中央寄せの認証shellにし、サービスの説明、メール／パスワードform、Google login、OAuthから戻る際の短い説明を表示する。既存の`oauth_transaction`だけを保った安全なcontinuation、Firebase session確立後の遷移、`@okakam.net`制限、エラー表示の契約は変更しない。

### OAuth同意

`/oauth/authorize`はNext.js layoutではなく、CSPを個別に返すHTMLである。この制約を維持しながら、インラインCSSで同じ認証shellを描画する。画面にはclient名、MCP server名、scope、project accessがリクエストごとに再確認されること、許可／拒否を明示する。hidden field名、form action、POST内容、CSRF cookie、動的loopback originだけを許可する`form-action` CSPは変更しない。

## APIとデータ契約

### Firebase directory adapter

`FirebaseAdminAuth`にメールアドレスからUIDを探す機能を追加する。公開するadapter関数は、許可ドメインを正規化・検証してからFirebase Admin SDKを呼び、利用者が存在しない場合は`400 member account was not found`を返す。Firebase SDK固有のエラー本文やemailはログへ出さない。

### Membership API

既存routeを拡張するが、Firebase sessionとsame-origin、owner判定は必須のままとする。

| Route | Input | Output | 追加ルール |
| --- | --- | --- | --- |
| `GET /api/projects` | なし | accessible projects | 各projectのroleを返す。 |
| `POST /api/projects` | `{ slug }` | `{ project_id, owner_user_id }` | creatorをownerにする。 |
| `GET /api/projects/:id/members` | なし | `{ user_id, email, role }[]` | ownerだけ。`email`は解決できない場合`null`。 |
| `POST /api/projects/:id/members` | `{ email, role? }` または既存`{ user_id, role? }` | `{ project_id, user_id, email, role }` | email入力は登録済みの許可ドメインに限定。 |
| `PATCH /api/projects/:id/members` | `{ user_id, role }` | 更新済みmember | 最後のownerをmemberへ変更できない。 |
| `DELETE /api/projects/:id/members?user_id=...` | なし | `204` | 最後のownerと自分自身のowner削除を拒否する。 |

メールはFirestore membershipへ複製しない。認可は常にUIDのみで行い、directory解決が不能でも既存membershipの認可に影響しない。

## コンポーネント境界

- `src/lib/auth/firebase.ts`: Firebase principal検証とdirectory lookupの薄いadapter。
- `src/app/api/projects/[id]/members/route.ts`: owner authorization、入力検証、最後のowner制約、directory adapterの呼び出し。
- `src/components/project-management/*`: project作成、member一覧、member追加、role変更、削除を担当するclient components。API fetchとpending/error状態をここに閉じる。
- `src/app/dashboard/page.tsx`: server側で利用可能projectとtelemetryを取得し、表示用データをDashboard UIへ渡す。
- `src/components/dashboard/*`: telemetry表示とaccess-managementを組み立てるclient/server境界。計算ロジックは既存`lib/telemetry`に残す。
- `src/components/FirebaseAuthForm.tsx`と`OAuthAuthorizationPage.tsx`: 既存の認証・OAuth protocol contractを保ったpresentational refresh。
- `src/app/globals.css`: color token、layout、form、table、responsive、motion reductionを集約する。

## エラー処理と安全性

- project/member APIは401、403、400、409を現行のplain-text契約で返す。UIはmessageを利用者向けに表示し、メールアドレス・UID・OAuth tokenをconsoleへ出さない。
- project作成のslug競合は409としてformに表示する。member追加で同じUIDが既に登録済みの場合はidempotently同一roleを返し、異なるroleはownerがPATCHで明示変更する。
- Firebase directory lookup失敗、未登録email、許可外ドメインはmemberを作らない。存在確認の可否が外部に漏れないよう、ownerにだけ一律の「登録済みの許可アカウントを指定してください」と表示する。
- OAuth consentのinline CSSは`style-src 'unsafe-inline'`という既存CSPに依存する。script、外部resource、redirect URI、form actionを増やさない。

## テストと受入条件

- Firebase directory lookupをfake化し、許可emailのUID解決、許可外email、未登録emailをunit testする。
- route integrationでcreator owner化、ownerのemail追加、memberによる変更拒否、role変更、最後のowner保護、`__shared__`拒否を確認する。
- React rendering testでDashboardにproject管理、空状態、roleに応じた操作制御、auth formのOAuth continuationを描画することを確認する。
- OAuth page rendering testで新しい表示要素を確認しつつ、hidden fields、form action、許可/拒否button、HTML escapeを回帰させる。CSP testはloopback originだけを`form-action`へ入れる既存ケースを維持する。
- `pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build`、`git diff --check`を通す。
- main deploy後は、ownerがDashboardで`long-term-memory`を作成し、`codex mcp add ...?project_id=long-term-memory`、`codex mcp login long-term-memory`、`/mcp verbose`で16 toolsが公開されることを手動確認する。これはローカルCIとは別の本番受入ゲートである。

## 非目標

- メール招待、未登録者への通知、組織／グループ、複数workspace、Firestore Consoleの直接編集UIは実装しない。
- OAuth protocol、scope、DCR、PKCE、token format、PATの利用目的、MCP tool contractは変更しない。
- 既存のmemory詳細、検索、graphを個別に全面再デザインしない。共通headerとglobal tokenの影響範囲だけを整える。
