# long-term-memory

Markdownを正本として扱う、MCP対応の長期記憶アプリケーションです。

## 現行構成

- Cloud Run: Next.jsアプリケーション。min 0、max 1、concurrency 1。
- Firebase Authentication: Webのemail/password・Google認証。
- Firestore: project、membership、memory metadata、name index、tombstone、MCP PAT hash。
- Google Cloud Storage (GCS): Markdown本文のimmutable object。Cloud RunからGCS APIでアクセスする。
- `/tmp` SQLite: FTS5・KG・検索用の再構築可能cache。

Cloud SQL、Redis、Upstash、Firebase StorageのクライアントSDK、Cloud Scheduler、常駐workerは使用しません。Cloud Runのscale to zeroを使って常時起動費を抑えますが、GCS・Firestore・ログ・Artifact Registryには従量課金があり得るため、完全な金額ゼロは利用量に依存します。

## ローカル開発

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

ローカルは `LTM_STORAGE_DRIVER=local`、`AUTH_REQUIRED=0`、port `3939` を使います。Dev Containerは `.devcontainer/compose.yaml` を利用します。

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
