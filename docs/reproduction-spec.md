# long-term-memory 現行再現仕様書

この文書は、現在の `long-term-memory` を別環境で再現するための日本語の運用正本です。移行の設計判断と実装順序は、次の文書を補助資料として参照します。

- 設計: `docs/superpowers/specs/2026-09-19-cloud-run-firebase-s3-firestore-design.md`
- 実装計画: `docs/superpowers/plans/2026-09-19-cloud-run-firebase-s3-firestore-migration.md`

## 1. 目的と確定方針

旧Vercel/Turso/Blob/Redis/Clerkデータは移行せず破棄し、Cloud Run・Firebase Authentication・Amazon S3・Cloud Firestoreを空の状態から構築する。Cloud SQL、Redis、Firebase Cloud Storage、常駐worker、Cloud Schedulerは使わない。

運用費は「常時起動サービスの費用を発生させない」ことを目標にする。Cloud Runはscale to zero、FirestoreはStandard、S3は従量課金のため、アクセス量・保存量・ログ量が増えれば完全な金額ゼロにはならない。予算アラートと利用上限を必ず設定する。

## 2. 実行構成

| 層 | 正本・役割 |
|---|---|
| Cloud Run | Next.js単一コンテナ。Invokerは公開、アプリ層で`AUTH_REQUIRED=1`を強制する。Node.js 22、1 vCPU、512 MiB、min 0、max 1、concurrency 1、region `asia-northeast1` |
| Firebase Authentication | Webのemail/password・Google認証。サーバはFirebase Admin SDKでID token/session cookieを検証 |
| Firestore | project、membership、memory metadata、name index、tombstone、MCP PAT hashの永続保存 |
| S3 | Markdown本文のimmutable object。keyは `<prefix>/<project_id>/memories/<name>/<sha256>.md` |
| `/tmp` SQLite | FTS5・KG・検索用の再構築可能cache。コンテナ再起動で消える前提 |
| MCP | `POST /api/mcp?project_id=<slug>`。16 tools、PATは `Authorization: Bearer ltm_...` |

Markdown本文が唯一の本文正本であり、FirestoreとSQLiteへ本文全文を永続保存しない。Firestoreのmemory metadataはS3 keyとhashを持ち、reindex時にS3本文・hash・frontmatter・tombstoneを照合する。

## 3. 認証・認可

- ローカルは `AUTH_REQUIRED=0` で匿名開発を許可する。
- 本番は `AUTH_REQUIRED=1` とし、Firebase session cookieをHttpOnly・SameSite=Lax・Path=/で発行する。
- Cloud RunのInvoker IAMは公開にし、Firebase session、Firebase ID token、MCP PATによるアプリ層認証を必須にする。Cloud Run IAM認証を重ねるとブラウザのFirebase認証フローを遮断するため採用しない。
- API routeへ直接ID tokenを送る場合だけ `Authorization: Bearer <Firebase ID token>` を許可する。MCPはFirebase ID tokenではなくMCP PATを使う。
- PAT本文は発行レスポンスで一度だけ返し、FirestoreにはSHA-256 hash、prefix、所有UID、期限、失効日時だけを保存する。
- project accessはFirestore membershipで判定する。`__shared__` はread-onlyで、writeはFirebase UIDと `LTM_MAINTENANCE_TOKEN` の二重条件を満たすcuratorだけに限定する。
- Firestore client SDKからの直接read/writeは `firestore.rules` で全拒否し、Admin SDK経由だけでアクセスする。

## 4. 環境変数

実値は `.env.example` に書かず、Cloud RunではSecret ManagerまたはGitHub Actions environment secretから注入する。

### Cloud Run runtime

`LTM_STORAGE_DRIVER=cloud`、`AUTH_REQUIRED=1`、`PORT`、`LTM_S3_BUCKET`、`LTM_S3_PREFIX`、`AWS_REGION`、`FIREBASE_PROJECT_ID`、`NEXT_PUBLIC_FIREBASE_API_KEY`、`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`、`NEXT_PUBLIC_FIREBASE_PROJECT_ID`、`NEXT_PUBLIC_FIREBASE_APP_ID`、`MCP_PUBLIC_URL`、`MCP_ALLOWED_ORIGINS`、`LTM_CURATOR_USER_ID`、`LTM_MAINTENANCE_TOKEN` を設定する。

AWS access keyは可能ならCloud RunのSecret Managerから注入する。Firebase Adminのservice account JSONをrepositoryへ置かず、Cloud RunのApplication Default Credentialsを使う。

### ローカル

`LTM_STORAGE_DRIVER=local`、`AUTH_REQUIRED=0`、`LTM_LOCAL_USER_ID=local-user`、`PORT=3939`、`LTM_HOME=.long-term-memory` を使う。localのWeb/APIはこの合成UIDへ紐付け、Firebaseへ接続しない。Composeは `docker-compose.yml` を使用し、hostの `.long-term-memory` を `/data`へbind mountする。

## 5. データ保存契約

### S3

S3 objectはcontent hashを含むためimmutable writeを基本とする。adapterはkey traversal、absolute path、backslash、project scope外keyを拒否し、Putには`If-None-Match: *`を付ける。本文のhashはS3 metadataにも記録する。

### Firestore

project document配下にmembers、memories、names、tombstonesを持ち、PATは`mcpTokens/<token_hash>`に保存する。memory/name/tombstoneの変更はtransactionで行う。document size、transaction size、batch write上限を超える移行対象はimport前に拒否する。

### SQLite

SQLiteは `/tmp/long-term-memory/index.db` に作成し、WAL、foreign key、FTS5 trigram、既存KG tableを使う。save/update/search/KGはcacheを利用するが、cacheが空でもS3とFirestoreからreindexできる。SQLiteをバックアップや本文正本として扱わない。

## 6. API・MCP・UI

- `GET /api/health`: 認証不要のCloud Run health check。
- `/api/auth/session`: Firebase ID tokenを短期session cookieへ交換。余計なquery parameterは拒否。
- `/api/projects`、`/api/projects/:id/members`、`/api/auth/tokens`、`/api/memories/:id`: Firebase principalとFirestore membershipをservice呼び出し前に検証する。
- `/api/mcp`: requestごとにPAT、project access、shared maintenance条件を検証する。認証主体やproject stateをmodule globalへ保存しない。
- Web UIは `/sign-in` と `/sign-up` をpublicにし、Firebase client SDKのemail/password・Google providerを使う。Firebase公開設定は `/api/auth/config` からno-storeで取得でき、client bundleへ秘密値を埋め込まない。共有scopeでは編集・削除を表示しない。

MCP toolsは次の16個を維持する。

`list_memories_by_type`、`search_by_tag`、`find_related`、`search_memories`、`get_memory`、`get_memory_index`、`remember_user_fact`、`remember_reference`、`remember_session_summary`、`remember_feedback`、`remember_project_fact`、`update_memory`、`forget_memory`、`link_memories`、`list_projects`、`reindex`。

## 7. 初期セットアップと旧環境の扱い

1. 旧Vercel Project、Blob、Turso、Clerk、Redisのデータは移行せず破棄する。
2. 旧providerのcredential、環境変数、GitHub連携を削除する。新しいCloud Run/Firebase/S3/Firestoreの設定と混同しない。
3. Cloud Run、Firebase Authentication、Firestore、S3を新規作成し、空のプロジェクトとsmoke用ユーザーを用意する。
4. Cloud Run smokeでhealth、initialize、tools/list 16件、save、search、get、update、link、reindex、deleteを確認する。renameはMCP公開tool対象外のため`CloudMemoryService`の回帰テストで確認する。
5. 初期データは新環境で作成し、以後のバックアップ・復旧手順をrepository外へ保存する。

## 8. CI/CD

`.github/workflows/cloud-run.yml` はPR作成時とPRブランチへのpush時にtest・lint・production build・Docker buildだけを実行し、runtime secretを渡さない。mainへのPRマージで発生するpush、またはmainブランチからのmanual dispatchだけがWorkload Identity Federationでdeployする。deploy jobは `production` Environmentを使い、verify完了後にProduction deployを1本だけ実行する。`GCP_PROJECT_ID`、`GCP_WORKLOAD_IDENTITY_PROVIDER`、`GCP_DEPLOY_SERVICE_ACCOUNT`、`GCP_RUNTIME_SERVICE_ACCOUNT` はGitHub Environment secretから読み、非秘密のFirebase/S3設定はEnvironment variables、AWS keyとmaintenance tokenはSecret Manager secret参照でCloud Runへ注入する。Environmentの詳細は`docs/cloud-run-production-deployment.md`を参照する。

deploy設定は `gcloud run deploy` の `--min 0 --max 1 --concurrency 1 --cpu 1 --memory 512Mi --timeout 300` を初期値とする。Cloud Run URL、PAT、Firebase/S3 secretはproduction environmentからsmokeへ渡し、ログへ出力しない。

## 9. 検証コマンド

```bash
pnpm test
pnpm lint
pnpm exec tsc --noEmit
NODE_ENV=production pnpm build
git diff --check
docker compose -f .devcontainer/compose.yaml config --quiet
```

実環境へ接続するまで、Cloud Run smokeは「未実行」と報告する。旧データのmigration verifyは空スタート方針のため対象外とする。ローカルfake、unit test、production buildの成功だけで外部provider接続済みとは扱わない。
