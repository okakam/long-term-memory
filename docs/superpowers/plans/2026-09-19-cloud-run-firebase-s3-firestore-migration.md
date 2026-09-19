# Cloud Run・Firebase・S3・Firestore移行実装計画

> **エージェント作業者向け:** 必須サブスキルとして `superpowers:subagent-driven-development`（推奨）または `superpowers:executing-plans` を使い、この計画をタスク単位で実行する。各手順はチェックボックス（`- [ ]`）で追跡する。

**Goal / 目的:** 既存のlong-term-memoryをVercel/Turso/Blob/Redis/Clerk依存から切り離し、Cloud Run + Firebase Authentication + S3 + Firestoreで同じMCP/UI機能を低コスト運用できる状態へ移行する。

**Architecture / アーキテクチャ:** Markdown本文はS3のimmutable objectを正本とし、Firestoreはproject membership、memory metadata、name index、tombstone、MCP PAT hashだけを永続化する。Cloud Runはmin instances=0、max instances=1、concurrency=1で稼働し、SQLite FTS5は`/tmp`に再構築可能な検索cacheとして保持する。Firestore transactionでCloud Run revision間の競合を処理し、Redisは使わない。

**Tech Stack / 技術スタック:** Node.js 22.x、pnpm 11.1.3、Next.js 16.2.6、React 19.2.4、TypeScript 5、Vitest 4.1.6、`@modelcontextprotocol/sdk` 1.29.0、better-sqlite3、AWS SDK v3 S3 client、firebase、firebase-admin、gray-matter、ulid、zod、`@xyflow/react`、d3-force、react-markdown、Cloud Run、Firebase Authentication、Cloud Firestore、Amazon S3。

**Spec / 仕様書:** `docs/superpowers/specs/2026-09-19-cloud-run-firebase-s3-firestore-design.md`

## 実装進捗（2026-09-19）

Task 1〜10の主要実装、Task 9のfake targetによる冪等import/verify、tombstone移行、旧runtime整理まで完了している。追加レビューでCloud Run runtime環境注入、Firebase公開設定endpoint、rename時のFirestore tombstone整合性、起動時reindex競合テスト、SQLite cache失敗時のFirestore metadata補償、ローカル合成UID、Cloud Run imageの認証必須既定値、Firestore memory/name indexを含む双方向移行verify、rename部分書き込み時のtombstone隔離、Cloud Run smokeの主要MCP経路検証、Invoker公開とアプリ層認証の分離、Firestore document/request/write数のimport前preflight、旧Turso adapterのmigration専用隔離、Unicode本文長のmetadata統一、PAT更新時のFirestore直接参照を実装した。対応するコミットは `4251c82`、`9772f3b`、`6c9f38e`、`97acc9b`、`fb5a3c3`、`97beff3`、`bd31e2a`、`2cc330c`、`dc2d1a1`、`b95e897`、`d45bb54`、`897b836`、`4ad17a5`、`335892f`、`598cde3`、`2ab6096`、`e470f14`、`4676798`、`29a3f6d`、`ae42d35`、`aacaca2`、`7cd1335`、`ceb6f0f`、`a200755`、`261f741`、`2faff73`、`764ab2a`、`6710e57`、`109c39c`、`ae8bb8a`、`b8cbb77`、`e4fab0f`、`ccf7239`、`535fa32`、`01fbdeb`、`aa0cd52`、`fd5703f`、`ce6098c`、`da52505`、`6e71ae5`、`ec6fa87`、`5453523`、`94d0905`、`556448a` である。ローカルでは全テスト69 files・198 tests、lint、型検査、production buildが通過している。実AWS/Firebase/GCP接続、実データ移行verify、Cloud Run smoke、旧Vercel Project削除は外部資格情報が必要な未完了ゲートであり、これらを確認するまで旧移行用credentialとdevDependenciesは削除しない。最終受け入れは `docs/migration/cloud-run-cutover-checklist.md` と `docs/eval/cloud-run-smoke.json` に記録する。

## 全体制約

- Node.jsは22.x、pnpmは11.1.3、Next.jsは16.2.6を維持する。
- MCPはNode.js runtimeの `POST /api/mcp?project_id=<slug>` で提供し、16 toolの名前・入力・出力契約を維持する。
- Markdownは本文の正本、Firestoreは派生metadata、SQLiteは再構築可能cacheとする。
- S3 keyは `<LTM_S3_PREFIX>/<project_id>/memories/<name>/<sha256>.md` とし、prefix traversalとproject scopeを検証する。
- Firestore Standardのdocument size、transaction size、batch write上限を超えるprojectはmigration verifyで拒否する。
- Web認証はFirebase Authenticationのemail/passwordとGoogle provider、サーバ検証はFirebase Admin SDKを使う。
- MCPは既存の `ltm_` PATを維持し、平文tokenを保存しない。
- `__shared__` のwriteはFirebase UIDと `LTM_MAINTENANCE_TOKEN` の二重ゲート、Web UI/APIはread-onlyとする。
- Cloud Runは `min instances=0`、`max instances=1`、`concurrency=1`、1 vCPU、512 MiB、region `asia-northeast1` を初期値とする。
- Cloud SQL、Redis、Upstash、Turso、Vercel Blob、Clerk、Firebase Cloud Storage、Cloud Scheduler、常駐workerを追加しない。
- S3本文とFirestore metadataの不一致は、immutable object、transaction、tombstone、reconcileで復旧する。
- secrets、Firebase Admin credential JSON、実在するenvファイル、PAT本文はrepositoryへ保存しない。
- PR由来コードへ本番S3/Firestore/Firebase secretを渡さない。
- ローカル開発は `LTM_STORAGE_DRIVER=local`、`AUTH_REQUIRED=0`、port 3939を維持する。
- 本番buildは `NODE_ENV=production pnpm build` とする。
- 各タスクは失敗テスト、実装、対象テスト、全体検証、目的が分かる小さなcommitの順で完了する。
- Vercel Project削除は最終受け入れ後だけ実行し、実装中は旧Vercelを削除しない。

## ファイル構成

### ストレージ・データ層

- 作成: `src/lib/storage/s3-markdown.ts` — S3 Markdown adapter
- 作成: `src/lib/storage/firestore-metadata.ts` — Firestore project/memory/name/tombstone metadata
- 変更: `src/lib/storage/contracts.ts` — `StorageMode` とobject version/conditional write contract
- 変更: `src/lib/storage/factory.ts` — `local` / `cloud` selector
- 変更: `src/lib/storage/sqlite-index.ts`、`src/lib/db/connection.ts` — `/tmp` SQLite cache
- 実データ移行verify後に削除: `scripts/migration/legacy-turso-index.ts` と移行専用Blob adapter。local filesystem adapterは残す。
- 変更: `src/lib/memory/remote-service.ts`、または`src/lib/memory/cloud-service.ts`へ置換 — S3/Firestore/SQLite service

### 認証・アプリ

- 作成: `src/lib/auth/firebase.ts`、`src/lib/auth/session.ts`、`src/lib/auth/firebase-client.ts`
- 作成: `src/lib/auth/firestore-store.ts`
- 変更: `src/lib/auth/access.ts`、`src/lib/auth/pat.ts`、`src/lib/auth/config.ts`、`src/lib/auth/store.ts`
- 変更: `src/proxy.ts`、`src/app/layout.tsx`、sign-in/sign-up page、`src/components/Header.tsx`
- 作成: `src/app/api/auth/session/route.ts`、`src/app/api/health/route.ts`
- 変更: `src/app/api/auth/tokens/route.ts`、`src/app/api/projects/**`、`src/app/api/memories/**`、`src/app/api/mcp/route.ts`

### デプロイ・移行・ドキュメント

- 変更: `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`next.config.ts`、`Dockerfile`、`.env.example`
- 作成: `firebase.json`、`firestore.rules`、`firestore.indexes.json`、`.github/workflows/cloud-run.yml`
- 作成: `scripts/cloud-run-smoke.ts`
- 作成: `scripts/migration/export-vercel.ts`、`scripts/migration/import-s3-firestore.ts`、`scripts/migration/verify-migration.ts`
- 変更: curator script、`.github/workflows/curator.yml`
- 移行検証後に削除: `vercel.json`、Vercel workflow、`scripts/vercel-smoke.ts`、`scripts/probe-turso.ts`、Vercel運用doc
- 変更: `docs/reproduction-spec.md`、`AGENTS.md`、`README.md`、評価台帳

### テスト

- 作成: `tests/storage/s3-markdown.test.ts`
- 作成: `tests/storage/firestore-metadata.test.ts`
- 作成: `tests/lib/memory/cloud-service.test.ts`
- 作成: `tests/lib/auth/firebase.test.ts`、`tests/lib/auth/firestore-store.test.ts`
- 作成: `tests/app/auth.firebase-routes.test.ts`
- 作成: `tests/deploy/cloud-run.test.ts`
- 作成: `tests/migration/migration.test.ts`
- 変更: `tests/smoke.test.ts`、`tests/deps.test.ts`、既存のauth/storage/memory/MCP/APIテスト
- 置換後に削除: Blob/Turso/Vercel固有テスト。旧Turso adapterの回帰テストは実データ移行verifyまで`tests/migration/`に残す。

## 実装タスク

### タスク1: 移行前の旧環境exportと新依存の足場

**対象ファイル:**

- 作成: `scripts/migration/export-vercel.ts`
- 作成: `tests/migration/migration.test.ts`
- 変更: `package.json`、`pnpm-lock.yaml`、`.env.example`

**インターフェース:**

- 生成物`MigrationManifest`:

      {
        generated_at: string,
        source: "vercel",
        projects: Array<{
          project_id: string,
          memories: Array<{
            id: string,
            name: string,
            key: string,
            content_hash: string,
            local_path: string
        }>
      }>,
        tombstones: Array<{
          project_id: string,
          memory_id: string,
          content_key: string,
          deleted_at: string
        }>,
        auth: {
          projects: Array<ProjectRecord>,
          members: Array<MemberRecord>,
          tokens: Array<TokenRecord>
        }
      }

- `exportVercelData(options: { outputDir: string; blobToken: string; memoryDbUrl: string; memoryDbToken: string; authDbUrl: string; authDbToken: string }): Promise<MigrationManifest>`
- export結果にはMarkdown、hash、metadataだけを含め、Blob/Turso/Clerk/Upstash credentialは含めない。

**手順:**

- [ ] **手順1: manifestとexportの失敗テストを書く。**

  同じMarkdownのhashとmanifestのhashが一致すること、credentialがmanifestやsnapshotへ書き込まれないことを検証する。

- [ ] **手順2: 対象テストを実行して失敗を確認する。**

  実行: `pnpm vitest run tests/migration/migration.test.ts`

  期待結果: exporterとmanifest型が未実装のためFAILする。

- [ ] **手順3: 旧移行依存を残したまま新依存を追加する。**

  `@aws-sdk/client-s3`、`firebase`、`firebase-admin`を追加する。タスク9の移行検証が完了するまで`@vercel/blob`と`@libsql/client`は残す。`pnpm install --lockfile-only`の後に`pnpm install --frozen-lockfile`を実行する。

- [ ] **手順4: 既存のprivate Blob/Turso adapterを使ってexportを実装する。**

  設定済みBlob prefixだけを列挙し、全Markdown objectをダウンロードしてSHA-256を計算し、memory/authの行を取得する。出力ディレクトリは呼び出し元指定の場所に限定し、必須env不足をprovider呼び出し前に拒否する。

- [ ] **手順5: テストと差分検査を実行してcommitする。**

  実行: `pnpm vitest run tests/migration/migration.test.ts tests/storage/blob-markdown.test.ts tests/storage/turso-index.test.ts`

  コミット: `feat: add pre-migration Vercel export`

### タスク2: S3 Markdown adapterとstorage contract

**対象ファイル:**

- 変更: `src/lib/storage/contracts.ts`
- 作成: `src/lib/storage/s3-markdown.ts`
- 変更: `src/lib/storage/factory.ts`
- 作成: `tests/storage/s3-markdown.test.ts`、`tests/storage/provider-compat.test.ts`

**インターフェース:**

- `StorageMode = "local" | "cloud"`
- `ObjectVersion { key: string; size: number; updatedAt: Date; etag?: string; sha256?: string }`
- `MarkdownWriteOptions { overwrite?: boolean; ifMatch?: string; contentHash?: string }`
- `MarkdownStore { read; write; remove; list; head }`
- `S3MarkdownStore`は注入可能な`S3ClientLike`を受け取り、unit testでAWS credentialを不要にする。
- `createMarkdownStore({ mode: "cloud", s3Client?, bucket?, prefix? })`はS3 adapterを返す。
- S3 object keyは`<prefix>/<projectId>/memories/<name>/<sha256>.md`とする。

**手順:**

- [ ] **手順1: S3 adapterの失敗テストを書く。**

  keyの決定性、unsafe keyとproject scope外keyの拒否、immutable writeで`If-None-Match: *`が付くことを検証する。

- [ ] **手順2: 対象テストを実行して失敗を確認する。**

  実行: `pnpm vitest run tests/storage/s3-markdown.test.ts`

  期待結果: `S3MarkdownStore`と`memoryObjectKey`が未実装のためFAILする。

- [ ] **手順3: S3 commandの対応付けを実装する。**

  `GetObjectCommand`、`PutObjectCommand`、`HeadObjectCommand`、`DeleteObjectCommand`、ページング対応の`ListObjectsV2Command`を実装する。`ContentType: text/markdown; charset=utf-8`、`content-sha256` metadata、設定済みprefixを付与し、immutable writeには`IfNoneMatch: "*"`を使う。

- [ ] **手順4: read/list/head/deleteとpath検証を実装する。**

  body streamをUTF-8へ変換し、404を既存not-found errorへ対応付ける。list結果をkey順に並べ、空・traversal・absolute keyを拒否し、指定projectのscope外keyを拒否する。

- [ ] **手順5: provider互換性と差分検査を実行してcommitする。**

  実行: `pnpm vitest run tests/storage/s3-markdown.test.ts tests/storage/provider-compat.test.ts`、`pnpm lint`、`git diff --check`

  コミット: `feat: add S3 markdown storage`

### タスク3: Firestore metadata、project access、PAT、tombstone store

**対象ファイル:**

- 作成: `src/lib/storage/firestore-metadata.ts`、`src/lib/auth/firestore-store.ts`
- 変更: `src/lib/auth/store.ts`、`src/lib/auth/access.ts`、`src/lib/auth/pat.ts`
- 作成: `tests/storage/firestore-metadata.test.ts`、`tests/lib/auth/firestore-store.test.ts`
- 変更: `tests/lib/auth/pat.test.ts`、`tests/lib/auth/access.test.ts`

**インターフェース:**

- `FirestoreMetadataStore`はproject、membership、memory index、name index、tombstone、PATの読み書きを公開する。
- `FirestoreAuthStore`は既存`AuthStore`の公開メソッドを実装し、routeとPAT helperへSQL固有型を渡さない。
- Firestore document pathは1 moduleへ集約し、route codeからraw pathを組み立てない。
- project write、memory/name/tombstone updateはFirestore transactionまたはatomic batchで実行する。

**手順:**

- [ ] **手順1: in-memory fake clientを使った失敗テストを書く。**

  saveでmemoryとname indexが同時作成されること、同一projectのname重複が`MemoryConflictError`になること、deleteでtombstoneを残してmemory/nameを削除することを検証する。

- [ ] **手順2: 対象テストを実行して失敗を確認する。**

  実行: `pnpm vitest run tests/storage/firestore-metadata.test.ts tests/lib/auth/firestore-store.test.ts`

  期待結果: Firestore path、transaction adapter、auth storeが未実装のためFAILする。

- [ ] **手順3: document変換と上限を検証するFirestore操作を実装する。**

  Firestore TimestampをUTC ISOへ変換し、想定外field typeを`FirestoreDataError`で拒否する。配列/mapは既存memory schemaの上限内に保ち、token hashを`mcpTokens` document IDに使う。平文PATは保存しない。

- [ ] **手順4: transaction順序とmembership accessを実装する。**

  save/update/renameではproject revisionとname documentを先に読み、renameでは新旧nameとmemoryをatomicに更新する。deleteではtombstoneとmemory/name削除を1 transactionで行い、name占有やrevision競合を`MemoryConflictError`へ変換する。

- [ ] **手順5: SQL認証アクセスをFirestoreAuthStoreへ置き換える。**

  `assertProjectAccess`がFirestore membershipを使うようにし、owner/member、shared read-only、curator UIDとmaintenance tokenの二重ゲート、CSRF、PAT期限/失効の意味を維持する。production callerから`rawQuery`を削除する。

- [ ] **手順6: テスト、lint、型検査を実行してcommitする。**

  実行: `pnpm vitest run tests/storage/firestore-metadata.test.ts tests/lib/auth/firestore-store.test.ts tests/lib/auth/pat.test.ts tests/lib/auth/access.test.ts`、`pnpm lint`、`pnpm exec tsc --noEmit`

  コミット: `feat: add Firestore metadata and authorization store`

### タスク4: Cloud Run SQLite cacheとS3/Firestore memory service

**対象ファイル:**

- 作成: `src/lib/storage/sqlite-index.ts`、`src/lib/memory/cloud-service.ts`
- 変更: `src/lib/memory/singleton.ts`、`src/lib/memory/reconcile.ts`、`src/lib/memory/mutex.ts`、`src/lib/storage/factory.ts`、`src/lib/db/schema.sql`、`src/lib/db/connection.ts`
- テスト: `tests/lib/memory/cloud-service.test.ts`、既存memory/reconcile/KG/search test

**インターフェース:**

- `openEphemeralIndex(path = join(os.tmpdir(), "long-term-memory", "index.db")): LocalIndexStore`
- `CloudMemoryService.openDefault(): CloudMemoryService`
- `CloudMemoryService`は`RemoteMemoryService`と同じ公開method（save、get、listByType、listSummaries、searchByTag、searchByTagSummaries、findRelated、update、forget、linkMemories、rename、listProjects、searchFulltext、searchFulltextIds、searchAssociative、supersededByMap、readKgGraph、kgStats、reconcile、reindex、close）を公開する。
- service依存は`{ markdown: MarkdownStore; metadata: FirestoreMetadataStore; index: IndexStore; mutex: KeyedMutex }`として注入する。
- `withProjectLock`は同一instance内のmutationを直列化するlocal-only実装とし、Redisを呼ばない。

**手順:**

- [ ] **手順1: save/update/delete/rename/reindex/restartの失敗テストを書く。**

  S3本文とFirestore metadataが成功したmemoryだけが検索に現れること、失敗時に既存可視状態が変わらないこと、renameの一貫性、tombstone後のreindex、SQLite削除後の再構築を検証する。

- [ ] **手順2: 対象cloud service testを実行して失敗を確認する。**

  実行: `pnpm vitest run tests/lib/memory/cloud-service.test.ts`

  期待結果: cloud service、ephemeral index、cache契約が未実装のためFAILする。

- [ ] **手順3: 一時SQLite indexを実装する。**

  既存`schema.sql`、WAL、foreign key、FTS5 trigram、bm25、KG tableを再利用し、localでは`LTM_HOME`、cloudでは`/tmp/long-term-memory`へ配置する。SQLiteをS3の正本として扱わない。

- [ ] **手順4: remote service操作をFirestore metadataとSQLite cacheへ移植する。**

  summary/search/KGはSQLiteから読み、完全なMarkdownはFirestoreの`content_key`でS3からhydrateする。save/updateはS3 immutable write、Firestore transaction、cache更新の順序を守り、既存RRF/PPR/rerank/supersession/link/entity/triple/scope契約を維持する。

- [ ] **手順5: S3正本文からreconcileとreindexを実装する。**

  active Firestore recordをS3 hashと解析済みMarkdownへ照合する。reindexはproject prefix、name、hash、tombstoneを検証し、不正または重複した1 fileだけを隔離して有効recordを消去しない。

- [ ] **手順6: singleton選択を置き換え、Redis経路を削除する。**

  localでは`MemoryService`、cloudでは`CloudMemoryService`を選択する。`VERCEL=1`選択、Upstash import、Redis config、Redis test、Vercel mode分岐を削除する。

- [ ] **手順7: service層の回帰テストを実行してcommitする。**

  実行: `pnpm vitest run tests/lib/memory tests/lib/search tests/lib/graph`、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build`

  コミット: `feat: add Cloud Run memory service`

### タスク5: Firebase Authenticationとsession cookie

**対象ファイル:**

- 作成: `src/lib/auth/firebase.ts`、`src/lib/auth/session.ts`、`src/lib/auth/firebase-client.ts`
- 作成: `src/app/api/auth/session/route.ts`、`tests/lib/auth/firebase.test.ts`、`tests/app/auth.firebase-routes.test.ts`
- 変更: `src/proxy.ts`、layout、sign-in/sign-up page、header、security header test

**インターフェース:**

- `verifyFirebaseIdToken(token): Promise<FirebasePrincipal>`
- `createSessionCookie(idToken): Promise<string>`
- `getFirebasePrincipal(request): Promise<FirebasePrincipal | null>`
- `requireFirebasePrincipal(request): Promise<FirebasePrincipal>`
- clientはemail/passwordとGoogle sign-inだけを提供する。

**手順:**

- [ ] **手順1: token/sessionの失敗テストを書く。**

  valid/invalid/expired ID token、session cookie、未認証401、Bearer tokenを明示API routeだけ許可すること、任意query parameterを拒否することを検証する。

- [ ] **手順2: 対象テストを実行して失敗を確認する。**

  実行: `pnpm vitest run tests/lib/auth/firebase.test.ts tests/app/auth.firebase-routes.test.ts`

  期待結果: Firebase verifier、session endpoint、route helperが未実装のためFAILする。

- [ ] **手順3: Firebase Adminの遅延初期化を実装する。**

  Cloud RunではApplication Default Credentialsを使い、`FIREBASE_PROJECT_ID`とlocal emulator設定を受け付ける。repository内のservice account JSONをparse/logせず、unit testでは注入可能verifierをmockする。

- [ ] **手順4: session endpointと認証主体helperを実装する。**

  ID tokenを検証し、本番では`Secure`、`SameSite=Lax`、`Path=/`を付けた短期HttpOnly cookieを発行する。server-sideの保護requestごとにcookieを検証し、cookieがない場合は明示API routeだけBearer ID tokenを許可する。

- [ ] **手順5: Clerk middlewareとページを置き換える。**

  `clerkMiddleware`、`ClerkProvider`、`SignIn`、`SignUp`を削除し、Firebase client providerとemail/password・Google formを追加する。`/sign-in`と`/sign-up`はpublicのままにし、認証済みの`Header`にはsign-out actionを表示する。

- [ ] **手順6: CSPと認証設定を更新する。**

  Clerk domainを削除し、client flowに必要なFirebase Auth/Google endpointだけを許可する。既存の`default-src 'self'`、`frame-ancestors 'none'`、`form-action 'self'`、production HSTSを維持し、`authConfigurationReady`がFirebase project設定を検証するようにする。

- [ ] **手順7: Firebase Authenticationの回帰を実行してcommitする。**

  実行: `pnpm vitest run tests/lib/auth tests/app/auth.firebase-routes.test.ts`、`pnpm lint`、`pnpm exec tsc --noEmit`

  コミット: `feat: add Firebase authentication session`

### タスク6: API、MCP、PAT、shared scope、UI統合

**対象ファイル:**

- 変更: `src/lib/auth/pat.ts`、`src/lib/auth/access.ts`、`src/lib/mcp/**`、`src/app/api/**`
- 変更: page、search、project、memory、graph、Header component
- テスト: `tests/lib/mcp`、`tests/app`、`tests/lib/auth`

**手順:**

- [ ] **手順1: route変更前に認証・MCPの失敗テストを書く。**

  Firebase UID membership、valid Firestore PAT、revoked/expired PAT、session cookie、shared read、shared write拒否、shared write許可、URL/log/bodyにtokenがないことを追加する。既存16-tool、CORS、CSRF assertionを維持する。

- [ ] **手順2: PATとrouteのstore構築を置き換える。**

  `createPat`、`listPats`、`revokePat`、`requireMcpPrincipal`が`FirestoreAuthStore`を使うようにする。一度だけの平文表示、SHA-256 hash、expiry、last-used timestamp、token prefixを維持する。

- [ ] **手順3: 全routeへFirebase principalとFirestore membershipを適用する。**

  project、member、memory、token、MCP routeがservice method呼び出し前にFirebase principalを取得し、service access前にproject scopeを検証する。別projectのownerであってもshared web UI/APIへの書き込みは禁止する。

- [ ] **手順4: MCPをrequest単位でstatelessに保つ。**

  request認証情報やproject stateをmodule globalへ保存しない。session cacheは認証状態を含まないMCP transport objectだけに限定し、requestごとにPATとFirestore membershipを検証する。

- [ ] **手順5: UIのリンクと認証状態を更新する。**

  project list、search、detail、edit、graph、token settingsをFirebase session stateで動作させる。shared scopeではedit/delete controlを隠し、日本語label、JST、本文表示、KG graph、既存REST response shapeを維持する。

- [ ] **手順6: routeとMCP回帰を実行してcommitする。**

  実行: `pnpm vitest run tests/lib/mcp tests/app tests/lib/auth`、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build`

  コミット: `feat: connect Firebase authorization to API and MCP`

### タスク7: 旧provider・永続Telemetryの削除とlocal mode更新

**対象ファイル:**

- 変更: `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.env.example`、`next.config.ts`、`docker-compose.yml`、`Dockerfile`
- 削除: `src/lib/storage/blob-markdown.ts`、`src/lib/auth/clerk.ts`、旧Vercel runtime。`src/lib/auth/connection.ts`、`src/lib/auth/schema.sql`、`src/lib/auth/migrate.ts`はlocal modeの認証DBに必要なため残す。`scripts/migration/legacy-turso-index.ts`と旧Blob adapterは実データmigration verify後に削除する。
- 削除: Redis部分のproject lock、永続Telemetry DBとdashboard data access
- テスト: `tests/deps.test.ts`、storage/auth/lock/telemetry test

**インターフェース:**

- `resolveStorageMode(): "local" | "cloud"`
- `LTM_STORAGE_DRIVER=local`はfilesystem + local SQLiteを使う。
- `LTM_STORAGE_DRIVER=cloud`はS3 + Firestore + `/tmp` SQLiteを使う。
- `withProjectLock`はlocal `KeyedMutex`だけで、Redis configやnetwork callを持たない。
- request logはmethod、route class、status、duration、project scope label、result countだけを含む。

**手順:**

- [ ] **手順1: 依存関係とsource scanの失敗テストを追加する。**

  production dependencyに`@clerk/nextjs`、`@vercel/blob`、`@libsql/client`、`@upstash/redis`がないこと、cloud env sampleに旧provider secretがないことを検証する。

- [ ] **手順2: 対象テストを実行して失敗を確認する。**

  実行: `pnpm vitest run tests/deps.test.ts tests/storage tests/lib/lock tests/lib/telemetry`

  期待結果: 旧依存と旧テストが残っているためFAILする。

- [ ] **手順3: export toolingを検証後、runtime provider codeを削除する。**

  旧adapter、Clerk file、Turso auth connection、Redis client/config、persistent telemetry DBを削除する。Telemetry呼び出しは永続データを書き込まないredacted loggerまたはno-op recorderへ置き換える。

- [ ] **手順4: packageと環境変数契約を更新する。**

  旧production依存を削除し、`LTM_STORAGE_DRIVER=cloud`、S3変数、Firebase変数、`MCP_PUBLIC_URL`、`MCP_ALLOWED_ORIGINS`、maintenance変数を使う。実secretは含めず、lockfileを更新する。

- [ ] **手順5: local Dockerを動作可能なまま維持する。**

  port 3939、bind mountした`.long-term-memory`、local auth bypass、local curatorを維持する。production imageは既定値8080の`PORT`を使い、Composeは3939を明示する。

- [ ] **手順6: ローカル検証全体を実行してcommitする。**

  実行: `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build`、`git diff --check`

  コミット: `refactor: remove Vercel providers and persistent telemetry`

### タスク8: Cloud Runコンテナ、Firebase設定、CI/CD、smoke検証

**対象ファイル:**

- 変更: `Dockerfile`、`next.config.ts`、`.env.example`
- 作成: `firebase.json`、`firestore.rules`、`firestore.indexes.json`、`.github/workflows/cloud-run.yml`、`scripts/cloud-run-smoke.ts`、`tests/deploy/cloud-run.test.ts`
- 削除: `vercel.json`、Vercel workflow、`scripts/vercel-smoke.ts`、`scripts/probe-turso.ts`、Vercel固有doc/test

**インターフェース:**

- `scripts/cloud-run-smoke.ts`は`CLOUD_RUN_URL`、`LTM_MCP_TOKEN`、`LTM_SMOKE_PROJECT_ID`をenvから読み、secretをlogせずhealth、initialize、tools/list count=16、save、Japanese search、get、deleteを確認する。
- `firestore.rules`はclientの直接read/writeを拒否し、production data accessはAdmin SDKだけにする。
- `cloud-run.yml`はpush/PRでtestを実行し、mainまたはmanual dispatchだけdeployする。`pull_request` jobへruntime secretを渡さない。

**手順:**

- [ ] **手順1: deployment契約の失敗テストを書く。**

  Dockerfileが`0.0.0.0`と`PORT`を使うこと、Cloud Run workflowがPRへ本番secretを渡さないことを検証する。

- [ ] **手順2: deployment対象テストを実行して失敗を確認する。**

  実行: `pnpm vitest run tests/deploy/cloud-run.test.ts`

  期待結果: Cloud Run workflow、smoke script、Firebase fileが未実装のためFAILする。

- [ ] **手順3: production Docker imageを実装する。**

  `NODE_ENV=production`、`LTM_HOME=/tmp/long-term-memory`、`PORT`の既定値8080を設定する。Next.js output、production依存、schema、必要なruntime sourceだけをcopyし、`better-sqlite3`をexternalizedのまま含める。

- [ ] **手順4: FirebaseとFirestore設定を追加する。**

  Firestore ruleはclient data accessを全拒否し、project/member queryに必要なcomposite indexだけを追加する。TTL、PITR、scheduled export、Firebase Storageは有効化しない。

- [ ] **手順5: Cloud Run smokeとworkflowを実装する。**

  GCP認証にはGitHub OIDC/Workload Identity Federationを使い、PRではprovider secretなしでtest/build/Docker buildを行う。mainでは`gcloud run deploy --source . --region asia-northeast1 --min 0 --max 1 --concurrency 1 --cpu 1 --memory 512Mi --timeout 300`でdeployし、repository environment secretでsmokeを実行する。GCP budget alertを設定し、S3 runtime credentialはSecret Managerに置く。

- [ ] **手順6: ローカルdeployment検証を実行してcommitする。**

  実行: `pnpm vitest run tests/deploy/cloud-run.test.ts`、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build`、`git diff --check`

  コミット: `ci: add Cloud Run deployment and smoke`

### タスク9: import/export移行とデータ検証

**対象ファイル:**

- 作成または変更: `scripts/migration/export-vercel.ts`、`scripts/migration/import-s3-firestore.ts`、`scripts/migration/verify-migration.ts`
- 作成: `tests/migration/migration.test.ts`
- 変更: `docs/eval/test-spec-ledger.json`、`docs/reproduction-spec.md`

**インターフェース:**

- `importMigration(input: { manifestPath: string; s3: S3Target; firestore: FirestoreTarget; firebaseUidMap: Record<string, string> }): Promise<ImportReport>`
- `verifyMigration(input: { manifestPath: string; s3: S3Target; firestore: FirestoreTarget }): Promise<VerificationReport>`
- `VerificationReport`はsource/target count、missing key、extra key、hash mismatch、parse failure、memory mismatch、name index mismatch、membership mismatch、PAT mismatch、tombstone mismatchを含む。
- importはcontent hashとFirestore document IDでidempotentにし、同じmanifestの2回目importで重複を作らない。
- importはFirestore document 1MiB、request 10MiB、transaction write 500件の公式上限に対する安全予算を事前検査し、超過時は書き込みを開始しない。

**手順:**

- [ ] **手順1: migration fixtureと失敗する検証テストを追加する。**

  同じmanifestを2回importしてもmemoryとS3 objectが増えないこと、Clerk UID mapにないownerでimportを中断することを検証する。

- [ ] **手順2: migration対象テストを実行して失敗を確認する。**

  実行: `pnpm vitest run tests/migration/migration.test.ts`

  期待結果: importとverification functionが未実装のためFAILする。

- [ ] **手順3: hashとparse検証付きS3 importを実装する。**

  各source Markdownを読み、SHA-256を再計算し、`parseMemoryString`でfrontmatterを検証する。決定的S3 keyへimmutable semanticsで書き、target metadataへ書き込む前にsource hash mismatchを拒否する。

- [ ] **手順4: Firebase UID対応表とFirestore importを実装する。**

  IDだけを含むmigration mapping fileで旧Clerk owner/member IDを変換する。project、membership、memory metadata、name index、PAT hash、tombstoneをimportし、Clerk secretや平文PATをimportしない。

- [ ] **手順5: 検証とidempotent retryを実装する。**

  source manifestとS3 key/hash、Firestore document、解析済みMarkdownを比較し、missing、extra、不一致、parse不能があればnonzero終了する。orphan objectはGC対象としてreportに明示された場合だけ許可する。

- [ ] **手順6: 分離targetでmigration検証を実行してcommitする。**

  実行: `pnpm vitest run tests/migration/migration.test.ts`、`pnpm tsx scripts/migration/verify-migration.ts --manifest "$MIGRATION_MANIFEST"`、`pnpm lint`、`pnpm exec tsc --noEmit`

  コミット: `feat: add S3 Firestore migration verification`

### タスク10: curator、Claude Code資産、ドキュメント、運用手順

**対象ファイル:**

- 変更: curator script、`.github/workflows/curator.yml`、`docs/post-mcp-setup.md`、`skills/long-term-memory/SKILL.md`、`skills/shared-memory-curator/SKILL.md`、`claude-config/**`
- 変更: `AGENTS.md`、`docs/reproduction-spec.md`、`README.md`
- テスト: `tests/docs/post-mcp-setup.test.ts`、`tests/curator/remote-snapshot.test.ts`

**インターフェース:**

- Curator MCP config URLは`MCP_PUBLIC_URL/api/mcp?project_id=__shared__`とする。
- Curatorは`Authorization: Bearer LTM_MCP_TOKEN`と`X-LTM-Maintenance-Token`を送り、Vercel bypass headerは持たない。
- Curator exportは同じ16-tool MCP契約を呼び出し、sanitized temporary snapshotを書き出す。
- local modeは`localhost:3939`の設定を通じて維持する。

**手順:**

- [ ] **手順1: Cloud Run設定を前提にドキュメントテストを更新する。**

  Vercel URL/header assertionをCloud Run URLへ置換し、Protection Bypassが存在しないことを確認する。token redaction、strict MCP config、dry-run書き込み抑止、backup、Claude再起動手順は維持する。

- [ ] **手順2: curator exporterと設定を更新する。**

  `VERCEL_AUTOMATION_BYPASS_SECRET`をenv example、workflow env、header生成、redaction patternから削除する。設定fileはprovider-neutralなCloud Run MCP URL変数を使う。

- [ ] **手順3: 正本ドキュメントを更新する。**

  Vercel runtime、Clerk auth、Turso/Blob/Redis、Vercel deployment/operationsを承認済み設計へ置き換える。S3/Firestore path、Firebase UID認可、Cloud Run制限、migration gate、ゼロコスト運用の限界を記録し、AGENTS.mdで削除providerの再導入を防ぐ。

- [ ] **手順4: docs/curatorテストを実行してcommitする。**

  実行: `pnpm vitest run tests/docs tests/curator`、`pnpm lint`、`git diff --check`

  コミット: `docs: switch curator and operations to Cloud Run`

### タスク11: 完全受け入れ、切り替え、Vercel削除ゲート

**対象ファイル:**

- 変更: `docs/eval/cloud-run-smoke.json`、`docs/eval/test-spec-ledger.json`
- 作成: `docs/migration/cloud-run-cutover-checklist.md`
- テスト: full repository testと分離provider smoke

**インターフェース:**

- cutover checklistにはsource/target S3 hash count、Firestore project/member/PAT count、Firebase login result、Cloud Run revision URL、smoke run ID、rollback判断、Vercel deletion confirmationを記録する。
- すべてのchecklist gateがpassedになるまで、実装タスクでVercelを削除しない。

**手順:**

- [ ] **手順1: repository全体を検証する。**

  実行: `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build`、`git diff --check`

  期待結果: すべて0終了し、Vercel/Turso/Blob/Redis/Clerk runtime importが残っていない。

- [ ] **手順2: containerをbuildして検査する。**

  実行: `docker build -t long-term-memory:cloud-run .`、`docker run --rm -e PORT=8080 -e AUTH_REQUIRED=0 -p 8080:8080 long-term-memory:cloud-run`

  `GET /api/health`が200を返し、image layerやlogにsecretがないことを確認する。

- [ ] **手順3: 分離provider smokeを実行する。**

  専用smoke projectとFirebase user/PATを作成し、Cloud Run候補へ`scripts/cloud-run-smoke.ts`を実行する。initialize、16 tools/list、save/search/get/update/link/reindex/delete、shared read/write gate、cold start、redacted logを確認する。renameはMCP公開toolではないため、`CloudMemoryService`の回帰テストで確認する。

- [ ] **手順4: Vercelをread-only化してexportする。**

  旧deploymentをread-only/maintenanceへ変更し、新規writeを停止して`export-vercel.ts`を実行する。manifestとfinal S3 import reportはrepository外へ保存し、旧credentialはまだ削除しない。

- [ ] **手順5: import、検証、client切り替えを行う。**

  `import-s3-firestore.ts`、`verify-migration.ts`の順に実行する。missing key、hash mismatch、parse failure、memory metadata/name index mismatchをゼロにし、membership/PAT/tombstone countを一致させる。Claude Code MCP設定、curator環境、ドキュメントリンク、DNS/aliasをCloud Runへ変更する。

- [ ] **手順6: rollback期間と最終snapshotを確認する。**

  最終S3 snapshotを保存し、memory 1件の手動restoreを実行する。旧Vercel writeが拒否されることを確認し、合意したrollback期間だけ旧projectを保持する。判断を`docs/migration/cloud-run-cutover-checklist.md`へ記録する。

- [ ] **手順7: 最終確認後だけVercelを削除する。**

  Vercel integration、environment variable、GitHub Vercel secret、domain mappingを削除する。その後、管理者が認証済みVercel Console/CLIからVercel Projectを削除する。削除をGitHub Actionsで自動化しない。

- [ ] **手順8: 受け入れ記録をcommitして引き渡す。**

  実行: `git status --short --branch`、`git log -8 --oneline --decorate`、`git diff --check`

  コミット: `docs: record Cloud Run migration acceptance`

## フェーズゲート

1. **ゲート1 — export安全性:** 旧Blob/Turso exportがcredentialを漏えいさせず、hashが揃ったmanifestを作成する。
2. **ゲート2 — storage:** S3 path検証、immutable write、read/list/delete、Firestore transaction testが成功する。
3. **ゲート3 — service:** S3/FirestoreからSQLiteを再構築した状態でsave/update/rename/delete/reconcile/reindex/search/KG/supersessionが成功する。
4. **ゲート4 — auth:** Firebase session、Firebase UID membership、PAT、CSRF/CORS、shared gate testが成功する。
5. **ゲート5 — runtime:** local mode、Docker、Cloud Run health、deployment workflow、smoke scriptが成功する。
6. **ゲート6 — migration:** 分離targetでsourceとtargetのcount/hash/permission/tombstoneが一致する。
7. **ゲート7 — cutover:** Cloud Runがproduction MCP/UI trafficを処理し、旧Vercelがread-onlyになり、final restoreが成功する。
8. **ゲート8 — deletion:** 明示的な管理者確認後だけVercel Projectとsecret/integrationを削除する。

## 自己レビュー項目

- [ ] 承認済み設計の各節に少なくとも1つの実装タスクがある。
- [ ] 各タスクが対象ファイル、interface、test、command、commit messageを明記している。
- [ ] どのタスクもCloud SQL、Redis、Firestore Enterprise search、Firebase Storage、常駐workerを導入していない。
- [ ] S3がMarkdown本文の正本であり、Firestoreにpasswordや平文PATを保存しない。
- [ ] SQLiteは再構築可能なままで、永続的な正本として扱わない。
- [ ] Vercel削除は最終的な不可逆ゲートであり、早期の実装手順ではない。
- [ ] 未完了表現、曖昧な仮置き、未定義の関数名がない。
- [ ] `pnpm test`、lint、TypeScript、production build、Docker、migration verify、Cloud Run smokeが完了条件に含まれる。
