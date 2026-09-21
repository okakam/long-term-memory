# Firebase認証メールドメイン制限設計

## 状態

実装前の設計。許可ドメインは `okakam.net` のみとする。

## 1. 目的と範囲

long-term-memoryのFirebase Authenticationについて、次の認証操作を `@okakam.net` のメールアドレスだけに限定する。

- Email/Passwordの新規登録
- Email/Passwordのログイン
- Googleログイン
- 既存ユーザーの再ログイン

ローカル開発の `AUTH_REQUIRED=0` は対象外とし、Cloud Run本番の `AUTH_REQUIRED=1` にだけ適用する。MCP PATは別の認証経路であるため、既存PATを自動失効させる仕様は含めない。既存PATの失効は別途の運用手順で行う。

## 2. 採用方式

Firebase AuthenticationのBlocking Functionsと、Cloud Runのサーバー側セッション検証を併用する。

### Firebase Authentication側

Firebase Authentication with Identity Platformの次のトリガーで、認証操作そのものを拒否する。

- `beforeUserCreated`: 許可外ドメインの新規ユーザー作成を拒否する。
- `beforeUserSignedIn`: 許可外ドメインのログインを拒否する。既存ユーザーにも適用する。

判定はメールアドレスを小文字化し、`@`の直後から末尾までが完全に `okakam.net` と一致することを確認する。`user@sub.okakam.net`、`user@okakam.net.example`、メールアドレスなしは拒否する。

Google OAuthの `hd` パラメータはアカウント選択画面の補助ヒントとしてだけ設定し、認可判定には使わない。クライアントから変更できるため、サーバー側Blocking Functionの判定を正本とする。

### Cloud Run側

`src/lib/auth/firebase.ts` のFirebase principal生成時に同じ完全一致判定を行う。これにより、Blocking Functionを未設定の期間、古いsession cookie、直接Bearer ID tokenによるAPI呼び出しがアプリ認証を迂回しないようにする。

`POST /api/auth/session` は許可外ドメインに対して403を返し、session cookieを発行しない。既に発行済みの許可外ドメインのsession cookieも、各リクエストのprincipal検証で拒否する。

## 3. データフロー

```text
Firebase Web SDK
  -> Firebase Auth (beforeUserCreated / beforeUserSignedIn)
  -> ID token
  -> Cloud Run /api/auth/session
  -> Firebase Admin verify ID token + exact domain check
  -> HttpOnly session cookie
  -> Cloud Run web/API principal checks
```

Firebase側とCloud Run側のどちらかが許可外と判定した場合、アプリのログイン状態を成立させない。クライアントは認証エラーを表示し、Firebase client側のユーザー状態もsign outする。

## 4. 変更対象

- `src/lib/auth/email-domain.ts`: `okakam.net`の正規化・完全一致判定を集中管理する。
- `src/lib/auth/firebase.ts`: ID token/session cookieからprincipalを作る際にドメイン判定を適用する。
- `src/app/api/auth/session/route.ts`: 許可外ドメインを403として返し、cookieを発行しない。
- `src/lib/auth/firebase-client.ts`: Google providerへ `hd=okakam.net` を渡し、session交換失敗時にFirebase clientをsign outする。
- `src/components/FirebaseAuthForm.tsx`: ドメイン制限エラーをユーザーへ表示する。
- `functions/`: Firebase Auth Blocking Functionsの実装とデプロイ設定を追加する。
- `firebase.json`: Functions sourceとpredeploy設定を追加する。
- `.env.example`: ローカル・本番のドメイン方針を説明する非秘密設定を追加する場合は実値を含めない。
- `docs/google-cloud-cli-setup.md`: Identity Platform、Functions API、Functions deploy手順を追加する。
- `docs/cloud-run-production-deployment.md`: `okakam.net`制限と再デプロイ受入確認を追加する。
- `tests/lib/auth/email-domain.test.ts`: ドメイン判定の境界値を検証する。
- `tests/lib/auth/firebase.test.ts`: 許可外principalが拒否されることを検証する。
- `tests/app/auth.firebase-routes.test.ts`: session cookieが許可外メールへ発行されないことを検証する。

## 5. エラー処理と互換性

- 許可外メールのsession交換はHTTP 403 `email domain is not allowed`とする。
- ID token検証失敗やsession cookie検証失敗は従来どおり認証エラーとして扱う。
- ローカル `AUTH_REQUIRED=0` の挙動は変更しない。
- Firebase Blocking Functions未デプロイでも、Cloud Run側の検証で本番アプリへのセッション発行とAPIアクセスを拒否する。
- 既存の許可外Firebaseユーザーの削除・無効化は自動で行わない。`beforeUserSignedIn`により再ログインは拒否する。

## 6. 外部設定と受入条件

実装後、Firebase Console / Google Cloud側で次を行う。

1. Firebase Authentication with Identity Platformを有効化する。
2. `cloudfunctions.googleapis.com`、`eventarc.googleapis.com`、`eventarcpublishing.googleapis.com`を有効化する。Functionsのデプロイに必要な `cloudbuild.googleapis.com`、`artifactregistry.googleapis.com`、`pubsub.googleapis.com`、`run.googleapis.com`も有効化する（既に有効なAPIは再実行可能な確認として扱う）。
3. Functionsをデプロイし、`beforeUserCreated`と`beforeUserSignedIn`をAuthenticationのBlocking triggersへ登録する。
4. Email/PasswordとGoogleについて、`okakam.net`のアカウントが新規登録・ログインできることを確認する。
5. 許可外ドメインのEmail/Password・Googleアカウントが新規登録・ログインとも拒否されることを確認する。
6. 既存の許可外ドメインユーザーが再ログインできないことを確認する。
7. Cloud Runへ再デプロイし、既存のCloud Run smokeが成功することを確認する。

Blocking Functionsの設定値・認証情報はrepositoryへ保存しない。Cloud RunのInvoker公開、GCS、Firestore、MCP PATの構成は変更しない。
