# Cloud Run / Firebase Authentication / S3 / Firestore 移行設計

**状態:** アーキテクチャ承認済み、実装計画作成前のレビュー対象

**目的:** Vercel公開構成を廃止し、Cloud Runを実行基盤、Firebase Authenticationを認証、Amazon S3をMarkdown本文の正本、Cloud Firestoreをメタデータ・認可・MCP PATの永続ストアとして再構成する。

## 1. 決定事項

### 1.1 採用する構成

    Cloud Run
      ├─ Next.js UI / REST API / MCP Streamable HTTP
      ├─ Firebase Admin SDK によるID token検証
      ├─ Firestore adapter
      ├─ S3 adapter
      └─ /tmp の再構築可能な SQLite FTS5 キャッシュ

    Firebase Authentication
      └─ メール/パスワードとGoogle認証

    Firestore
      ├─ project metadata / membership
      ├─ memory metadata / name index
      ├─ tombstone
      └─ MCP PAT hash

    Amazon S3
      ├─ Markdown本文
      ├─ export / snapshot
      └─ 孤児オブジェクトの保持先

### 1.2 採用しないもの

- Vercel、Vercel Blob、Vercel Protection Bypass
- Clerk
- Turso / libSQL remote database
- Cloud SQL PostgreSQL
- Redis / Upstash Redis
- Firestoreを全文検索エンジンとして使うこと
- Firebase Cloud Functions、Cloud Scheduler、Cloud Tasks、常駐worker
- Firebase Cloud Storage
- Cloud Runの永続ディスク
- 本番コンテナ内のClaude CLI

### 1.3 コスト制約

- Cloud Runは min instances=0、max instances=1、concurrency=1 とする。
- Cloud RunのCPUとメモリは最小構成から開始し、初期値は1 vCPU / 512 MiBとする。
- Firestoreは無料枠内で収まる小規模利用を前提にし、PITR、バックアップ、TTL削除を使わない。
- S3はStandardストレージを使い、本文以外の不要な複製を作らない。
- データ保全用のスナップショットは手動またはGitHub Actionsの明示実行だけにする。常時スケジュールは作らない。
- 無料枠超過を完全に防げるわけではないため、GCPとAWSの請求アラートを設定する。

## 2. 維持する機能契約

次の機能は移行後も維持する。

- Markdownをデータモデルの正本とすること
- 5種類のmemory type
- 16個のMCP toolと POST /api/mcp?project_id=<slug> のURL契約
- project単位のパーティションと __shared__ スコープ
- SQLite FTS5 trigram、bm25、PPR、RRF、時間減衰、supersession
- REST APIによるproject・memory操作
- 検索画面、memory詳細・編集・削除、KGグラフ
- Claude Codeのskill、hook、CLAUDE.md埋め込み資産
- JST表示、UTC ISO内部時刻、名前・project slugの検証
- reindex、reconcile、content hash検証、削除tombstone
- UI / REST / MCPのproject membership認可

運用コスト削減のため、永続Telemetry DBとそれを前提にした運用ダッシュボードは第一移行で削除する。Cloud Runの標準ログへ、秘密情報を除いた最小限のリクエスト結果だけを出力する。

## 3. データ所有権と整合性

### 3.1 S3の責務

S3はユーザーが保存したMarkdown本文の正本である。Firestoreのmemory documentは本文そのものではなく、本文を参照するための派生メタデータである。

キーは既存のcontent hash形式を維持する。

    <LTM_S3_PREFIX>/<project_id>/memories/<name>/<sha256>.md
    <LTM_S3_PREFIX>/snapshots/<timestamp>.tar.gz
    <LTM_S3_PREFIX>/migration/<migration_id>/...

project_id、name、prefixは既存のtraversal検証を通す。S3オブジェクトには content-sha256 metadataを付与し、ETagを本文ハッシュの代用品として扱わない。

### 3.2 Firestoreの責務

FirestoreはCloud Run間で共有する小さな制御情報を保持する。

    projects/{projectId}
    projects/{projectId}/memories/{memoryId}
    projects/{projectId}/names/{encodedMemoryName}
    projects/{projectId}/tombstones/{tombstoneId}
    mcpTokens/{tokenHash}

projects/{projectId}:

    {
      project_id: string,
      owner_user_id: string,
      member_user_ids: string[],
      member_roles: Record<string, "owner" | "member">,
      created_at: string,
      updated_at: string,
      revision: number
    }

projects/{projectId}/memories/{memoryId}:

    {
      id: string,
      project_id: string,
      name: string,
      type: "user" | "feedback" | "project" | "reference" | "session",
      description: string,
      body_chars: number,
      content_key: string,
      content_hash: string,
      tags: string[],
      links: string[],
      supersedes: string[],
      entities: Array<{ name: string, aliases: string[] }>,
      triples: Array<[string, string, string]>,
      created_at: string,
      updated_at: string
    }

names/{encodedMemoryName}はproject内の名前の一意性を保証するための予約ドキュメントである。renameは旧name documentと新name documentとmemory documentを1つのFirestore transactionで置き換える。

tombstones/{tombstoneId}は削除済みS3 keyとmemory idを記録する。S3 deleteが失敗しても、後続のreindexで削除済み本文が復活しないようにする。

mcpTokens/{tokenHash}:

    {
      id: string,
      user_id: string,
      token_prefix: string,
      label: string,
      audience: "mcp",
      created_at: string,
      last_used_at: string | null,
      expires_at: string | null,
      revoked_at: string | null
    }

平文PATは保存しない。hashをdocument IDとして直接取得し、token hashの検索queryを不要にする。

### 3.3 書き込み順序

新規保存・更新は次の順序で行う。

1. MemorySchema検証、Markdown serialize、SHA-256計算を行う。
2. immutableな新S3 objectを作成する。
3. Firestore transactionでname indexとmemory documentを作成または更新する。
4. transaction成功後に古いS3 objectをbest-effortで削除する。
5. Cloud Run内のSQLiteキャッシュを更新する。

Firestore transactionが失敗した場合、新S3 objectは孤児になるが、既存の可視状態は変えない。削除失敗の場合、tombstoneが本文の再出現を防ぐ。孤児のGCは、管理者が明示実行するmigration/maintenance scriptだけで行う。

Firestore transactionは競合時に再試行されるため、Redis lockは不要とする。Cloud Runの同時実行は1に固定するが、旧revisionと新revisionの一時共存にもFirestore側のrevision/name transactionで対応する。

### 3.4 再indexとreconcile

- 通常起動時はFirestoreのactive memory documentsを読み、参照先S3本文を読み込んでSQLite FTS5を再構築する。
- reconcileはFirestore metadataのcontent hashとS3本文を照合する。
- reindexは対象project prefixのS3 objectを列挙し、MarkdownをparseしてFirestore memory/name documentを再構築する。
- 不正な1ファイルはそのファイルだけを記録してスキップし、他のproject/memoryの再構築を中断しない。
- tombstoneに一致する削除済みkeyはFirestoreへ復活させない。
- SQLiteは常に削除して再作成可能なcacheであり、正本として扱わない。

## 4. 認証・認可

### 4.1 Web認証

- ブラウザはFirebase Web SDKでsign-in/sign-upを行う。
- 初期providerはemail/passwordとGoogleに限定する。
- 電話番号/SMS認証はコスト発生要因のため対象外とする。
- ログイン後、Firebase ID tokenをCloud Runのsession endpointへ送り、HttpOnly/Secure/SameSite cookieを発行する。
- Cloud Runのroute helperはsession cookieまたはBearer ID tokenをFirebase Admin SDKで検証する。
- AUTH_REQUIRED=0はlocalhostのみで許可し、本番Cloud Runは AUTH_REQUIRED=1 とする。

### 4.2 MCP認証

- MCP clientは既存形式の Authorization: Bearer ltm_... を使う。
- PATのhashとmetadataはFirestoreへ保存する。
- 発行時だけ平文tokenを返し、以後は表示しない。
- 失効・期限切れ・audience不一致を401にする。
- PATのproject membershipはFirebase UIDに対してFirestoreで検証する。

### 4.3 shared scope

- __shared__の読み取りは認証済みprincipalに許可する。
- __shared__への書き込みは、curator Firebase UIDと LTM_MAINTENANCE_TOKEN の両方を要求する。
- maintenance tokenはS3/Firestoreへ保存せず、Cloud Run secretとして注入する。
- tokenをURL、ログ、telemetry、エラーメッセージへ出さない。

### 4.4 Webセキュリティ

- REST書き込み、project作成、PAT発行/失効はsame-originを検証する。
- MCP OPTIONSはMCP_ALLOWED_ORIGINSの明示allowlistだけを許可する。
- * wildcard CORSは使わない。
- Firestoreはブラウザから直接利用せず、Cloud RunのAdmin SDK経由に限定する。Firebase client SDKはAuthenticationだけに使う。

## 5. Cloud Run実行設計

### 5.1 コンテナ

既存のNext.js DockerfileをCloud Run用に整理する。

- listen addressは 0.0.0.0
- portはCloud Runの PORT を使い、既定値は8080
- LTM_HOMEは /tmp/long-term-memory
- /tmpはcacheと一時export専用
- better-sqlite3をproduction imageへ含める
- migration専用依存をruntime imageへ含めない
- health endpointを追加し、S3/Firestoreの秘密値や本文を返さない

### 5.2 Cloud Run設定

初期設定:

    min instances: 0
    max instances: 1
    concurrency: 1
    cpu: 1
    memory: 512MiB
    request timeout: 300s
    region: asia-northeast1

Cloud RunのInvoker IAMは公開にし、WebのFirebase認証とMCP PAT認証はアプリ層で実施する。`AUTH_REQUIRED=1`を本番既定値とし、Cloud Run IAM認証を重ねない。

max instancesは費用上限であり、revision切り替え中の一時的な旧revision共存を完全に否定しない。データ整合性はFirestore transactionとS3 immutable objectで守る。

### 5.3 SecretとIAM

- Firebase Admin SDKはCloud RunのサービスアカウントとApplication Default Credentialsを使う。
- S3 access keyはGCP Secret ManagerからCloud Runへ注入する。
- S3 IAM policyは対象bucketとLTM_S3_PREFIXに限定し、GetObject、PutObject、DeleteObject、ListBucketだけ許可する。
- Firebase client configは公開値として扱うが、Admin credentialをブラウザへ渡さない。
- GitHub ActionsはGCP Workload Identity Federationを使い、長期GCP JSON keyをrepository secretへ置かない。

## 6. 既存コードからの変更境界

### 6.1 置換・追加

- src/lib/storage/s3-markdown.ts: AWS SDK v3によるS3 Markdown adapter
- src/lib/storage/firestore-metadata.ts: project、memory metadata、name index、tombstone、PATのFirestore adapter
- src/lib/storage/sqlite-index.ts: Cloud Runの /tmp に作る再構築可能SQLite adapter
- src/lib/auth/firebase.ts: Firebase Admin初期化とID token検証
- src/lib/auth/session.ts: HttpOnly session cookieの発行・検証・失効
- src/lib/auth/firebase-client.ts: browser Firebase app/Auth初期化
- src/lib/auth/firestore-store.ts: 既存AuthStore相当のFirestore実装
- src/app/api/auth/session/route.ts: session cookie endpoint
- src/app/api/auth/config/route.ts: browserへFirebase公開設定をruntime提供するendpoint
- src/app/api/health/route.ts: Cloud Run health endpoint
- scripts/migration/export-vercel.ts: 旧Blob/Tursoからの一回限りexport
- scripts/migration/import-s3-firestore.ts: S3/Firestoreへの検証付きimport
- scripts/migration/verify-migration.ts: 件数、hash、parse、権限、tombstoneの照合
- .github/workflows/cloud-run.yml: test/build/deploy/smoke
- firebase.json、firestore.rules、firestore.indexes.json: Firebase設定

### 6.2 既存ロジックの維持

- src/lib/markdown/frontmatter.ts
- src/lib/memory/types.ts
- src/lib/memory/service.tsの検索・KG・rerank契約
- src/lib/graph/*
- src/lib/mcp/*のtool schemaとtool名
- src/app/api/mcp/route.tsのJSON-RPC/MCP契約
- UIのmemory/project/graph構成

Remote serviceはS3/Firestore/SQLite adapterを組み合わせる実装へ置き換えるが、公開methodの入力・出力・エラー契約は維持する。

### 6.3 削除

- src/lib/storage/blob-markdown.ts
- src/lib/auth/web-principal.tsへ置換済みの旧Clerk helper
- Cloud modeで呼び出さないlocal auth connection/schema/migrateはlocal開発用として残す
- src/lib/storage/turso-index.tsと旧Blob adapterは実データmigration verifyまで一時的に残し、その後削除する
- src/lib/lock/project-lock.tsのRedis経路
- src/lib/telemetry/connection.ts、store.ts、schema.sql、永続dashboard依存
- vercel.json
- .github/workflows/vercel.yml
- scripts/vercel-smoke.ts
- scripts/probe-turso.ts
- docs/vercel-operations.md
- docs/mcp-config.vercel.json
- Clerk sign-in/sign-up component依存

local filesystem adapter、Docker Compose、offline curatorは残す。remote curatorはCloud Run MCP URLへ切り替える。

## 7. 環境変数契約

### ローカル

    LTM_STORAGE_DRIVER=local
    AUTH_REQUIRED=0
    LTM_HOME=.long-term-memory
    PORT=3939
    LTM_TELEMETRY=0

### Cloud Run

    LTM_STORAGE_DRIVER=cloud
    AUTH_REQUIRED=1
    PORT=8080
    LTM_HOME=/tmp/long-term-memory
    LTM_S3_BUCKET=
    LTM_S3_PREFIX=projects
    AWS_REGION=ap-northeast-1
    AWS_ACCESS_KEY_ID=
    AWS_SECRET_ACCESS_KEY=
    FIREBASE_PROJECT_ID=
    MCP_PUBLIC_URL=https://<cloud-run-url>
    MCP_ALLOWED_ORIGINS=https://<cloud-run-url>
    LTM_CURATOR_USER_ID=
    LTM_MAINTENANCE_TOKEN=

Firebase Web SDKの公開設定はNEXT_PUBLIC_FIREBASE_*としてビルド時または実行時に注入する。Admin credential JSONはrepositoryとimageへコピーしない。

旧Vercel/Turso/Blob/Upstash/Clerkの環境変数は、移行完了後にCloud Run環境からもGitHub Secretsからも削除する。

## 8. CI/CDと運用

### 8.1 Pull Request時

- install、test、lint、TypeScript検査、production build
- Docker build
- S3/Firestoreへアクセスしない単体テスト
- secretsをPR由来コードへ渡さない

### 8.2 mainへのdeploy

- GitHub ActionsがGCPへWorkload Identity Federationで接続する。
- Cloud Runへcandidate revisionをdeployする。
- 認証不要のhealth checkを実行する。
- 専用MCP PATを使ったinitialize、tools/list、save、search、get、delete smokeを実行する。
- smoke成功後だけ全trafficを新revisionへ切り替える。
- 旧revisionと新revisionが共存しても、Firestore transactionで競合が検出されることを確認する。

### 8.3 定常運用を増やさない

- Cloud Schedulerを使わない。
- curatorはGitHub Actionsの手動workflowまたはローカル実行とする。
- S3孤児GCは自動常駐させず、DRY_RUN=1確認後に明示実行する。
- Firestoreのバックアップ機能やTTLを使わず、必要時はS3 exportを明示実行する。

## 9. 移行とVercel削除

### 9.1 事前条件

- 旧Vercel Projectを削除しない。
- Vercel Blobの全Markdown objectをexportする。
- Turso memory/auth DBからmetadata、membership、PAT hash、tombstoneをexportする。
- Clerk user IDとFirebase UIDの対応表を作る。
- export manifestへ件数、key、SHA-256、project、nameを記録する。

### 9.2 データimport

1. Firebase Authenticationへユーザーを作成または既存UIDを確認する。
2. Clerk IDからFirebase UIDへmembershipとPAT ownerを変換する。
3. S3へMarkdownをimmutable keyでimportする。
4. Firestoreへproject、membership、memory metadata、name index、tombstoneをimportする。
5. import後にS3本文を再parseし、Firestore content hashと照合する。
6. Cloud RunのreindexでSQLite FTS5とKGを再構築する。

既存PATはhashを移せる場合だけ維持する。平文が必要な形式へ変更する場合は、移行後にユーザーへ再発行を要求する。

### 9.3 切り替え

1. 旧Vercelへmaintenance/read-only設定を入れる。
2. 旧Vercelの書き込みを停止する。
3. 最終exportを実行する。
4. S3/Firestoreへ差分importする。
5. Cloud Run smokeとUI session smokeを通す。
6. Claude Code MCP URL、curator設定、README内の接続先をCloud Runへ変更する。
7. 旧Vercel URLへの書き込みが拒否されることを確認する。

### 9.4 Project削除

次の全条件が満たされるまでVercel Projectを削除しない。

- S3の件数とSHA-256が旧exportと一致する
- Firestoreのproject/member/PAT確認が完了する
- Cloud Runで全MCP tool smokeが成功する
- UIのsign-in、project一覧、memory編集、削除、graphが成功する
- reindex後もmemory件数と検索結果が一致する
- S3から1件を手動復元できる
- Claude CodeとcuratorがCloud Runだけを使用している
- Vercel側の残存secret、domain、integrationを一覧確認した

削除直前にS3へ最終snapshotを保存し、Vercel Project削除後は復旧不能であることを明示確認する。削除操作自体は、移行検証完了後に管理者がVercel Consoleまたは認証済みCLIで明示実行する。

## 10. テスト受け入れ条件

### 10.1 adapter

- S3のread/write/list/delete、prefix traversal拒否、content hash検証
- Firestore transactionのsave/update/rename/delete競合
- name indexの重複拒否とrename一貫性
- PAT hash-only保存、期限切れ、失効、再利用拒否
- tombstone後のreindexで削除memoryが復活しない
- SQLite cacheを削除してS3/Firestoreから再構築できる

### 10.2 認証・認可

- Firebase未認証UI/APIが401またはsign-in redirectになる
- member外projectが403になる
- __shared__ readは許可、writeはcurator UIDとmaintenance tokenの両方が必要
- CSRF/CORS allowlistが機能する
- token、本文、secretがログに出ない

### 10.3 E2E

- Firebase sign-in
- PAT発行
- MCP initialize/tools/list
- save/search/get/update/rename/link/reindex/delete
- project membership
- shared read/write gate
- Cloud Run cold start後の検索
- 旧revision共存相当のFirestore競合
- S3/Firestore障害時に既存の可視状態を壊さない

### 10.4 既存回帰

既存69テスト相当の機能契約を維持し、Vercel/Turso/Blob/Redis/Clerk固有テストは同等のS3/Firestore/Firebase/Cloud Runテストへ置き換える。完了判定は pnpm test、lint、TypeScript検査、NODE_ENV=production pnpm build、Docker build、migration verify、Cloud Run smokeの全成功とする。

## 11. リスクと明示的な制限

- S3とFirestoreは2つの外部サービスなので、本文object作成とmetadata transactionの間に孤児objectが発生し得る。tombstoneと明示GCで管理する。
- Firestore無料枠は日次でリセットされ、超過分は課金対象になる。本文をFirestoreへ保存せず、読み書き回数を抑える。
- Cloud Run max instances=1は可用性を犠牲にする。高負荷・高可用性・大規模共同編集は非目標とする。
- Firestore Standardのdocument size・transaction size・batch write上限を超える大規模projectは対象外とし、migration verifyで事前検出する。
- Firestoreを検索エンジンへ拡張しない。将来検索規模が増えた場合は、別プロジェクトとして検索基盤を再設計する。

## 12. 参照する既存契約

- docs/reproduction-spec.md: Markdown、memory、MCP、REST、UI、検索、テストの正本
- docs/superpowers/plans/2026-09-05-vercel-long-term-memory.md: 旧Vercel実装の変更履歴と受け入れ観点
- AGENTS.md: 日本語ドキュメント、secret非コミット、build/test、diff checkの規則

この設計書は上記文書のうち、Vercel公開方式、Clerk認証、Turso/Blob/Redis運用をCloud Run/Firebase/S3/Firestoreへ置き換える。MCP/UI/Markdown/検索の機能契約は変更しない。
