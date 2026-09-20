# Cloud Run・Firebase・GCS・Firestore移行実装計画

このファイルは、旧S3案を含んでいた計画をGCS構成へ切り替えた履歴上の計画名を維持するための入口である。現在の実装タスクと検証手順は、次の補正計画を正本とする。

- 設計: `docs/superpowers/specs/2026-09-19-cloud-run-firebase-gcs-firestore-design.md`
- 現行補正計画: `docs/superpowers/plans/2026-09-20-cloud-run-gcs-storage.md`

## 確定アーキテクチャ

- Cloud Run: Next.js UI、REST API、MCPを実行する単一コンテナ。
- Firebase Authentication: Webのユーザー認証。
- Cloud Firestore: project、membership、memory metadata、name index、tombstone、MCP PAT hash。
- Google Cloud Storage: Markdown本文のimmutable object正本。
- `/tmp` SQLite: FTS5・KG・検索用の再構築可能cache。

Cloud Runは`@google-cloud/storage`とApplication Default CredentialsでGCSへアクセスする。Firebase StorageのクライアントSDK、Amazon S3、AWS credentialは使用しない。

## 実装状況

旧Vercel/Turso/Blob/Redis/Clerkのデータは移行せず、空スタートとする。旧migration専用資産も削除済みであり、現在はGCS adapter、Cloud Run設定、ドキュメント、CIのGCS前提への統一を`2026-09-20-cloud-run-gcs-storage.md`で実施する。

実環境のGCP/Firebase/GCS/Firestore設定、GitHub `production` Environment、Cloud Run smokeは、資格情報と外部リソース作成後に実施する。
