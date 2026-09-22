# long-term-memory

Markdownを正本として扱う、MCP対応の長期記憶アプリケーションです。

## 現行構成

- Cloud Run: Next.jsアプリケーション。min 0、max 1、concurrency 1。
- Firebase Authentication: Webのemail/password・Google認証。
- Firestore: project、membership、memory metadata、name index、tombstone、MCP PAT hash。
- Google Cloud Storage (GCS): Markdown本文のimmutable object。Cloud RunからGCS APIでアクセスする。
- `/tmp` SQLite: FTS5・KG・検索用の再構築可能cache。
- MCP: サーバー名は `long-term-memory`。Cloud Run endpointは `POST /api/mcp?project_id=<slug>` とし、Codexの設定例は下記、Claude Codeのremote curatorは [Cloud Run curator用MCP設定例](docs/mcp-config.cloud-run.json) を使用する。

Cloud SQL、Redis、Upstash、Firebase StorageのクライアントSDK、Cloud Scheduler、常駐workerは使用しません。Cloud Runのscale to zeroを使って常時起動費を抑えますが、GCS・Firestore・ログ・Artifact Registryには従量課金があり得るため、完全な金額ゼロは利用量に依存します。

## ローカル開発

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

ローカルは `LTM_STORAGE_DRIVER=local`、`AUTH_REQUIRED=0`、port `3939` を使います。Dev Containerは `.devcontainer/compose.yaml` を利用します。

## Cloud Run独自ドメイン

Cloud Runの公開URLは `https://ltm.okakam.net` とします。まずドメイン所有確認を行い、Cloud Runのドメインマッピングを作成します。

```bash
export LTM_GCP_PROJECT_ID='long-term-memory-prod'
export LTM_REGION='asia-northeast1'
export LTM_CUSTOM_DOMAIN='ltm.okakam.net'

gcloud domains verify okakam.net --project="$LTM_GCP_PROJECT_ID"
gcloud beta run domain-mappings create \
  --service=long-term-memory \
  --domain="$LTM_CUSTOM_DOMAIN" \
  --region="$LTM_REGION" \
  --project="$LTM_GCP_PROJECT_ID"
gcloud beta run domain-mappings describe \
  --domain="$LTM_CUSTOM_DOMAIN" \
  --region="$LTM_REGION" \
  --project="$LTM_GCP_PROJECT_ID" \
  --format='yaml(status.resourceRecords)'
```

`resourceRecords`に表示されたTXT・CNAME・A・AAAAレコードを、お名前.comのDNS設定へ登録します。`ltm.okakam.net`のホスト名は通常 `ltm` です。CNAMEが表示された場合も、値は推測せずCloud Runが返した値をそのまま使います。お名前.comのネームサーバーを使っていない場合は、実際のネームサーバー提供元で設定してください。

GitHubの `production` Environmentは、ドメインマッピングとHTTPSが確認できてから次の値へ変更し、mainのCloud Run deployを再実行します。

```text
MCP_PUBLIC_URL=https://ltm.okakam.net
MCP_ALLOWED_ORIGINS=https://ltm.okakam.net
CLOUD_RUN_URL=https://ltm.okakam.net
```

Cloud Runの直接ドメインマッピングはPreviewのため、本番での安定性・TLS要件が必要な場合はGlobal External Application Load BalancerまたはFirebase Hostingを前段に置きます。

## CodexへのCloud Run MCP設定

Cloud RunへデプロイしたMCPをCodex CLIから使う場合は、Cloud RunのベースURLと、`/settings/tokens`で発行したMCP PATを用意します。PAT本文は発行時に一度だけ表示されるため、チャット・repository・ログへ貼り付けず、Codex起動前のシェル環境など安全な場所から渡してください。

CodexのMCP設定は通常 `~/.codex/config.toml` に保存されます。まず通常のproject scopeを登録します（`MCP_PUBLIC_URL`は末尾の`/`を除いたCloud RunベースURL、`LTM_MEMORY_PROJECT_ID`はアクセス対象のproject slugです）。

```bash
export MCP_PUBLIC_URL='https://ltm.okakam.net'
export LTM_MEMORY_PROJECT_ID='your-project-slug'
export LTM_MCP_TOKEN='ltm_発行済みPAT'

codex mcp add long-term-memory \
  --url "${MCP_PUBLIC_URL%/}/api/mcp?project_id=${LTM_MEMORY_PROJECT_ID}" \
  --bearer-token-env-var LTM_MCP_TOKEN
```

このリポジトリの `docs/mcp-config.cloud-run.json` は、GitHub ActionsのClaude Code remote curatorが `--mcp-config` で読み込む共有scope (`project_id=__shared__`) の設定例です。Codexの `~/.codex/config.toml` にそのまま追加する設定ではありません。curator用JSONにはPATとmaintenance tokenの環境変数参照を記載し、実際の値はGitHub Actions Secretから渡します。

登録後は次で確認し、すでに起動中のCodexは再起動します。TUIでは `/mcp` でも接続中のサーバーを確認できます。

```bash
codex mcp list
codex mcp get long-term-memory
```

`~/.codex/config.toml` を直接編集する場合は、次のサーバー名と環境変数参照にします。

```toml
[mcp_servers.long-term-memory]
url = "https://ltm.okakam.net/api/mcp?project_id=your-project-slug"
bearer_token_env_var = "LTM_MCP_TOKEN"
```

`docs/mcp-config.cloud-run.json`の`${MCP_PUBLIC_URL}`や`${LTM_MCP_TOKEN}`は説明用のプレースホルダーです。CodexのURLには実際のCloud Run URLを設定し、認証値は `bearer_token_env_var` から環境変数名だけを参照させます。`~/.codex/config.toml`、PAT、maintenance tokenをrepositoryへコミットしないでください。詳細は[OpenAI公式のMCP設定手順](https://developers.openai.com/docs/extend/mcp)と[Cloud Run本番デプロイ手順](docs/cloud-run-production-deployment.md)を参照してください。

## 検証

```bash
pnpm test
pnpm lint
pnpm exec tsc --noEmit
NODE_ENV=production pnpm build
```

Cloud Runの実環境smokeは外部資格情報が必要です。ローカルテスト成功だけで外部provider接続済みとは扱いません。ローカルではsmoke scriptの主要MCP経路を回帰検証し、renameはMCP公開toolではないため`CloudMemoryService`のテストで検証します。

## 初期セットアップ

設計と手順は次を正本とします。

- [現行再現仕様書](docs/reproduction-spec.md)
- [Google Cloud CLI / Firebase 初期設定手順](docs/google-cloud-cli-setup.md)
- [設計書](docs/superpowers/specs/2026-09-19-cloud-run-firebase-gcs-firestore-design.md)
- [実装計画](docs/superpowers/plans/2026-09-20-cloud-run-gcs-storage.md)
- [切り替えチェックリスト](docs/migration/cloud-run-cutover-checklist.md)

旧Vercel/Turso/Blobのデータは移行せず破棄し、新しいCloud Run/Firebase/GCS/Firestore環境を空の状態から開始します。旧providerのmigration専用スクリプトと依存は削除済みです。
