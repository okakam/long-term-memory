# long-term-memory

Markdownを正本として扱う、MCP対応の長期記憶アプリケーションです。

## 現行構成

- Cloud Run: Next.jsアプリケーション。min 0、max 1、concurrency 1。
- Firebase Authentication: Webのemail/password・Google認証。
- Firestore: project、membership、memory metadata、name index、tombstone、MCP PAT hash。
- Amazon S3: Markdown本文のimmutable object。
- `/tmp` SQLite: FTS5・KG・検索用の再構築可能cache。

Cloud SQL、Redis、Upstash、Firebase Cloud Storage、Cloud Scheduler、常駐workerは使用しません。Cloud Runのscale to zeroを使って常時起動費を抑えますが、S3・Firestore・ログ・Artifact Registryには従量課金があり得るため、完全な金額ゼロは利用量に依存します。

## ローカル開発

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

ローカルは `LTM_STORAGE_DRIVER=local`、`AUTH_REQUIRED=0`、port `3939` を使います。Docker Composeを使う場合は `docker-compose.yml` を利用します。

## 検証

```bash
pnpm test
pnpm lint
pnpm exec tsc --noEmit
NODE_ENV=production pnpm build
```

Cloud Runの実環境smoke、S3/Firestoreへの実データ移行、Vercel Project削除は外部資格情報が必要です。未実行の外部ゲートをローカルテスト成功だけで完了扱いにしません。ローカルではsmoke scriptの主要MCP経路を回帰検証し、renameはMCP公開toolではないため`CloudMemoryService`のテストで検証します。

## 移行

設計と手順は次を正本とします。

- [現行再現仕様書](docs/reproduction-spec.md)
- [設計書](docs/superpowers/specs/2026-09-19-cloud-run-firebase-s3-firestore-design.md)
- [実装計画](docs/superpowers/plans/2026-09-19-cloud-run-firebase-s3-firestore-migration.md)
- [切り替えチェックリスト](docs/migration/cloud-run-cutover-checklist.md)

旧Vercel/Turso/Blobからのexportは `scripts/migration/` に一時的に残しています。migration verify、Cloud Run smoke、rollback期間の終了を確認するまで、旧credentialとmigration専用依存を削除しません。
