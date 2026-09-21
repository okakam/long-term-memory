# Google Cloud CLI / Firebase / Cloud Run 実行環境セットアップ

この文書は、開発コンテナから gcloud と Firebase CLI を使って、Cloud Run・Firebase Authentication・Firestore・Google Cloud Storage（GCS）・GitHub Actions の本番実行環境を初期設定する手順です。

今回の環境構築では、旧 Vercel、Turso、Vercel Blob、Redis、Clerk のデータを移行せず、空のプロジェクトから開始します。Firebase Storage は使用せず、Markdown 本文は Cloud Run から GCS API で保存・取得します。

## 0. 構成と今回の確定値

### 実行構成

- Cloud Run: Next.js アプリケーションを実行する唯一の実行基盤
- Firebase Authentication with Identity Platform: Email/Password・Google 認証
- Firebase Auth Blocking Functions: @okakam.net 以外の新規登録・ログインを拒否
- Firestore: project、membership、memory metadata、name index、tombstone、MCP PAT hash
- GCS: Markdown 本文の immutable な正本
- /tmp SQLite: Cloud Run 内で再構築する検索 cache

GCS と Firestore の実行時認証は Cloud Run runtime service account の Application Default Credentials を使います。サービスアカウント JSON キー、GOOGLE_APPLICATION_CREDENTIALS、AWS credential、実在する .env は作成・保存しません。

### 今回使用した値

| 項目 | 値 |
|---|---|
| GCP / Firebase project ID | long-term-memory-prod |
| project number | 751062990941 |
| region | asia-northeast1 |
| Artifact Registry repository | cloud-run-source-deploy |
| Artifact Registry cleanup policy | タグなし・作成から3日後に削除（実削除モード） |
| GCS bucket | long-term-memory-prod-751062990941 |
| GCS object prefix | projects |
| Firestore database | (default)、Firestore Native、Standard |
| Firestore location | asia-northeast1 |
| Secret ID | ltm-maintenance-prod |
| Firebase Web app display name | long-term-memory-prod-web |
| Firebase CLI alias | prod |

Project ID、project number、bucket 名、Firebase App ID は秘密ではありません。ただし、Firebase Web API key、PAT、maintenance token はこの文書や repository へ記載しません。

### セットアップの状態

今回の作業では、project 作成・課金プラン変更、API 有効化、GCS bucket、Firestore database、Firebase Web app、Email/Password・Google provider、Firestore Rules/Indexes、専用 service account、Secret version の作成・確認まで実行しました。

Workload Identity Federation（WIF）の作成は実行委任しました。Cloud Run の最終 deploy と実環境 smoke は、GitHub Environment と Firebase/GCS の値を揃えた後に実行します。

## 1. 開発コンテナの CLI 認証

VS Code で「Dev Containers: Rebuild Container」を実行した後、コンテナ内で CLI を確認します。

    node --version
    pnpm --version
    gh --version
    gcloud --version
    firebase --version
    jq --version

CLI ごとに認証します。

    gcloud auth login --no-launch-browser
    gcloud auth list
    firebase login --no-localhost
    firebase login:list
    gh auth status

認証トークンを chat、repository、workflow ログへ貼り付けません。gh の認証が必要な場合は端末上で gh auth login を実行し、トークンの値を表示・保存しないでください。

開発コンテナでは、gcloud、Firebase CLI、GitHub CLI、Codex の設定を named volume へ保存します。共有端末では volume に認証情報が入るため、使用後は適切に保護・削除してください。

## 2. プロジェクトと環境変数を確認する

今回の project 値をシェルへ設定します。

    export LTM_PROJECT_ID='long-term-memory-prod'
    export LTM_REGION='asia-northeast1'
    export LTM_GCS_BUCKET='long-term-memory-prod-751062990941'
    export LTM_GCS_PREFIX='projects'
    export LTM_SECRET_ID='ltm-maintenance-prod'

    gcloud config set project "$LTM_PROJECT_ID"
    gcloud config get-value project
    gcloud projects describe "$LTM_PROJECT_ID" --format='yaml(projectId,projectNumber,name,lifecycleState)'

Project number をコマンドから取得する場合は次を使います。

    export LTM_PROJECT_NUMBER="$(gcloud projects describe "$LTM_PROJECT_ID" --format='value(projectNumber)')"
    printf '%s\n' "$LTM_PROJECT_NUMBER"

期待値は project ID long-term-memory-prod、project number 751062990941 です。以降のコマンドは、別 project へ誤操作しないよう --project="$LTM_PROJECT_ID" を明示します。

## 3. 課金先を紐付ける

Cloud Run、Cloud Build、Artifact Registry、Secret Manager などの API 有効化には、project へ有効な Billing account が必要です。Firebase の無料枠を設定していても、Google Cloud 側の Billing account が未紐付けなら API 有効化は失敗します。

今回、最初の gcloud services enable は次のエラーで失敗しました。

    Billing account for project ... is not found
    UREQ_PROJECT_BILLING_NOT_FOUND

Billing account 一覧を確認します。

    gcloud billing accounts list --format='table(ACCOUNT_ID,NAME,OPEN,MASTER_ACCOUNT_ID)'

OPEN=False の account は使用せず、OPEN=True の Billing account ID を使います。今回の一覧では、閉じたアカウントと、利用可能な 01DCF9-51BC7E-00D8D5 が表示されました。

まだ紐付いていない場合は、利用可能な ID を指定します。

    export LTM_BILLING_ACCOUNT_ID='OPEN=True の Billing account ID'
    gcloud billing projects link "$LTM_PROJECT_ID" --billing-account="$LTM_BILLING_ACCOUNT_ID"
    gcloud billing projects describe "$LTM_PROJECT_ID"

Billing account を変更した後、失敗した API 有効化コマンドを最初から再実行します。

## 4. Google Cloud API を有効化する

Cloud Run、Cloud Build、Artifact Registry、GCS、Firestore、Secret Manager、WIF、Firebase Authentication に必要な API を有効化します。

    gcloud services enable \
      run.googleapis.com \
      cloudbuild.googleapis.com \
      artifactregistry.googleapis.com \
      storage.googleapis.com \
      firestore.googleapis.com \
      firebaserules.googleapis.com \
      secretmanager.googleapis.com \
      iamcredentials.googleapis.com \
      sts.googleapis.com \
      firebase.googleapis.com \
      identitytoolkit.googleapis.com \
      --project="$LTM_PROJECT_ID"

Firebase Auth Blocking Functions を deploy する前に、Functions の依存 API も有効化します。

    gcloud services enable \
      cloudfunctions.googleapis.com \
      eventarc.googleapis.com \
      eventarcpublishing.googleapis.com \
      pubsub.googleapis.com \
      --project="$LTM_PROJECT_ID"

有効化結果を確認します。

    gcloud services list --enabled --project="$LTM_PROJECT_ID" --format='value(config.name)' | sort

gcloud run deploy --source . を使うと Cloud Build と Artifact Registry が動作するため、API 有効化だけでなく Billing account の紐付けも必要です。ビルド回数、Artifact Registry 容量、Cloud Run、GCS、Firestore、Secret Manager の利用量は課金対象になり得ます。

### Artifact Registry の不要イメージを自動削除する

Cloud Run の source deploy が使用する Artifact Registry repository には、タグのないイメージを作成から 3 日後に削除する cleanup policy を設定します。タグ付きのイメージ（`latest` など）は対象外です。policy の正本は `docs/artifact-registry-cleanup-policy.json` です。

今回の repository は `cloud-run-source-deploy` です。対象 repository を確認します。

    export LTM_ARTIFACT_REPOSITORY='cloud-run-source-deploy'
    gcloud artifacts repositories list --project="$LTM_PROJECT_ID" --location="$LTM_REGION"

policy を設定します。`--no-dry-run` を明示して実削除を有効にします。既存の設定が dry-run の場合、`--policy` だけでは dry-run が維持されるため、必ず `--no-dry-run` を付けます。

    gcloud artifacts repositories set-cleanup-policies "$LTM_ARTIFACT_REPOSITORY" \
      --project="$LTM_PROJECT_ID" \
      --location="$LTM_REGION" \
      --policy=docs/artifact-registry-cleanup-policy.json \
      --no-dry-run

設定と dry-run 状態を確認します。

    gcloud artifacts repositories list-cleanup-policies "$LTM_ARTIFACT_REPOSITORY" \
      --project="$LTM_PROJECT_ID" \
      --location="$LTM_REGION" \
      --format='yaml'

`Dry run is disabled.`、`tagState: UNTAGGED`、`olderThan: 259200s` が表示されることを確認します。cleanup は Artifact Registry の定期処理で実行されるため、作成から正確に 72 時間経過した瞬間に削除されるとは限りません。設定変更時点で 3 日を超えたタグなしイメージがあれば、次回の定期処理で削除対象になります。

## 5. GCS bucket を作成する

bucket 名は Google Cloud 全体で一意である必要があります。今回の bucket は long-term-memory-prod-751062990941 です。

    gcloud storage buckets create "gs://$LTM_GCS_BUCKET" --project="$LTM_PROJECT_ID" --location="$LTM_REGION" --uniform-bucket-level-access --public-access-prevention

作成後は IAM 設定を raw 形式で確認します。

    gcloud storage buckets describe "gs://$LTM_GCS_BUCKET" --raw --format='yaml(iamConfiguration)'

次の状態であることを確認します。

- uniformBucketLevelAccess.enabled: true
- publicAccessPrevention: enforced
- 環境によっては互換情報として bucketPolicyOnly.enabled: true も表示される

通常の format 指定だけでは nested IAM の値が表示されない場合があるため、IAM 設定の確認には --raw --format='yaml(iamConfiguration)' を使います。

Runtime service account への IAM 付与は、service account 作成後に行います。GCS object は公開せず、Firebase Storage bucket は作成・使用しません。

## 6. Firestore Native mode を作成する

Firestore の location は後から変更できないため、Cloud Run と同じ asia-northeast1 にします。削除保護を有効にしたまま作成します。

    gcloud firestore databases create --project="$LTM_PROJECT_ID" --database='(default)' --location="$LTM_REGION" --type=firestore-native --edition=standard --delete-protection

作成済みの場合は、create を再実行せず確認だけ行います。

    gcloud firestore databases describe --project="$LTM_PROJECT_ID" --database='(default)' --format='yaml(name,locationId,type,deleteProtectionState)'

期待値は、locationId: asia-northeast1、type: FIRESTORE_NATIVE、deleteProtectionState: DELETE_PROTECTION_ENABLED です。

## 7. Firebase project を正しく選択する

Firebase CLI の project 一覧を確認します。

    firebase projects:list

今回の対象は long-term-memory-prod です。既に一覧に対象 project があり、firebase apps:list --project="$LTM_PROJECT_ID" を実行できる場合は、firebase projects:addfirebase を再実行しません。

GCP project がまだ Firebase project になっていない場合だけ、次を実行します。対話画面では必ず long-term-memory-prod を選択します。

    firebase projects:addfirebase

まず既存 alias を確認します。

    sed -n '1,80p' .firebaserc

prod が未登録、または対象 project と異なる場合だけ、ローカル alias を設定します。

    firebase use --add
    firebase use

対話 prompt では必ず long-term-memory-prod を選び、alias を prod にします。.firebaserc は次の対応になっている必要があります。

    {
      "projects": {
        "prod": "long-term-memory-prod"
      }
    }

firebase projects:addfirebase は対話選択を誤ると、別の host project へ Firebase を追加します。今回も選択画面で対象外の project を選ばないよう注意が必要でした。実行後は必ず firebase projects:list、firebase use、firebase apps:list --project="$LTM_PROJECT_ID" で project ID を再確認します。

## 8. Firebase Web app と Authentication を設定する

Web app が未作成か確認します。

    firebase apps:list --project="$LTM_PROJECT_ID"

未作成なら作成します。

    firebase apps:create WEB 'long-term-memory-prod-web' --project="$LTM_PROJECT_ID"

出力された実際の App ID を変数へ設定し、SDK config を取得します。

    export LTM_FIREBASE_APP_ID='firebase apps:create が出力した実際の App ID'
    firebase apps:sdkconfig WEB "$LTM_FIREBASE_APP_ID" --project="$LTM_PROJECT_ID"

firebase apps:sdkconfig WEB 'APP_ID' のように placeholder 文字列をそのまま渡すと失敗します。firebase apps:create の出力にある 1:...:web:... 形式の App ID を使います。

SDK config に含まれる apiKey、authDomain、projectId、appId は、Cloud Run の GitHub Environment variable へ登録します。Firebase Web API key は client 用の公開識別子なので、Secret ではなく NEXT_PUBLIC_FIREBASE_API_KEY の Environment variable として扱います。ただし、repository、Issue、ログ、文書へ実値を記載しません。

Firebase Console で次を設定します。

1. Authentication → Sign-in method → Email/Password を有効化
2. Authentication → Sign-in method → Google を有効化
3. Authentication → Settings → Authorized domains へ Cloud Run の hostname を追加
4. Identity Platform / Authentication の設定を対象 project で確認

Authorized domains はログイン元の Web hostname の許可リストであり、メールアドレスの domain 制限ではありません。@okakam.net の制限はアプリ側と Blocking Functions の両方で行います。

### Firebase Auth Blocking Functions を deploy する

repository の functions/ には、@okakam.net 以外を拒否する beforeUserCreated と beforeUserSignedIn を定義しています。Google の hd=okakam.net は選択画面の hint であり、認可判定ではありません。

    pnpm --dir functions --ignore-workspace install --frozen-lockfile --ignore-scripts
    pnpm --dir functions --ignore-workspace test
    pnpm --dir functions --ignore-workspace build
    firebase deploy --project="$LTM_PROJECT_ID" --only functions

deploy 後、Firebase Console の Authentication → Settings → Blocking functions で、before user created と before user signed in の両方が登録されていることを確認します。

Functions のコードを変更した場合は、この Firebase deploy を再実行します。Cloud Run deploy workflow は Functions を自動 deploy しません。

## 9. Firestore Rules と Indexes を適用する

firebase.json は firestore.rules と firestore.indexes.json を参照します。対象 project を明示して deploy します。

    firebase deploy --project="$LTM_PROJECT_ID" --only firestore
    firebase firestore:indexes --project="$LTM_PROJECT_ID" --database='(default)'

初期状態で indexes: []、fieldOverrides: [] でも正常です。firestore.rules は Firebase client SDK からの read/write を拒否し、Cloud Run の Firebase Admin SDK だけが Firestore を操作します。

## 10. 専用 Service Account と IAM を設定する

既存 service account を確認してから、Cloud Run deploy 用と runtime 用を分離して作成します。

    gcloud iam service-accounts list --project="$LTM_PROJECT_ID" --format='table(email,displayName,disabled)'

    export LTM_DEPLOY_SA="ltm-deploy@$LTM_PROJECT_ID.iam.gserviceaccount.com"
    export LTM_RUNTIME_SA="ltm-runtime@$LTM_PROJECT_ID.iam.gserviceaccount.com"
    export LTM_BUILD_SA="$(gcloud builds get-default-service-account --project="$LTM_PROJECT_ID")"

    gcloud iam service-accounts create ltm-runtime --project="$LTM_PROJECT_ID" --display-name='long-term-memory Cloud Run runtime'
    gcloud iam service-accounts create ltm-deploy --project="$LTM_PROJECT_ID" --display-name='long-term-memory Cloud Run deploy'

既に作成済みの場合は ALREADY_EXISTS で止めず、service account 一覧と IAM policy を確認します。

### Deploy service account

この repository の workflow は gcloud run deploy --source . を使います。

    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" --member="serviceAccount:$LTM_DEPLOY_SA" --role='roles/run.sourceDeveloper'
    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" --member="serviceAccount:$LTM_DEPLOY_SA" --role='roles/serviceusage.serviceUsageConsumer'
    gcloud iam service-accounts add-iam-policy-binding "$LTM_RUNTIME_SA" --project="$LTM_PROJECT_ID" --member="serviceAccount:$LTM_DEPLOY_SA" --role='roles/iam.serviceAccountUser'

### Cloud Build service account

Source deploy に使われる実際の Cloud Build service account へ Cloud Run Builder を付与します。Compute Engine default service account を推測せず、次のコマンドの出力を使います。

    printf '%s\n' "$LTM_BUILD_SA"
    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" --member="serviceAccount:$LTM_BUILD_SA" --role='roles/run.builder'

Cloud Build が別 service account を使う設定なら、その service account へ付与先を変更します。

### Runtime service account

    gcloud storage buckets add-iam-policy-binding "gs://$LTM_GCS_BUCKET" --member="serviceAccount:$LTM_RUNTIME_SA" --role='roles/storage.objectUser'
    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" --member="serviceAccount:$LTM_RUNTIME_SA" --role='roles/datastore.user'
    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" --member="serviceAccount:$LTM_RUNTIME_SA" --role='roles/firebaseauth.editor'

## 11. Secret Manager へ maintenance token を登録する

Secret 本文を repository、GitHub variable、Cloud Run の環境変数へ直接保存せず、Secret Manager から Cloud Run へ注入します。Secret ID だけを GitHub Environment variable へ登録します。

新規作成時は、値を一時ファイルへ生成します。

    export LTM_SECRET_FILE="$(mktemp)"
    trap 'rm -f "$LTM_SECRET_FILE"' EXIT
    umask 077
    openssl rand -base64 48 > "$LTM_SECRET_FILE"

    gcloud secrets create "$LTM_SECRET_ID" --project="$LTM_PROJECT_ID" --replication-policy=automatic
    gcloud secrets versions add "$LTM_SECRET_ID" --project="$LTM_PROJECT_ID" --data-file="$LTM_SECRET_FILE"
    gcloud secrets add-iam-policy-binding "$LTM_SECRET_ID" --project="$LTM_PROJECT_ID" --member="serviceAccount:$LTM_RUNTIME_SA" --role='roles/secretmanager.secretAccessor'

既存 Secret の場合は gcloud secrets create を再実行せず、必要な場合だけ新しい version を追加します。version の存在だけを確認します。

    gcloud secrets versions list "$LTM_SECRET_ID" --project="$LTM_PROJECT_ID" --format='table(name,state,createTime)'

今回の確認では version 1 が enabled でした。Secret 本文を表示する access コマンドは、値の漏えい防止のため通常の確認では実行しません。

## 12. GitHub Actions 用 Workload Identity Federation

WIF は GitHub Actions からサービスアカウントキーなしで Cloud Run へ deploy するために使います。GitHub repository okakam/long-term-memory の main push だけを受け付ける条件にします。

今回の作業では WIF の実行を委任しています。委任先または管理者が実行する場合は、次の値を使います。

    export LTM_REPOSITORY_ID="$(gh api repos/okakam/long-term-memory --jq '.id')"
    export LTM_WIF_POOL_ID='github'
    export LTM_WIF_PROVIDER_ID='long-term-memory-main'

    gcloud iam workload-identity-pools describe "$LTM_WIF_POOL_ID" --project="$LTM_PROJECT_ID" --location=global >/dev/null || \
      gcloud iam workload-identity-pools create "$LTM_WIF_POOL_ID" --project="$LTM_PROJECT_ID" --location=global --display-name='GitHub Actions'
    gcloud iam workload-identity-pools providers describe "$LTM_WIF_PROVIDER_ID" --project="$LTM_PROJECT_ID" --location=global --workload-identity-pool="$LTM_WIF_POOL_ID" >/dev/null || \
      gcloud iam workload-identity-pools providers create-oidc "$LTM_WIF_PROVIDER_ID" --project="$LTM_PROJECT_ID" --location=global --workload-identity-pool="$LTM_WIF_POOL_ID" --display-name='long-term-memory main deploy' --issuer-uri='https://token.actions.githubusercontent.com/' --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref' --attribute-condition="assertion.repository_id == '$LTM_REPOSITORY_ID' && assertion.ref == 'refs/heads/main'"

    export LTM_WIF_POOL="projects/$LTM_PROJECT_NUMBER/locations/global/workloadIdentityPools/$LTM_WIF_POOL_ID"
    export LTM_WIF_PROVIDER="$(gcloud iam workload-identity-pools providers describe "$LTM_WIF_PROVIDER_ID" --project="$LTM_PROJECT_ID" --location=global --workload-identity-pool="$LTM_WIF_POOL_ID" --format='value(name)')"

    gcloud iam service-accounts add-iam-policy-binding "$LTM_DEPLOY_SA" --project="$LTM_PROJECT_ID" --member="principalSet://iam.googleapis.com/$LTM_WIF_POOL/attribute.repository_id/$LTM_REPOSITORY_ID" --role='roles/iam.workloadIdentityUser'
    printf '%s\n' "$LTM_WIF_PROVIDER"

LTM_WIF_PROVIDER の完全な resource name を GitHub Environment secret の GCP_WORKLOAD_IDENTITY_PROVIDER へ登録します。Pool 名だけでなく、project number を含む Provider の resource name 全体を使います。

## 13. GitHub production Environment を設定する

GitHub repository の Settings → Environments → production を作成し、Deployment branches and tags は main だけに制限します。

### Environment secrets

| Secret | 値 |
|---|---|
| GCP_PROJECT_ID | long-term-memory-prod |
| GCP_WORKLOAD_IDENTITY_PROVIDER | WIF Provider の完全な resource name |
| GCP_DEPLOY_SERVICE_ACCOUNT | ltm-deploy@long-term-memory-prod.iam.gserviceaccount.com |
| GCP_RUNTIME_SERVICE_ACCOUNT | ltm-runtime@long-term-memory-prod.iam.gserviceaccount.com |
| CLOUD_RUN_URL | Cloud Run の base URL。/api 以下は付けない |
| LTM_MCP_TOKEN | /settings/tokens で発行した Smoke 用 PAT |

### Environment variables

| Variable | 値 |
|---|---|
| LTM_GCS_BUCKET | long-term-memory-prod-751062990941。gs:// は付けない |
| LTM_GCS_PREFIX | projects |
| FIREBASE_PROJECT_ID | long-term-memory-prod |
| NEXT_PUBLIC_FIREBASE_API_KEY | Firebase Web app の apiKey。公開設定値なので Secret ではない |
| NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN | Firebase Web app の authDomain |
| NEXT_PUBLIC_FIREBASE_PROJECT_ID | long-term-memory-prod |
| NEXT_PUBLIC_FIREBASE_APP_ID | Firebase Web app の appId |
| MCP_PUBLIC_URL | Cloud Run の base URL |
| MCP_ALLOWED_ORIGINS | 初期値は Cloud Run の base URL |
| LTM_CURATOR_USER_ID | shared write を許可する Firebase UID |
| GCP_SECRET_LTM_MAINTENANCE_TOKEN | ltm-maintenance-prod。Secret 本文ではない |

GitHub Actions の google-github-actions/auth はサービスアカウントキーを使わず、WIF で認証します。実値を repository、Issue、PR 本文、ログへ書きません。

## 14. 初回 Cloud Run deploy と URL 確認

初回は Cloud Run URL が未確定なので、Cloud Build を使った bootstrap deploy を実行します。Billing account が未設定だと、Cloud Run、Cloud Build、Artifact Registry、Secret Manager のいずれかで失敗します。

    export LTM_RUNTIME_SA="ltm-runtime@$LTM_PROJECT_ID.iam.gserviceaccount.com"
    export LTM_FIREBASE_API_KEY='firebase apps:sdkconfig の apiKey'
    export LTM_FIREBASE_AUTH_DOMAIN='firebase apps:sdkconfig の authDomain'
    export LTM_FIREBASE_APP_ID='firebase apps:sdkconfig の appId'
    gcloud run deploy long-term-memory \
      --source . \
      --project="$LTM_PROJECT_ID" \
      --region="$LTM_REGION" \
      --allow-unauthenticated \
      --min=0 --max=1 --concurrency=1 \
      --cpu=1 --memory=512Mi --timeout=300 \
      --service-account="$LTM_RUNTIME_SA" \
      --set-env-vars="LTM_STORAGE_DRIVER=cloud,AUTH_REQUIRED=1,LTM_GCS_BUCKET=$LTM_GCS_BUCKET,LTM_GCS_PREFIX=$LTM_GCS_PREFIX,FIREBASE_PROJECT_ID=$LTM_PROJECT_ID,NEXT_PUBLIC_FIREBASE_API_KEY=$LTM_FIREBASE_API_KEY,NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$LTM_FIREBASE_AUTH_DOMAIN,NEXT_PUBLIC_FIREBASE_PROJECT_ID=$LTM_PROJECT_ID,NEXT_PUBLIC_FIREBASE_APP_ID=$LTM_FIREBASE_APP_ID" \
      --set-secrets="LTM_MAINTENANCE_TOKEN=$LTM_SECRET_ID:latest"

この deploy は URL を確定するための bootstrap ですが、LTM_STORAGE_DRIVER=cloud と AUTH_REQUIRED=1 を明示して、本番のストレージ・認証モードで起動します。URL確定前なので MCP_PUBLIC_URL と MCP_ALLOWED_ORIGINS は最終 deploy で設定し、URL取得前のサービスを受入確認へ使いません。Cloud Run は --allow-unauthenticated で Invoker を公開しますが、アプリ側は AUTH_REQUIRED=1、Firebase session、MCP PAT で認証します。

URL を取得します。

    export LTM_CLOUD_RUN_URL="$(gcloud run services describe long-term-memory --project="$LTM_PROJECT_ID" --region="$LTM_REGION" --format='value(status.url)')"
    printf '%s\n' "$LTM_CLOUD_RUN_URL"

この URL はbootstrap直後の確認用です。独自ドメインの設定後は `https://ltm.okakam.net` を `CLOUD_RUN_URL`、`MCP_PUBLIC_URL`、`MCP_ALLOWED_ORIGINS`へ反映します。production Environment の値を揃えてから、develop → main の Release PR をマージします。main push で verify、deploy、Cloud Run smoke が実行されます。

## 15. Smoke 用 Firebase ユーザーと PAT

Cloud Run の base URL へ Firebase ユーザーでサインインし、smoke project を作成します。

    const response = await fetch('/api/projects', { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({project_id: 'smoke'}) });
    const body = await response.json();
    if (!response.ok) throw new Error(String(response.status) + ': ' + JSON.stringify(body));
    console.log(body);

PAT は画面から発行します。

1. 独自ドメイン設定後は `https://ltm.okakam.net/settings/tokens`、設定前は `$LTM_CLOUD_RUN_URL/settings/tokens` を開く
2. Firebase でサインインし、ラベルを入力して PATを発行 を押す
3. 表示された PAT を PATをコピー でコピーする
4. GitHub repository の Settings → Environments → production → LTM_MCP_TOKEN へ登録する

PAT 本文は発行直後に一度だけ表示され、画面を離れた後は復元できません。PAT 本文を chat、repository、GitHub Actions ログ、ブラウザ共有ログへ貼り付けません。

ブラウザの Clipboard API は、開発者コンソールが focus されていない場合に NotAllowedError: Document is not focused になることがあります。その場合は、画面に表示中の PAT 本文を選択して手動でコピーします。自動コピー失敗を理由に PAT を再発行したり、console へ PAT 本文を出力したりしません。

Firebase Console の Authentication → Users から curator 用ユーザーの UID を取得し、LTM_CURATOR_USER_ID へ設定します。メールアドレスではなく Firebase UID を使います。

## 16. セットアップ確認コマンド

    gcloud config get-value project
    gcloud storage buckets describe "gs://$LTM_GCS_BUCKET" --raw --format='yaml(name,location,iamConfiguration)'
    gcloud firestore databases describe --project="$LTM_PROJECT_ID" --database='(default)' --format='yaml(name,locationId,type,deleteProtectionState)'
    firebase projects:list
    firebase use
    firebase apps:list --project="$LTM_PROJECT_ID"
    firebase firestore:indexes --project="$LTM_PROJECT_ID" --database='(default)'
    gcloud iam service-accounts list --project="$LTM_PROJECT_ID" --format='table(email,displayName,disabled)'
    gcloud secrets versions list "$LTM_SECRET_ID" --project="$LTM_PROJECT_ID" --format='table(name,state,createTime)'
    gcloud run services describe long-term-memory --project="$LTM_PROJECT_ID" --region="$LTM_REGION" --format='yaml(metadata.name,status.url,spec.template.spec.serviceAccountName)'

実環境 smoke が成功するまで、Cloud Run/Firebase/GCS/Firestore の接続確認は未完了ゲートとして扱います。unit test、lint、production build だけでは外部 provider 接続済みとは扱いません。旧データの export/import/verify は fresh start 方針のため対象外です。

## 17. 今回発生した問題と対処

### UREQ_PROJECT_BILLING_NOT_FOUND

Cloud Run、Cloud Build、Artifact Registry、Secret Manager の API 有効化前に、project へ OPEN=True の Billing account を紐付けます。閉じた Billing account は選択しません。紐付け後に gcloud services enable を再実行します。

### GCS の IAM 設定が describe に表示されない

--raw --format='yaml(iamConfiguration)' で確認します。通常の format 指定だけでは nested field が省略されることがあります。

### Firebase CLI が別 project を選択する

firebase projects:addfirebase の対話選択を盲目的に確定せず、firebase projects:list で対象 ID を確認します。alias 設定後も firebase use と firebase apps:list --project="$LTM_PROJECT_ID" で再確認します。

### firebase apps:sdkconfig が失敗する

APP_ID という文字列ではなく、firebase apps:create が返した実際の Web App ID を渡します。

### PAT の自動コピーが失敗する

Document is not focused はブラウザの focus 権限による失敗です。画面に表示された本文を手動選択してコピーし、PAT 本文をログへ出力しません。
