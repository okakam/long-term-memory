# Cloud Run本番デプロイ環境

## 目的

PRを`main`へマージした直後にCloud Runへ自動デプロイする。常設のstaging環境は作らず、Cloud Runはscale to zeroで運用する。

GCPプロジェクト、GCS、Firestore、Firebase Authentication、IAM、Workload Identity Federation、Secret Managerの作成は [Google Cloud CLI / Firebase 初期設定手順](google-cloud-cli-setup.md) の `gcloud` / Firebase CLI手順を実行する。GitHub Environmentの値はこの文書の表と同手順の対応表を一致させる。

## デプロイ経路

```text
PR作成・PRブランチpush
  -> verify（test / lint / production build / Docker build / container health）
  -> mainへマージ
  -> mainへのpush
  -> verify
  -> GitHub Environment: production
  -> Workload Identity Federation
  -> gcloud run deploy
  -> Cloud Run smoke
```

`.github/workflows/cloud-run.yml` は次のイベントを処理する。

- `pull_request` の `opened`、`synchronize`、`reopened`、`ready_for_review`：verifyだけを実行
- `push` の `refs/heads/main`：verify成功後に自動deploy
- `workflow_dispatch` の `refs/heads/main`：手動再deploy

PRイベントとPRブランチへのpushではProduction secretsを使用せず、deploy jobも起動しない。Production deployは`cloud-run-production` concurrency groupで直列化し、古いdeployをキャンセルしない。

Firebase AuthenticationのBlocking FunctionsはCloud Run deployとは別管理です。Functionsのコードを変更した場合は、Identity Platformへ接続した認証済み開発コンテナから次を実行し、Firebase ConsoleのAuthentication → Settings → Blocking functionsで`beforeUserCreated`と`beforeUserSignedIn`の登録を確認します。

```bash
pnpm --dir functions --ignore-workspace install --frozen-lockfile --ignore-scripts
firebase deploy --project="$LTM_PROJECT_ID" --only functions
```

この操作はGitHub ActionsのCloud Run deploy jobから自動実行しません。Firebase CLI認証とIdentity PlatformのBlocking functions設定を、Cloud RunのWIFデプロイ権限から分離します。

## GitHub Environment `production`

GitHub repositoryの Settings → Environments → New environment で `production` を作成する。

Deployment branches and tagsはmainだけを許可する。PRマージ後の自動デプロイを止めないため、Required reviewersは設定しない。承認付き運用へ変更する場合は、Production deploy前にRequired reviewerを追加する。

### Environment secrets

次の値をEnvironment secretsへ登録する。値はrepositoryへ保存しない。

| Secret | 用途 |
|---|---|
| `GCP_PROJECT_ID` | GCP project ID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | GitHub OIDC用WIF provider resource name |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | Cloud Run deploy用サービスアカウント |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | Cloud Run実行用サービスアカウント |
| `CLOUD_RUN_URL` | deploy後smokeのCloud Run URL |
| `LTM_MCP_TOKEN` | `/settings/tokens`で発行したsmoke専用MCP PAT |

### Environment variables

次の非秘密値をEnvironment variablesへ登録する。

| Variable | 用途 |
|---|---|
| `LTM_GCS_BUCKET` | GCS bucket名 |
| `LTM_GCS_PREFIX` | GCS object prefix |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase公開設定 |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase Auth domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase公開設定 |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase公開設定 |
| `MCP_PUBLIC_URL` | 公開MCP URL |
| `MCP_ALLOWED_ORIGINS` | MCP許可origin |
| `LTM_CURATOR_USER_ID` | shared writeを許可するFirebase UID |
| `GCP_SECRET_LTM_MAINTENANCE_TOKEN` | Secret Manager内のmaintenance token secret名 |

### カスタムドメイン `ltm.okakam.net`

Cloud Runの公開MCP URLは `https://ltm.okakam.net` とする。ドメイン所有確認後、`asia-northeast1`の`long-term-memory`サービスへドメインマッピングを作成する。

```bash
gcloud domains verify okakam.net --project="$GCP_PROJECT_ID"
gcloud beta run domain-mappings create \
  --service=long-term-memory \
  --domain=ltm.okakam.net \
  --region=asia-northeast1 \
  --project="$GCP_PROJECT_ID"
gcloud beta run domain-mappings describe \
  --domain=ltm.okakam.net \
  --region=asia-northeast1 \
  --project="$GCP_PROJECT_ID" \
  --format='yaml(status.resourceRecords)'
```

表示された`resourceRecords`を、お名前.comで使用中のネームサーバーへ登録する。GitHub Environment `production`の`MCP_PUBLIC_URL`、`MCP_ALLOWED_ORIGINS`、`CLOUD_RUN_URL`は、DNSとGoogle-managed certificateの有効化後に`https://ltm.okakam.net`へ揃えてから再デプロイする。Cloud Runの直接ドメインマッピングはPreviewであるため、本番の安定性・TLS要件が必要な場合はGlobal External Application Load BalancerまたはFirebase Hostingを使用する。

### Smoke用PATの発行と更新

Firebaseでサインインした状態で、`https://ltm.okakam.net/settings/tokens`を開きます。DNS・certificate設定前はCloud Runの`run.app` URLを使用します。ラベル（例: `github-cloud-run-smoke`）を入力して`PATを発行`を押し、表示されたPATをコピーします。PATは発行直後に一度だけ表示され、再読み込み後には復元できません。コピーに失敗した場合は表示中のPAT本文を選択して手動でコピーしてください。

コピーした値をGitHub repositoryの Settings → Environments → `production` → `LTM_MCP_TOKEN`へ登録します。PAT本文はchat、repository、workflowログへ貼り付けず、値の前後に空白や改行を追加しません。画面が使えない場合の同一Origin API手順は [Google Cloud CLI / Firebase 初期設定手順](google-cloud-cli-setup.md) の「Smoke用FirebaseユーザーとPAT」を参照してください。

## GCP側の前提

- GitHub OIDCのWIF providerはrepository `okakam/long-term-memory` とmain refに限定する。
- deploy service accountにはCloud Run deploy、Cloud Build、Artifact Registry、runtime service account impersonationに必要な権限を付与する。
- runtime service accountにはFirestoreアクセス、Secret Manager secret access、Cloud Run実行に必要な権限だけを付与する。
- Cloud Run serviceは`--allow-unauthenticated`で公開し、アプリ層の`AUTH_REQUIRED=1`、Firebase session、MCP PATで認証する。
- Firebase AuthenticationのEmail/Password・Googleログインは`@okakam.net`だけを許可する。`beforeUserCreated`と`beforeUserSignedIn`、Cloud Run側principal検証の二重構成を維持する。
- Cloud Run runtime service accountへ対象GCS bucketの必要なIAM権限とFirestore accessを付与する。GCS credential keyは作成せず、Application Default Credentialsを使う。
- maintenance tokenはGCP Secret Managerへ登録し、workflowから値をログ出力しない。
- Cloud Runは`asia-northeast1`、min 0、max 1、concurrency 1、1 vCPU、512 MiBを初期値とする。

## 受け入れ確認

mainへマージした後、GitHub Actionsで次を確認する。

1. `verify` jobが成功する（Docker image build後の`GET /api/health`も含む）。
2. `deploy` jobがproduction Environmentで実行される。
3. Cloud Runのrevisionが作成される。
4. Firebase ConsoleでBlocking functionsのbefore user created / before user signed inが登録済みである。
5. `@okakam.net`のEmail/Password・Googleログインが成功する。
6. 許可外ドメインのEmail/Password・Google新規登録・ログインと、既存の許可外ユーザーの再ログインが拒否される。
7. Cloud Run smokeでhealth、MCP initialize、tools/list、save、search、get、update、link、reindex、deleteが成功する。
8. 失敗時はCloud Run revisionとGitHub Actionsログを確認し、必要ならmainからworkflow dispatchで再実行する。

実環境のSecrets、GCP権限、Firebase/GCS/Firestore接続、GitHub Environmentの作成はrepository外の管理作業である。認証済みGitHub管理者が設定し、値をcommitしない。
