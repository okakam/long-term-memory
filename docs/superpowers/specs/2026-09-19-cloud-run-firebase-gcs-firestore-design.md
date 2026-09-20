# Cloud Run / Firebase Authentication / GCS / Firestore 設計

**状態:** GCS構成で承認済み。旧S3案は採用しない。

## 1. 目的と確定構成

Vercelの実行・保存基盤を廃止し、Cloud Run、Firebase Authentication、Cloud Firestore、Google Cloud Storage（GCS）で長期記憶アプリを空の状態から構築する。Cloud RunからGCS APIを呼び出し、Firebase StorageのクライアントSDKによる直接アップロードは使わない。

```text
Cloud Run
  ├─ Next.js UI / REST API / MCP Streamable HTTP
  ├─ Firebase Admin SDKによるID token検証
  ├─ Firestore Admin SDKによるmetadata・認可・PAT管理
  ├─ @google-cloud/storageによるGCS Markdown adapter
  └─ /tmp SQLite FTS5・KG検索cache

Firebase Authentication: Webのemail/password・Google認証
Cloud Firestore: project、membership、memory metadata、name index、tombstone、MCP PAT hash
GCS: Markdown本文のimmutable object
```

### 採用しないもの

- Vercel、Vercel Blob、Clerk、Turso/libSQL remote、Redis/Upstash
- Amazon S3とAWS credential
- Firebase StorageクライアントSDKによるブラウザ直接保存
- Cloud SQL、Cloud Scheduler、常駐worker、Cloud Run永続ディスク
- Firestoreを本文全文や全文検索エンジンとして使うこと

## 2. 実行・認証構成

- Cloud RunはNode.js 22の単一コンテナで、初期値はregion `asia-northeast1`、min 0、max 1、concurrency 1、1 vCPU、512 MiB、timeout 300秒とする。
- Cloud Run Invokerは公開にし、WebとAPIはFirebase session/ID token、MCPはMCP PATでアプリ層認証する。
- Firebase Admin SDKとGCS clientはCloud RunランタイムサービスアカウントのApplication Default Credentialsを使う。サービスアカウントJSONやGCS HMAC keyはrepository・image・環境変数へ保存しない。
- FirestoreクライアントSDKからの直接read/writeは`firestore.rules`で拒否し、サーバーのAdmin SDKだけがデータへアクセスする。
- `/tmp`は再起動・scale-inで消える一時領域であり、SQLiteをバックアップや正本にしない。

## 3. GCS本文ストレージ契約

Markdown本文の正本はGCS objectとする。Firestore memory documentは本文を複製せず、GCS key、content hash、frontmatter由来のmetadataだけを持つ。

```text
<LTM_GCS_PREFIX>/<project_id>/memories/<name>/<sha256>.md
```

adapterの契約:

- `read`、`write`、`head`、`list`、`remove`を実装する。
- `project_id`、memory name、prefixを検証し、absolute path、backslash、`.`、`..`、scope外keyを拒否する。
- object metadataへ`content-sha256`を保存する。
- content hash keyへの新規writeはGCS世代番号の`ifGenerationMatch=0`を付け、既存objectを上書きしない。
- update/renameは新しいhash keyへ書き込み、Firestore transaction成功後に旧objectをbest-effort削除する。
- object削除に失敗した場合はFirestore tombstoneを残し、reindexで削除済み本文が復活しないようにする。
- GCS listのページングを処理し、結果をkey順に返す。

GCS bucketは非公開・uniform bucket-level accessを基本とし、Cloud Run runtime service accountへ対象bucketの必要なStorage IAMだけを付与する。prefix制限はアプリケーションのkey検証でも行う。

## 4. FirestoreとSQLiteの責務

Firestore document pathは次を基本とする。

```text
projects/{projectId}
projects/{projectId}/memories/{memoryId}
projects/{projectId}/names/{encodedMemoryName}
projects/{projectId}/tombstones/{tombstoneId}
mcpTokens/{tokenHash}
```

Firestoreはmembership、memory/name index、tombstone、MCP PAT hashをtransactionまたはatomic batchで更新する。PAT本文は発行時だけ返し、Firestoreにはhash、prefix、owner UID、期限、失効日時だけを保存する。

SQLiteは`/tmp/long-term-memory/index.db`へ作成し、FTS5 trigram、BM25、KG、既存の検索・rerank・PPR契約を維持する。cacheが空または消失した場合は、Firestore metadataとGCS本文からreindexする。

## 5. 環境変数と秘密

Cloud Run runtime:

```text
LTM_STORAGE_DRIVER=cloud
AUTH_REQUIRED=1
PORT=8080
LTM_HOME=/tmp/long-term-memory
LTM_GCS_BUCKET=
LTM_GCS_PREFIX=projects
FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
MCP_PUBLIC_URL=
MCP_ALLOWED_ORIGINS=
LTM_CURATOR_USER_ID=
LTM_MAINTENANCE_TOKEN=
```

GCS・Firestoreの認証情報はCloud Run runtime service accountのADCで取得する。maintenance tokenだけをSecret Managerから注入し、実値はrepositoryへ保存しない。ローカルは`LTM_STORAGE_DRIVER=local`、`AUTH_REQUIRED=0`、`LTM_HOME=.long-term-memory`を使い、Firebase/GCSへ接続しない。

## 6. CI/CDと外部ゲート

- PRではtest、lint、production build、Docker build、container healthだけを実行し、Firebase/GCS/Firestoreの本番secretを渡さない。
- mainへのpushまたはmainからのmanual dispatchだけがWorkload Identity FederationでCloud Runへdeployする。
- deployは`production` Environmentで直列化し、runtime service accountを`--service-account`で指定する。
- Cloud Run smokeはhealth、MCP initialize、tools/list、save、search、get、update、link、reindex、deleteを実行し、renameはCloudMemoryServiceの回帰テストで検証する。
- devcontainer内のローカルDocker検証は行わず、GitHub Actions verifyのDocker buildとhealth checkを代替とする。
- GCP project、Firebase provider、Firestore、GCS bucket、IAM、GitHub Environment、Cloud Run smokeは外部資格情報が必要な未完了ゲートとして記録する。

## 7. データ方針

旧Vercel/Turso/Blob/Redis/Clerkデータは移行せず破棄し、新しいCloud Run/Firebase/GCS/Firestoreを空の状態から開始する。旧migration script、旧provider依存、AWS/S3 credentialはrepositoryと実行環境から残さない。

バックアップやsnapshotを運用する場合もGCS/Firestoreの明示的な手動手順としてrepository外へ保存し、常駐workerや自動スケジューラは追加しない。
