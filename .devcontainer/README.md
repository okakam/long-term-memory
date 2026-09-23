# 開発コンテナのCodex / Google Cloud環境

この開発コンテナには、Node.js開発に加えてOpenAI Codex CLI、GitHub CLI（gh）、Google Cloud CLI（gcloud）、Firebase CLI、jq、xz-utilsを導入しています。Turso CLIは使用しません。

## 初回利用

1. VS Codeで「Dev Containers: Rebuild Container」を実行する。
2. ターミナルで次のバージョンを確認する。

       node --version
       pnpm --version
       codex --version
       gh --version
       gcloud --version
       firebase --version
       jq --version

3. Codexを起動し、表示された案内からChatGPTまたは利用可能な方法でサインインする。
4. GitHub操作が必要な場合は gh auth login を実行する。
5. Google Cloud操作が必要な場合は gcloud auth login --no-launch-browser を実行する。
6. FirebaseのRules/Indexesを操作する場合は firebase login --no-localhost を実行する。

Codex、gcloud、Firebase CLIの設定はnamed volumeへ保存され、コンテナ再作成後も再利用できます。APIキー、サービスアカウントJSON、PAT、maintenance tokenなどの認証情報はDockerfileやリポジトリへ記述しません。

## Google Cloud操作

プロジェクトをgcloudの既定値に設定します。

       export LTM_PROJECT_ID='実際のGCPプロジェクトID'
       gcloud config set project "$LTM_PROJECT_ID"
       gcloud auth list
       gcloud config get-value project

GCPリソース作成、IAM、GCS、Firestore、Secret Manager、Workload Identity Federationの手順は [Google Cloud CLI / Firebase 初期設定手順](../docs/google-cloud-cli-setup.md) を参照してください。

Cloud Run本番deployのGitHub Environment設定は [Cloud Run本番デプロイ環境](../docs/cloud-run-production-deployment.md) を参照してください。

ローカルのNode.jsアプリをGoogle APIへ接続する必要がある場合だけ、ユーザーADCを作成します。

       gcloud auth application-default login --no-launch-browser

通常のローカル開発は AUTH_REQUIRED=0 とlocal storageを使うため、ユーザーADCは必須ではありません。

## Firebase CLI操作

このリポジトリの firebase.json はFirestore RulesとIndexesを管理します。

       firebase projects:list
       firebase deploy --project="$LTM_PROJECT_ID" --only firestore
       firebase firestore:indexes --project="$LTM_PROJECT_ID" --database='(default)'

Firebase AuthenticationのWebアプリ登録、Email/Password・Google provider、Authorized domainsはFirebase Consoleで設定します。

## VS Code拡張機能

devcontainer.jsonの customizations.vscode.extensions に openai.chatgptを指定しています。既存のコンテナに反映するには、VS Codeで「Dev Containers: Rebuild Container」を実行してください。

## Codex MCP OAuth loopback callback

`codex mcp login long-term-memory`は、実行ごとに異なる`127.0.0.1`のcallback portを使います。`.devcontainer/devcontainer.json`ではVS Codeの`remote.autoForwardPorts`を有効にし、`remote.autoForwardPortsSource`を`process`にして、Codexが開くlistener processからportを検出できるようにしています。固定portやport rangeを`forwardPorts`へ追加しないでください。

設定を反映するには「Dev Containers: Rebuild Container」を実行します。ログイン中にPortsパネルで、その実行のcallback portが転送済みか確認してください。自動検出されない場合は、Codexのログイン処理が待機中に「Forward a Port」で、その実行のcallback portだけを一時転送します。古い実行のportは次のログインで再利用できません。

転送を確認したらブラウザーの「許可」は1回だけ押します。最初の承認POSTが成功するとtransactionとcookieは消費されます。callbackでCodexへ戻らず同じ画面を再送信すると`invalid_request`になるため、二度押しせず、必要なら古いログインを終了して新しい`codex mcp login long-term-memory`を開始してください。認証URLやcallback URLはcode/stateを含むため、Issueやログへ貼り付けないでください。

## バージョンと更新

Node.jsは22、pnpmは11.1.3を使用します。Google Cloud CLIとFirebase CLIはイメージbuild時に公式配布元からインストールします。CLIを更新する場合はDockerfileを変更してDev Containers: Rebuild Containerを実行してください。

## Codexのsandbox

compose.yamlのappサービスでは、Codex CLIのbwrapがnested namespaceを作成できるよう seccomp=unconfined を設定しています。これは開発用コンテナに限定した設定であり、本番コンテナへは適用しません。

compose.yamlを変更した後は、VS Codeの「Dev Containers: Rebuild Container」でコンテナを再作成してください。再接続後、bwrap --ro-bind / / true が成功すればnamespace設定を確認できます。
