# Cloud Run / GCS ストレージ補正実装計画

> **エージェント作業者向け:** `superpowers:executing-plans`でこの計画をタスク単位に実行する。各手順はチェックボックスで追跡する。

**目的:** 誤って採用していたAmazon S3 Markdown backendをGoogle Cloud Storageへ置き換え、Cloud Run・Firebase Authentication・Cloud Firestoreの構成を維持する。

**構成:** Cloud RunはランタイムサービスアカウントのApplication Default Credentialsで公式`@google-cloud/storage` clientを使う。GCSはMarkdown本文のimmutableな正本、Firestoreはmetadata・membership・name index・tombstone・MCP PAT hash、`/tmp` SQLiteは検索cacheとする。

**正本設計:** `docs/superpowers/specs/2026-09-19-cloud-run-firebase-gcs-firestore-design.md`

## 全体制約

- Cloud Runを唯一のアプリケーション実行基盤として維持する。
- Firebase Authenticationはユーザー識別、Firestore Admin SDKはサーバー側metadata・認可を担当する。
- GCS object keyは`<prefix>/<project_id>/memories/<name>/<sha256>.md`とする。
- GCS writeは既定で`ifGenerationMatch=0`を付け、content hash objectを上書きしない。
- Cloud RunはADCとIAMを使い、AWS credential、service-account key、実在`.env`はcommitしない。
- PR/branch CIへ本番GCS・Firebase・Firestore・MCP secretを渡さない。
- ローカルDocker検証はdevcontainer内では行わず、GitHub Actionsのcontainer health checkを使う。

### タスク1: GCS adapter契約を失敗テストで固定する

**対象:** `tests/storage/s3-markdown.test.ts`を`tests/storage/gcs-markdown.test.ts`へ置換し、後続で`src/lib/storage/gcs-markdown.ts`を追加する。

- [x] S3 command assertionをGCS file API、generation precondition、metadata、pagination、scope assertionへ置き換えた。
- [x] `./node_modules/.bin/vitest run tests/storage/gcs-markdown.test.ts`を実行し、adapter未実装によるREDを確認した。

### タスク2: GCS Markdown adapterとfactoryを実装する

**対象:** `src/lib/storage/gcs-markdown.ts`、`src/lib/storage/factory.ts`、`tests/storage/gcs-markdown.test.ts`

- [x] key validation、`gcsStoragePrefix`、`memoryPrefix`、`memoryObjectKey`を実装した。
- [x] `@google-cloud/storage`のread/write/head/list/removeを実装し、immutable writeに`preconditionOpts.ifGenerationMatch=0`を使った。
- [x] fake GCS clientを注入したstorage testとfactory testを通過させた。

### タスク3: CloudMemoryServiceをGCS用語へ移行する

**対象:** `src/lib/memory/cloud-service.ts`、`tests/lib/memory/cloud-service.test.ts`

- [x] S3 import、prefix field、key helper、comment、test descriptionをGCSへ置き換えた。
- [x] Firestore transaction、tombstone、compensation、reindex、SQLite cacheの契約を維持した。
- [x] CloudMemoryService testと全unit testを通過させた。

### タスク4: 依存関係・環境変数・Cloud Run deployを置き換える

**対象:** `package.json`、`pnpm-lock.yaml`、`.env.example`、`.github/workflows/cloud-run.yml`、`tests/deps.test.ts`、`tests/deploy/task8.test.ts`、`scripts/curator/export-remote-snapshot.ts`

- [x] `@aws-sdk/client-s3`を削除し、直接依存として`@google-cloud/storage`を追加した。
- [x] `LTM_S3_BUCKET`、`LTM_S3_PREFIX`、`AWS_REGION`、AWS secretを`LTM_GCS_BUCKET`、`LTM_GCS_PREFIX`とCloud Run ADCへ置き換えた。
- [x] Cloud Run runtime service accountのGCS IAMを使い、maintenance tokenだけをSecret Managerから注入するWorkflowへ更新した。
- [x] runtime source、環境変数、WorkflowにAWS/S3の参照が残っていないことを確認した。

### タスク5: 仕様・運用文書・評価台帳を更新する

**対象:** 設計書、`AGENTS.md`、`README.md`、`docs/reproduction-spec.md`、`docs/cloud-run-production-deployment.md`、cutover checklist、評価台帳

- [x] architecture、environment、IAM、cost、setup、verification、acceptanceをGCS/ADC/IAM前提へ更新した。
- [x] Firebase Storage client SDKではなく、Cloud Run backendがGCS APIを利用する方針を記録した。
- [x] fresh-start/no-migrationとno-local-Dockerの決定を維持した。

### タスク6: 検証と既存PRブランチの更新

- [x] 全test 67 files・193 tests、lint、TypeScript、production build、lockfile install、`git diff --check`、JSON検証を実行した。
- [x] `feature/cloud-run-container-health`のworktreeをGCS構成へ更新した。
- [ ] commitと既存PR #12へのpushを実行する。
