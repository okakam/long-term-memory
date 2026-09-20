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
| `LTM_MCP_TOKEN` | smoke専用MCP PAT |

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

## GCP側の前提

- GitHub OIDCのWIF providerはrepository `okakam/long-term-memory` とmain refに限定する。
- deploy service accountにはCloud Run deploy、Cloud Build、Artifact Registry、runtime service account impersonationに必要な権限を付与する。
- runtime service accountにはFirestoreアクセス、Secret Manager secret access、Cloud Run実行に必要な権限だけを付与する。
- Cloud Run serviceは`--allow-unauthenticated`で公開し、アプリ層の`AUTH_REQUIRED=1`、Firebase session、MCP PATで認証する。
- Cloud Run runtime service accountへ対象GCS bucketの必要なIAM権限とFirestore accessを付与する。GCS credential keyは作成せず、Application Default Credentialsを使う。
- maintenance tokenはGCP Secret Managerへ登録し、workflowから値をログ出力しない。
- Cloud Runは`asia-northeast1`、min 0、max 1、concurrency 1、1 vCPU、512 MiBを初期値とする。

## 受け入れ確認

mainへマージした後、GitHub Actionsで次を確認する。

1. `verify` jobが成功する（Docker image build後の`GET /api/health`も含む）。
2. `deploy` jobがproduction Environmentで実行される。
3. Cloud Runのrevisionが作成される。
4. Cloud Run smokeでhealth、MCP initialize、tools/list、save、search、get、update、link、reindex、deleteが成功する。
5. 失敗時はCloud Run revisionとGitHub Actionsログを確認し、必要ならmainからworkflow dispatchで再実行する。

実環境のSecrets、GCP権限、Firebase/GCS/Firestore接続、GitHub Environmentの作成はrepository外の管理作業である。認証済みGitHub管理者が設定し、値をcommitしない。
