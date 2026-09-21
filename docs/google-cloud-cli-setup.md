# Google Cloud CLI / Firebase 初期設定手順

この文書は、開発コンテナから gcloud と Firebase CLIを使って、Cloud Run・Firebase Authentication・Firestore・GCS・GitHub Actionsの本番デプロイ基盤を初期設定する手順です。

アプリケーションの構成は次のとおりです。

- Cloud Run: Next.jsアプリケーションを実行する唯一の実行基盤
- Firebase Authentication: Webユーザーの認証
- Firestore: project、membership、metadata、name index、tombstone、MCP PAT hash
- GCS: Markdown本文のimmutableな正本
- /tmp SQLite: Cloud Run内で再構築する検索cache

GCSとFirestoreの実行時認証はCloud Run runtime service accountのApplication Default Credentialsを使います。サービスアカウントJSONキー、GOOGLE_APPLICATION_CREDENTIALS、AWS credential、実在する.envは作成・保存しません。Firebase Admin SDKはGoogle環境でADCを使う構成が推奨されています。[Firebase Admin SDKの設定](https://firebase.google.com/docs/admin/setup)

## 1. 開発コンテナの認証

VS Codeで「Dev Containers: Rebuild Container」を実行した後、コンテナ内で認証します。

    gcloud --version
    firebase --version

    gcloud auth login --no-launch-browser
    gcloud auth list

    firebase login --no-localhost
    firebase projects:list

対象プロジェクトをgcloudの既定値にします。

    export LTM_PROJECT_ID='実際のGCPプロジェクトID'
    export LTM_REGION='asia-northeast1'

    gcloud config set project "$LTM_PROJECT_ID"
    gcloud config get-value project

開発コンテナではgcloudとFirebase CLIの設定を long-term-memory-cloud-cli named volumeに保存します。コンテナを再作成しても認証状態を再利用できます。共有端末ではこのvolumeに認証情報が入るため、使用後は適切に削除・保護してください。

Node.jsアプリをローカルからGoogle APIへ接続して確認する必要がある場合だけ、ユーザーADCも作成します。

    gcloud auth application-default login --no-launch-browser

通常のローカル開発は AUTH_REQUIRED=0 とlocal storageを使うため、ユーザーADCは必須ではありません。

## 2. Google Cloud APIを有効化する

    gcloud services enable \
      run.googleapis.com \
      cloudbuild.googleapis.com \
      artifactregistry.googleapis.com \
      storage.googleapis.com \
      firestore.googleapis.com \
      secretmanager.googleapis.com \
      iamcredentials.googleapis.com \
      sts.googleapis.com \
      firebase.googleapis.com \
      identitytoolkit.googleapis.com \
      --project="$LTM_PROJECT_ID"

課金アカウントがプロジェクトに紐付いていることも確認します。Cloud Run、Firestore、GCS、Artifact Registryは利用量に応じて課金される可能性があります。

## 3. GCSバケットを作成する

バケット名は全GCPで一意である必要があります。

    export LTM_GCS_BUCKET='全体で一意なバケット名'
    export LTM_GCS_PREFIX='projects'

    gcloud storage buckets create "gs://$LTM_GCS_BUCKET" \
      --project="$LTM_PROJECT_ID" \
      --location="$LTM_REGION" \
      --uniform-bucket-level-access \
      --public-access-prevention

確認します。

    gcloud storage buckets describe "gs://$LTM_GCS_BUCKET" \
      --format='yaml(name,location,iamConfiguration.uniformBucketLevelAccess,iamConfiguration.publicAccessPrevention)'

アプリはオブジェクトを公開しません。Uniform bucket-level accessとPublic access preventionを有効にし、IAMでruntime service accountだけにアクセスを許可します。[gcloud storage buckets create](https://docs.cloud.google.com/sdk/gcloud/reference/storage/buckets/create)

## 4. Firestore Native modeを作成する

Firestoreのロケーションは後から変更できないため、Cloud Runと同じ asia-northeast1 を初期値にします。

    gcloud firestore databases create \
      --project="$LTM_PROJECT_ID" \
      --database='(default)' \
      --location="$LTM_REGION" \
      --type=firestore-native \
      --edition=standard \
      --delete-protection

既に作成済みの場合は、作成コマンドを再実行せず確認します。

    gcloud firestore databases describe \
      --project="$LTM_PROJECT_ID" \
      --database='(default)'

## 5. FirebaseプロジェクトとAuthenticationを設定する

Firebase Consoleで、LTM_PROJECT_IDと同じGoogle CloudプロジェクトにFirebaseを追加します。

Firebase Consoleで次を設定します。

1. Authentication → Sign-in method → Email/Passwordを有効化
2. Authentication → Sign-in method → Googleを有効化
3. Authentication → Settings → Authorized domainsへCloud Runドメインを追加
4. Project settings → Your apps → Webアプリを登録
5. Webアプリの設定から apiKey、authDomain、projectId、appId を控える

Firebase Web設定値はクライアント用の公開識別子です。ただし、GitHub Environmentの環境差分を管理するため、リポジトリへ直書きせずEnvironment variableへ登録します。[Firebase Web setup](https://firebase.google.com/docs/web/setup)

## 6. Firebase CLIでRulesとIndexesを適用する

このリポジトリの firebase.json は firestore.rules と firestore.indexes.json を参照します。対象プロジェクトをコマンド引数で指定し、.firebasercへ環境固有のaliasを必須にしません。

    firebase deploy \
      --project="$LTM_PROJECT_ID" \
      --only firestore

適用結果を確認します。

    firebase firestore:indexes \
      --project="$LTM_PROJECT_ID" \
      --database='(default)'

firestore.rulesはFirebaseクライアントからのread/writeを拒否し、Cloud RunのFirebase Admin SDKだけがFirestoreを操作する設計です。Firebase CLIのpartial deployは[公式CLIリファレンス](https://firebase.google.com/docs/cli)を参照してください。

## 7. Service Accountを作成する

Deploy用とRuntime用を分離します。

    export LTM_PROJECT_NUMBER="$(gcloud projects describe "$LTM_PROJECT_ID" --format='value(projectNumber)')"
    export LTM_DEPLOY_SA="ltm-deploy@$LTM_PROJECT_ID.iam.gserviceaccount.com"
    export LTM_RUNTIME_SA="ltm-runtime@$LTM_PROJECT_ID.iam.gserviceaccount.com"
    export LTM_BUILD_SA="$LTM_PROJECT_NUMBER-compute@developer.gserviceaccount.com"

    gcloud iam service-accounts create ltm-deploy \
      --project="$LTM_PROJECT_ID" \
      --display-name='long-term-memory Cloud Run deploy'

    gcloud iam service-accounts create ltm-runtime \
      --project="$LTM_PROJECT_ID" \
      --display-name='long-term-memory Cloud Run runtime'

### Deploy service accountの権限

このリポジトリのworkflowは gcloud run deploy --source . を使います。

    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" \
      --member="serviceAccount:$LTM_DEPLOY_SA" \
      --role='roles/run.sourceDeveloper'

    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" \
      --member="serviceAccount:$LTM_DEPLOY_SA" \
      --role='roles/serviceusage.serviceUsageConsumer'

    gcloud iam service-accounts add-iam-policy-binding "$LTM_RUNTIME_SA" \
      --project="$LTM_PROJECT_ID" \
      --member="serviceAccount:$LTM_DEPLOY_SA" \
      --role='roles/iam.serviceAccountUser'

### Cloud Build service accountの権限

Source deployに使われるBuild service accountへCloud Run Builderを付与します。標準構成では上記の LTM_BUILD_SA ですが、Cloud Buildの設定で別のservice accountを指定している場合は、そのアカウントへ付与してください。

    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" \
      --member="serviceAccount:$LTM_BUILD_SA" \
      --role='roles/run.builder'

### Runtime service accountの権限

    gcloud storage buckets add-iam-policy-binding "gs://$LTM_GCS_BUCKET" \
      --member="serviceAccount:$LTM_RUNTIME_SA" \
      --role='roles/storage.objectUser'

    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" \
      --member="serviceAccount:$LTM_RUNTIME_SA" \
      --role='roles/datastore.user'

    # Firebase session cookie作成に必要なfirebaseauth.users.createSessionを含める。
    gcloud projects add-iam-policy-binding "$LTM_PROJECT_ID" \
      --member="serviceAccount:$LTM_RUNTIME_SA" \
      --role='roles/firebaseauth.editor'

## 8. Secret Managerにmaintenance tokenを登録する

Secret IDはGitHub Environment variableに登録します。Secretの値そのものはGitHubやリポジトリへ保存しません。

    export LTM_SECRET_ID='ltm-maintenance-prod'
    export LTM_SECRET_FILE="$(mktemp)"
    trap 'rm -f "$LTM_SECRET_FILE"' EXIT

    umask 077
    openssl rand -base64 48 > "$LTM_SECRET_FILE"

    gcloud secrets create "$LTM_SECRET_ID" \
      --project="$LTM_PROJECT_ID" \
      --replication-policy=automatic

    gcloud secrets versions add "$LTM_SECRET_ID" \
      --project="$LTM_PROJECT_ID" \
      --data-file="$LTM_SECRET_FILE"

    gcloud secrets add-iam-policy-binding "$LTM_SECRET_ID" \
      --project="$LTM_PROJECT_ID" \
      --member="serviceAccount:$LTM_RUNTIME_SA" \
      --role='roles/secretmanager.secretAccessor'

Cloud Runではworkflowが次のように注入します。

    LTM_MAINTENANCE_TOKEN=<Secret Managerのlatest version>

## 9. GitHub Actions用Workload Identity Federationを作成する

GitHub OIDC Providerは okakam/long-term-memory の main pushだけを受け付けるように制限します。GitHubのrepository IDは再利用されないため、repository名だけでなくIDも条件に使います。

    export LTM_REPOSITORY_ID="$(gh api repos/okakam/long-term-memory --jq '.id')"
    export LTM_WIF_POOL_ID='github'
    export LTM_WIF_PROVIDER_ID='long-term-memory-main'

    gcloud iam workload-identity-pools create "$LTM_WIF_POOL_ID" \
      --project="$LTM_PROJECT_ID" \
      --location=global \
      --display-name='GitHub Actions'

    gcloud iam workload-identity-pools providers create-oidc "$LTM_WIF_PROVIDER_ID" \
      --project="$LTM_PROJECT_ID" \
      --location=global \
      --workload-identity-pool="$LTM_WIF_POOL_ID" \
      --display-name='long-term-memory main deploy' \
      --issuer-uri='https://token.actions.githubusercontent.com/' \
      --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref' \
      --attribute-condition="assertion.repository_id == '$LTM_REPOSITORY_ID' && assertion.ref == 'refs/heads/main'"

    export LTM_WIF_POOL="projects/$LTM_PROJECT_NUMBER/locations/global/workloadIdentityPools/$LTM_WIF_POOL_ID"
    export LTM_WIF_PROVIDER="$(gcloud iam workload-identity-pools providers describe "$LTM_WIF_PROVIDER_ID" \
      --project="$LTM_PROJECT_ID" \
      --location=global \
      --workload-identity-pool="$LTM_WIF_POOL_ID" \
      --format='value(name)')"

    gcloud iam service-accounts add-iam-policy-binding "$LTM_DEPLOY_SA" \
      --project="$LTM_PROJECT_ID" \
      --member="principalSet://iam.googleapis.com/$LTM_WIF_POOL/attribute.repository_id/$LTM_REPOSITORY_ID" \
      --role='roles/iam.workloadIdentityUser'

    printf '%s\n' "$LTM_WIF_PROVIDER"

最後に表示されたProviderの完全なResource nameを、GitHub Environment secretの GCP_WORKLOAD_IDENTITY_PROVIDER に設定します。WIFのProvider名にはproject numberが含まれ、Pool名だけではありません。[Google Cloud WIF](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)、[google-github-actions/auth](https://github.com/google-github-actions/auth/blob/main/README.md)

## 10. GitHub production Environmentへ登録する値

GitHub repositoryの Settings → Environments → production を作成し、Deployment branches and tagsは main のみにします。

### Environment secrets

| Secret | 値 |
|---|---|
| GCP_PROJECT_ID | LTM_PROJECT_ID |
| GCP_WORKLOAD_IDENTITY_PROVIDER | LTM_WIF_PROVIDERの出力 |
| GCP_DEPLOY_SERVICE_ACCOUNT | LTM_DEPLOY_SA |
| GCP_RUNTIME_SERVICE_ACCOUNT | LTM_RUNTIME_SA |
| CLOUD_RUN_URL | Cloud RunのベースURL。/api以下を付けない |
| LTM_MCP_TOKEN | Smoke用に発行したltm_...形式のPAT |

### Environment variables

| Variable | 値 |
|---|---|
| LTM_GCS_BUCKET | LTM_GCS_BUCKET。gs://は付けない |
| LTM_GCS_PREFIX | projects |
| FIREBASE_PROJECT_ID | LTM_PROJECT_ID |
| NEXT_PUBLIC_FIREBASE_API_KEY | Firebase Web appのapiKey |
| NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN | Firebase Web appのauthDomain |
| NEXT_PUBLIC_FIREBASE_PROJECT_ID | Firebase Web appのprojectId |
| NEXT_PUBLIC_FIREBASE_APP_ID | Firebase Web appのappId |
| MCP_PUBLIC_URL | Cloud RunのベースURL |
| MCP_ALLOWED_ORIGINS | 初期値はCloud RunのベースURLと同じ |
| LTM_CURATOR_USER_ID | shared writeを許可するFirebase UID |
| GCP_SECRET_LTM_MAINTENANCE_TOKEN | LTM_SECRET_ID。Secretの値ではない |

GitHub Actionsのgoogle-github-actions/authはサービスアカウントキーを使わず、WIFで認証します。実値をリポジトリ、Issue、ログへ書きません。

### curator workflow の設定

`.github/workflows/curator.yml` は Cloud Run deploy workflow とは別に、Repository secrets を読み取ります。curator の定期実行を有効にする場合は、次の3つも GitHub の Repository secrets に登録します。

- `MCP_PUBLIC_URL`: curator がアクセスする Cloud Run の MCP URL
- `LTM_MCP_TOKEN`: `/api/auth/tokens` で発行した curator 用 PAT
- `LTM_MAINTENANCE_TOKEN`: `LTM_SECRET_ID` の Secret Manager に登録した値と同じ値

`GCP_SECRET_LTM_MAINTENANCE_TOKEN` は Secret Manager の Secret ID を表す `production` Environment の variable であり、`LTM_MAINTENANCE_TOKEN` に値そのものを設定する用途とは異なります。トークンの実値はリポジトリや `.env` に保存しません。

## 11. 初回Cloud Run deployとURL確認

初回だけCloud Run URLが未確定です。Cloud Shellまたは開発コンテナで、リポジトリのcheckoutからworkflowと同じsource deployを実行します。

    gcloud run deploy long-term-memory \
      --source . \
      --project="$LTM_PROJECT_ID" \
      --region="$LTM_REGION" \
      --allow-unauthenticated \
      --min=0 --max=1 --concurrency=1 \
      --cpu=1 --memory=512Mi --timeout=300 \
      --service-account="$LTM_RUNTIME_SA" \
      --set-secrets="LTM_MAINTENANCE_TOKEN=$LTM_SECRET_ID:latest"

このコマンドは Cloud Run の URL を確定するための bootstrap deploy です。実際の利用開始前に、後述の GitHub Actions `production` Environment と同じ Firebase、GCS、MCP、Secret Manager の値を付けた deploy を実行してください。

初回deploy後にURLを取得します。

    export LTM_CLOUD_RUN_URL="$(gcloud run services describe long-term-memory \
      --project="$LTM_PROJECT_ID" \
      --region="$LTM_REGION" \
      --format='value(status.url)')"

    printf '%s\n' "$LTM_CLOUD_RUN_URL"

このURLを CLOUD_RUN_URL、MCP_PUBLIC_URL、MCP_ALLOWED_ORIGINS に設定し、workflowの本番環境変数を揃えてから、develop → main のRelease PRをマージします。main pushでverify、deploy、Cloud Run smokeが実行されます。

実際のFirebase/GCS環境変数を付けた最終deployは .github/workflows/cloud-run.yml の gcloud run deploy と同じ値を使います。

## 12. Smoke用FirebaseユーザーとPAT

Cloud RunのベースURLへFirebaseユーザーでサインインし、smokeプロジェクトを作成します。プロジェクト作成は、アプリの同一Originから次のように実行できます。

    await fetch('/api/projects', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({project_id: 'smoke'})
    }).then((response) => response.json())

同じユーザーでSmoke用PATを発行します。通常は画面から発行してください。

1. `https://<Cloud RunのベースURL>/settings/tokens` を開きます。
2. Firebaseでサインインした状態で、ラベル（例: `github-cloud-run-smoke`）を入力し、`PATを発行`を押します。
3. 表示されたPATを`PATをコピー`でコピーします。ブラウザの権限でコピーできない場合は、表示されたPAT本文を選択して手動でコピーします。
4. GitHub repositoryの Settings → Environments → `production` → `LTM_MCP_TOKEN` の Secretを更新します。値の前後に空白や改行を追加しません。

PAT本文は発行直後の画面で一度だけ表示され、再読み込みや画面遷移後には復元できません。PAT本文をチャット、repository、GitHub Actionsログ、ブラウザの共有ログへ貼り付けないでください。FirestoreにはPATのhashだけが保存されます。

画面が使えない場合だけ、同じCloud Run Originのブラウザ開発者コンソールでAPIを直接呼べます。`copy`はChrome DevToolsの組み込み関数です。自動コピーに失敗した場合は画面の手順を使い、PAT本文をログへ出力しないでください。

    const response = await fetch('/api/auth/tokens', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({label: 'github-cloud-run-smoke'})
    });
    const body = await response.json();
    if (!response.ok || typeof body.token !== 'string') throw new Error(JSON.stringify(body));
    copy(body.token);
    console.log('PAT発行成功。クリップボードへコピーしました。token_id:', body.token_id);

Firebase ConsoleのAuthentication → Usersからcurator用ユーザーのUIDを取得し、GitHub Environment variableの LTM_CURATOR_USER_ID に設定します。メールアドレスではなくFirebase UIDを使います。

## 13. 確認コマンド

    gcloud run services describe long-term-memory \
      --project="$LTM_PROJECT_ID" \
      --region="$LTM_REGION"

    gcloud storage ls "gs://$LTM_GCS_BUCKET/"

    gcloud firestore databases describe \
      --project="$LTM_PROJECT_ID" \
      --database='(default)'

    gcloud secrets describe "$LTM_SECRET_ID" \
      --project="$LTM_PROJECT_ID"

    gcloud iam workload-identity-pools providers describe "$LTM_WIF_PROVIDER_ID" \
      --project="$LTM_PROJECT_ID" \
      --location=global \
      --workload-identity-pool="$LTM_WIF_POOL_ID"

    firebase firestore:indexes \
      --project="$LTM_PROJECT_ID" \
      --database='(default)'

実環境smokeが成功するまで、docs/eval/cloud-run-smoke.json と切り替えチェックリストではCloud Run/Firebase/GCS接続を未完了として扱います。
