# Vercel 対応 long-term-memory MCP 実装計画

> **エージェント作業者向け:** 必須サブスキルとして `superpowers:subagent-driven-development`（推奨）または `superpowers:executing-plans` を使い、この計画をタスク単位で実行する。各手順はチェックボックス（`- [ ]`）で追跡する。

**目的:** `docs/reproduction-spec.md` の 16 ツール長期記憶 MCP と閲覧 UI を Next.js 単一アプリとして再実装し、Vercel 上でも Markdown 正本・全文検索・共有スコープ・テレメトリを永続運用できるようにする。

**アーキテクチャ:** Next.js App Router の Node.js Route Handler に MCP (`/api/mcp`) と REST/UI を同居させる。ローカル開発は仕様どおり `better-sqlite3 + filesystem`、Vercel 本番は `Turso/libSQL + FTS5` を索引、`Vercel Blob private` を Markdown 正本として同一の storage port から利用する。Blob と DB の更新は「Blob を先に確保、DB ポインタをコミット、旧 Blob を後処理」とし、DB に見える状態だけを原子的に切り替える。Vercel の複数インスタンス間の書き込み直列化は Upstash Redis のプロジェクト単位 lease lock で補う。

**技術スタック:** Node.js 22.x、pnpm 9/11、Next.js 16.2.6、React 19.2.4、TypeScript 5、Vitest 4.1.6、`@modelcontextprotocol/sdk` 1.29.0、`@clerk/nextjs` v7、`@libsql/client`、`@vercel/blob`、`@upstash/redis`、`better-sqlite3`（ローカル/Docker）、`gray-matter`、`ulid`、`zod`、`@xyflow/react`、`d3-force`、`react-markdown`。

**仕様書:** `docs/reproduction-spec.md`

## 全体制約

- Node.js は 22.x、Next.js は 16.2.6、MCP は `POST /api/mcp?project_id=<slug>` の Node.js runtime で提供する。
- MCP ツールは write 8 + read 6 + meta 2 の **16 個**。`project_id` は URL からのみ取得し、ツール引数には追加しない。
- 記憶型は `user` / `feedback` / `project` / `reference` / `session` の 5 型。作成系の `user` / `feedback` / `project` は非空 `entities` 必須。
- Markdown が正本。ローカルキーは `<LTM_HOME>/projects/<project_id>/memories/<name>.md`、本番 Blob キーは `projects/<project_id>/memories/<name>/<content_hash>.md` とし、索引は再構築可能にする。
- 本番の索引プロバイダは Turso/libSQL が FTS5 `trigram`、列重み付き `bm25`、`contentless_delete=1` を実際にサポートすることを Phase 0 の接続テストで確認する。通らない場合は実装を先へ進めず、SQLite 互換プロバイダを再選定する。
- FTS クエリはトークンを二重引用し、3 code point 未満は `LIKE` fallback。bm25 の重みは name 10 / description 5 / body 1。
- `query_entities` がある検索は無向重み付き KG + Personalized PageRank、LLM/埋め込みはサーバに置かずクライアントで抽出する。
- `__shared__` は既定読み取り専用。書き込みは `X-LTM-Maintenance-Token` と `timingSafeEqual` の完全一致だけを許可し、Web API/UI は常に read-only。
- 書き込みはプロジェクト単位で直列化する。ローカルは `KeyedMutex`、Vercel は Upstash Redis lease（token、TTL、compare-and-delete）を併用する。
- Blob/DB の一方だけが更新されても利用者から半端な記憶が見えない順序にする。孤立 Blob は reconcile の GC で削除し、更新は content hash 付き immutable Blob を使ってリトライ可能にする。
- 内部日時は ISO 8601 UTC、表示は必ず `Asia/Tokyo` の JST。削除は完全削除で soft delete は作らない。
- Vercel Route Handler、UI、ダッシュボードは `runtime = 'nodejs'`、`dynamic = 'force-dynamic'`。Edge runtime とローカル書き込み可能 filesystem に依存しない。
- Vercel の本番 curator は Vercel Function 内で `claude -p` を起動しない。GitHub Actions または macOS launchd の外部 runner が Vercel MCP URL を呼ぶ。Docker/launchd 資産はローカル運用として残す。
- Vercel 公開時は認証必須。ブラウザは Clerk（Vercel Marketplace）で認証し、MCP/CLI は UI で一度だけ発行する PAT を `Authorization: Bearer` で送る。PAT は SHA-256 ハッシュのみ保存し、失効・有効期限・最終利用時刻を管理する。
- 認証済みユーザーは owner/member のプロジェクトだけを読み書きできる。`__shared__` は認証済み全員が読み取り可、書き込みは PAT に加えて `X-LTM-Maintenance-Token` と curator principal の一致を要求する。
- Vercel では UI、REST、MCP の未認証リクエストは `401`、membership 不足は `403`。ローカル開発だけ `AUTH_REQUIRED=0` で匿名アクセスを許可する。
- mutating な Web リクエストは same-origin/CSRF を検証し、MCP は `MCP_ALLOWED_ORIGINS` の CORS allowlist を使う。認証情報を URL、ログ、テレメトリ本文へ出さない。
- テストは仕様書 §15 の 69 ファイルを受け入れ条件とし、追加する storage/provider、分散 lock、Vercel stateless MCP、Blob/DB 障害、ダッシュボードのテストも全て緑にする。

## ファイル構成

### ストレージとコア

- 作成: `src/lib/storage/contracts.ts` — Markdown/Index/Telemetry の provider interface と `StorageMode`。
- 作成: `src/lib/storage/fs-markdown.ts`, `src/lib/storage/blob-markdown.ts` — ローカル filesystem と Vercel Blob private adapter。
- 作成: `src/lib/storage/local-index.ts`, `src/lib/storage/turso-index.ts`, `src/lib/storage/factory.ts` — `better-sqlite3`/libSQL の共通 query port と env 選択。
- 作成・変更: `src/lib/paths.ts`, `src/lib/slug.ts`, `src/lib/markdown/*`, `src/lib/db/*`, `src/lib/memory/*`, `src/lib/graph/*`, `src/lib/eval/*` — 仕様 §5–§8 の正本実装。
- 作成: `src/lib/lock/project-lock.ts` — local `KeyedMutex` と Upstash Redis lease の統合。
- 作成: `scripts/probe-turso.ts` — 本番 DB の FTS5/migration compatibility probe。

### MCP・テレメトリ・API・UI

- 作成: `src/lib/mcp/*` — schemas/server/transport/session/context/auth/tools。
- 作成: `src/lib/telemetry/*` — memory index とは別 provider/database のイベント記録・集計。
- 作成: `src/app/api/mcp/route.ts`, `src/app/api/projects/route.ts`, `src/app/api/memories/[id]/route.ts`。
- 作成: `src/app/*`, `src/app/p/[slug]/*`, `src/app/dashboard/page.tsx`, `src/components/*` — UI、グラフ、ダッシュボード。

### 運用とクライアント資産

- 作成: `vercel.json`, `.env.example`, `.github/workflows/test.yml`, `.github/workflows/vercel.yml`, `.github/workflows/curator.yml`。
- 作成: `.devcontainer/Dockerfile`, `.devcontainer/compose.yaml`, `.devcontainer/devcontainer.json`, `.devcontainer/README.md`, `.dockerignore` — OpenAI Codex CLI / GitHub CLI / jq を含む開発コンテナと volume 永続化を構成する。
- 作成・変更: `Dockerfile`, `docker-compose.yml`, `scripts/start-mcp.sh`, `scripts/curator/*`, `launchd/*` — ローカル運用互換を保持。
- 作成: `skills/long-term-memory/SKILL.md`, `skills/shared-memory-curator/SKILL.md`, `claude-config/*`, `docs/post-mcp-setup.md`, `scripts/sync-embedded-docs.mjs`。

## 実装タスク

### タスク 0: Vercel ストレージ互換性ゲートとプロジェクトの足場

**対象ファイル:**
- 作成: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `next.config.ts`, `eslint.config.mjs`, `.gitignore`, `.dockerignore`, `.env.example`, `vercel.json`。
- 作成: `src/lib/storage/contracts.ts`, `tests/smoke.test.ts`, `tests/deps.test.ts`, `tests/storage/provider-compat.test.ts`, `scripts/probe-turso.ts`。

**インターフェース:**
- 実装する: `StorageMode = 'local' | 'vercel'`, `MarkdownStore { read(key): Promise<string>; write(key, text, opts?): Promise<StoredObject>; remove(key): Promise<void>; list(prefix): Promise<StoredObject[]> }`。
- 実装する: `IndexStore { exec; query; transaction<T>(fn); close? }`。型付き行を返し、ローカル adapter 以外では `better-sqlite3` を直接使わない。
- 実装する: `resolveStorageMode(): StorageMode`。各呼び出しで `LTM_STORAGE_DRIVER` を読み、テストが安全に環境変数を切り替えられるようにする。

- [x] **手順 1: 固定依存関係とスクリプトを追加する。** 仕様書 §2.2 の依存バージョンとスクリプトを取り込む。 `@libsql/client`、`@vercel/blob`、`@upstash/redis` を追加する。 ローカル/Docker 用の `better-sqlite3` は残し、ビルド許可を `pnpm-workspace.yaml` に記載する。
- [x] **手順 2: Next/Vitest/ESLint の設定を追加する。** `serverExternalPackages: ['better-sqlite3']`、`@/*` を使う strict TypeScript、Vitest の node 環境、§2.3 の ignore/build 設定を設定する。
- [x] **手順 3: 失敗する provider probe を先に作成する。** probe は `CREATE VIRTUAL TABLE ... USING fts5(... content='', contentless_delete=1, tokenize='trigram')` を実行し、日本語を挿入し、rowid で削除し、重み付き `bm25` を実行して、`TURSO_DATABASE_URL` で全操作が成功することを検証する。
- [x] **手順 4: ゲートを実行する。** `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm build`、続いて `TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... pnpm tsx scripts/probe-turso.ts` を実行する。ローカル smoke テストが通り、provider probe が成功することを確認する。未対応機能があれば、その内容を記録して計画を停止する。
- [x] **手順 5: 足場をコミットする。** `git add .` と `git commit -m "chore: scaffold Next.js Vercel runtime"` を実行する。probe の判定を `docs/superpowers/plans/2026-09-05-vercel-long-term-memory.md` に記録してから行う。

#### タスク 0 の検証記録（2026-09-05）

- 足場と最小の準備中ページを作成。依存バージョンの範囲は仕様 §2.2 のまま、lockfile で実際の解決値を固定した。追加 SDK は libSQL 0.17.0、Blob 2.3.0、Redis 1.36.2。
- Node.js 22.23.2 / pnpm 11.1.3。`allowBuilds` と `onlyBuiltDependencies` の併記は隔離ディレクトリと frozen install で成功した。
- TDD: 未実装スタブで storage 選択2件と probe 1件のアサーション失敗を確認後に実装した。実 libSQL と native SQLite の FTS5 テスト、および probe 失敗時の後始末テストを実施。
- `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit` 成功。
- `pnpm build` はホストの `NODE_ENV=development` による prerender エラーで失敗。`NODE_ENV=production pnpm build` は成功。
- **リモートゲートは合格（2026-09-05）**。Turso CLI で `long-term-memory` データベースを作成し、認証トークンを表示・保存せずに `scripts/probe-turso.ts` を実行した。リモート FTS5 trigram、weighted bm25、contentless rowid delete の全操作が成功したため、タスク 1 以降へ進む。
- Docker CLI がこの環境にないため Compose 構成検証・コンテナビルド・volume の永続化確認は未実施。JSON/YAML 構文と既存CLIのバージョンを別途確認する。
- インストール時に eslint 9 系、node-domexception、prebuild-install の非推奨通知がある。仕様の依存範囲を保持した。

### タスク 1: Markdown データモデルと二重ストア

**対象ファイル:**
- 作成・変更: `src/lib/memory/types.ts`, `src/lib/markdown/frontmatter.ts`, `src/lib/markdown/file-io.ts`, `src/lib/paths.ts`, `src/lib/slug.ts`。
- 作成: `src/lib/storage/fs-markdown.ts`, `src/lib/storage/blob-markdown.ts`, `src/lib/storage/factory.ts`。
- テスト: `tests/lib/paths.test.ts`, `tests/lib/slug.test.ts`, `tests/lib/markdown/frontmatter.test.ts`, `tests/lib/markdown/frontmatter.supersedes.test.ts`, `tests/storage/fs-markdown.test.ts`, `tests/storage/blob-markdown.test.ts`。

**インターフェース:**
- 実装する: `MemorySchema`、`EntitySchema`、`TripleSchema`、`SourceRefSchema`、`bodyChars(body): number`、`serializeMemory(memory): string`、`parseMemoryString(text): Memory` を §5.1–§5.3 のとおりに実装する。
- 実装する: `memoryObjectKey(projectId, name, contentHash): string` と `memoryPrefix(projectId, name?): string`。Blob key にユーザー入力由来のパス逸脱要素を含めない。

- [x] **手順 1: frontmatter のテストを先に作成する。** 固定キー順、末尾改行、Date から ISO への変換、YAML boolean alias、不正 triple の破棄、空でない `supersedes`、Unicode code point の本文長、最後の `MemorySchema.parse` 拒否を網羅する。
- [x] **手順 2: スキーマとシリアライザを実装する。** フィールド順を厳密に保ち、空の `entities`、`triples`、`source_refs`、`supersedes` は省略する。`supersedes` の名前は空を許さず、parse 時に本文境界の改行を正規化する。
- [x] **手順 3: adapter 契約テストを作成する。** 一時 filesystem store と mock Blob client の両方で同じ CRUD/list/hash テストを実行する。Blob が private であること、content-hash key が決定的であること、Blob mode が `LTM_HOME` に依存しないこと、不正な project/name を安全に拒否することを検証する。
- [x] **手順 4: 両 adapter を実装する。** ローカル adapter は `atomicWriteText` を使う。Blob adapter は `put(..., { access: 'private', addRandomSuffix: false })`、`get`、`list`、`del` を使い、`BLOB_READ_WRITE_TOKEN` は遅延検証して本番 env なしでも `next build` を通す。
- [x] **手順 5: 対象テストを実行してコミットする。** `pnpm vitest run tests/lib/markdown tests/storage` を実行し、`feat: add canonical markdown storage ports` でコミットする。

### タスク 2: 索引スキーマ、マイグレーション、Vercel 対応永続化

**対象ファイル:**
- 作成・変更: `src/lib/db/schema.sql`, `src/lib/db/migrate.ts`, `src/lib/db/connection.ts`, `src/lib/storage/local-index.ts`, `src/lib/storage/turso-index.ts`。
- 作成: `tests/lib/db/schema.test.ts`, `tests/lib/db/migrate.test.ts`, `tests/storage/turso-index.test.ts`。

**インターフェース:**
- 実装する: §6.1 の schema v5 テーブル（`memories`、`tags`、`links`、`supersedes`、`memories_fts`、`entities`、`entity_aliases`、`memory_entities`、`entity_edges`）と索引。
- 実装する: `CURRENT_VERSION = 5`、厳密な `REBUILDABLE_TABLES` 一覧、`migrate(db)`、`openLocalDb(path)`、`openTursoDb()`。

- [x] **手順 1: schema/migration テストを追加する。** `REBUILDABLE_TABLES` に全テーブル/仮想テーブルが載ること、`schema_version` が保持されること、migration が FK 安全な順序で削除すること、`contentless_delete=1` が動くこと、Markdown だけから索引を復元できることを検証する。
- [x] **手順 2: ローカル SQLite adapter を実装する。** WAL と外部キーを有効化し、コメント行を除去してから SQL を `/;\s*\n/` で分割し、rowid を使って `DELETE FROM memories_fts WHERE rowid = ?` を実行する。
- [x] **手順 3: Turso adapter を実装する。** `createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN })` は遅延初期化する。パラメータ化 query/transaction API を共通化し、モジュール import 時には初期化しない。
- [x] **手順 4: provider の機能チェックを追加する。** CI/deploy の preflight で FTS probe を実行し、trigram、重み付き bm25、contentless delete のいずれかが未対応なら migration 前に明確なエラーで停止する。
- [x] **手順 5: DB テストを実行する。** `pnpm vitest run tests/lib/db tests/storage/turso-index.test.ts` を実行し、`feat: add rebuildable SQLite and Turso index adapters` でコミットする。

### タスク 3: コアサービス、KG、reconcile、ロック、原子的な可視性

**対象ファイル:**
- 作成・変更: `src/lib/memory/mutex.ts`, `src/lib/memory/kg.ts`, `src/lib/memory/reconcile.ts`, `src/lib/memory/service.ts`, `src/lib/memory/singleton.ts`, `src/lib/datetime.ts`。
- 作成: `src/lib/lock/project-lock.ts`, `src/lib/storage/reconcile-objects.ts`。
- テスト: `tests/lib/memory/*`, `tests/lib/lock/project-lock.test.ts`, `tests/storage/atomic-failure.test.ts`。

**インターフェース:**
- 実装する: §7.7 の全 `MemoryService` メソッド。同期メソッドに加えて非同期の `saveAsync/updateAsync/forgetAsync/linkMemoriesAsync/renameAsync` を含める。
- 実装する: `withProjectLock(projectId, fn)`。local mode は `KeyedMutex` に委譲し、Vercel mode はランダム owner token 付き Redis key `ltm:lock:<projectId>` を取得し、token が一致する場合だけ解放する。
- 実装する: filesystem file または Blob prefix を列挙できる `reconcile()` と `reindex()`。

- [x] **手順 1: サービス契約テストを作成する。** save/get/list/update/forget/rename/link、名前重複、本文長、Unicode、tags の `match='all'`、BFS 深さ上限、project 一覧、非同期直列化、§5.1 の全エラー型を網羅する。
- [x] **手順 2: 実装前に失敗順序テストを作成する。** Blob put、DB insert、update pointer、Blob delete の各失敗を再現する。update では旧可視本文が残ること、save 失敗が索引化されないこと、Blob cleanup が失敗しても delete が記憶を隠すこと、孤立 object が GC 対象として報告されることを検証する。
- [x] **手順 3: KG と reconcile を実装する。** entity、alias、membership、triple の適用/撤回を transaction 内で行う。ファイル単位の savepoint を使い、upsert 前に ID を `seenIds` へ追加し、欠落/不正 Markdown を掃除し、link と supersedes の project scope を保持する。
- [x] **手順 4: Vercel の順序でサービス書き込みを実装する。** save は immutable Blob を書いてから index/KG/FTS を transaction で登録する。update/rename は新 Blob → index pointer と参照の transaction 更新 → 旧 Blob 削除の順、forget は index の可視性を先に外して Blob を best-effort 削除する。全非同期メソッドを `withProjectLock` で包む。
- [x] **手順 5: 孤立 object の GC と復旧を追加する。** `reconcile-objects.ts` で `memories.file_path` が参照していない content-hash object を列挙し、設定した猶予期間より古いものだけ削除する。参照中の object は絶対に削除しない。
- [x] **手順 6: コアテストを実行してコミットする。** `pnpm vitest run tests/lib/memory tests/lib/lock tests/storage/atomic-failure.test.ts` を実行し、`feat: implement memory service and cross-store write safety` でコミットする。

### タスク 4: 検索、連想想起、リランキング、評価

**対象ファイル:**
- 作成・変更: `src/lib/graph/ppr.ts`, `src/lib/graph/assoc.ts`, `src/lib/memory/rrf.ts`, `src/lib/memory/rerank.ts`, `src/lib/eval/metrics.ts`, `scripts/eval-recall.ts`。
- テスト: `tests/lib/service.bm25.test.ts`, `tests/lib/service.trigram.test.ts`, `tests/lib/service.fts-special-chars.test.ts`, `tests/lib/graph/ppr.test.ts`, `tests/lib/graph/assoc.test.ts`, `tests/lib/rerank.test.ts`, `tests/lib/service.decay*.test.ts`, `tests/lib/service.supersedes.test.ts`。

**インターフェース:**
- `ftsTokens`、`ftsPhrases`、`searchFulltextIds`、`searchFulltext`、`personalizedPageRank`、`rankMemoriesByPpr`、`rrfMerge`、`decayFactor`、`normalizeRelevance`、`rerank` を §8 の定数どおりに実装する。

- [x] **手順 1: FTS テストを作成する。** 日本語部分一致、2 文字の `LIKE` fallback、引用符付き `better-sqlite3`/`Server.connect` token、AND→OR retry、bm25 列順、正規化前の type/tag filter を検証する。
- [x] **手順 2: FTS 検索を実装する。** 3 code point 以上の token が 1 つでもあるときだけ trigram MATCH を使う。それ以外は name/description を OR `LIKE` で検索し、JavaScript で新しい順の relevance を付けてから `rerank` を呼ぶ。
- [x] **手順 3: graph/PPR テストを作成する。** 重み付き無向の membership/triple/manual link、自己ループ除外、正規名と alias の seed 解決、dangling mass 保存、孤立/未知 seed、memory のみの出力を網羅する。
- [x] **手順 4: 連想検索を実装する。** 候補 pool は `Math.max(limit * 5, 200)` とし、bm25/PPR の両経路で正規化前に filter を適用する。最終 slice だけ hydrate し、PPR が空なら rerank 済み FTS hit に fallback する。
- [x] **手順 5: 時間減衰と supersession を追加する。** 両検索経路へ `final = normalize(relevance) + 0.2 * decay - (superseded ? 0.5 : 0)` を適用する。user/feedback の減衰は無効にし、6 種類全ての読み取り結果へ `superseded_by` を付与する。
- [x] **手順 6: 評価を実行する。** `pnpm tsx scripts/eval-recall.ts docs/eval/gold-queries.json` の前に Markdown からクリーンな索引を再構築する。動的 subset ごとの recall@5 と MRR を報告し、`feat: add hybrid FTS and associative recall` でコミットする。

#### タスク 3/4 の検証記録（2026-09-05）

- TDD でコアサービス、KG、reconcile、project lock、atomic failure、FTS trigram/LIKE、PPR、連想検索、RRF、時間減衰、supersession、評価メトリクスのテストを先行して追加した。
- `MemoryService` の非同期書き込みを local `KeyedMutex` または Vercel の Redis lease lock へ接続し、Markdown を正本として DB/KG/FTS を再構築可能にした。
- `pnpm vitest run tests/lib/memory tests/lib/lock tests/storage/atomic-failure.test.ts`、`pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm test`、`NODE_ENV=production pnpm build` が成功した。
- 検証時点の全体結果は 34 test suites・91 tests。リモート Turso の FTS5 互換性はタスク 0 の合格記録を使用した。
- 2026-09-06 に `RemoteMemoryService`、remote PPR、MCP/UI の非同期 read path を追加した。Vercel ではローカル filesystem を開かず、Blob を先に確保して Turso の index/KG/FTS transaction を更新する。レビュー対応として削除 tombstone、Blob prefix/hash検証、project scoped reindex、remote rename、Vercel Redis lock固定、owner/curator maintenance認可、reindexのobject単位savepointを追加した。save/get/search/update/reindex/forget/rename の adapter 契約テストを含め、全 65 suite・168 tests、lint、型検査、production build が成功した。

### タスク 5: MCP スキーマ、ツール、ステートレス Vercel トランスポート

**対象ファイル:**
- 作成・変更: `src/lib/mcp/schemas.ts`, `src/lib/mcp/server.ts`, `src/lib/mcp/session.ts`, `src/lib/mcp/transport.ts`, `src/lib/mcp/context.ts`, `src/lib/mcp/auth.ts`, `src/lib/auth/access.ts`, `src/lib/mcp/tools/{read,write,meta,compose,util}.ts`, `src/app/api/mcp/route.ts`。
- テスト: `tests/lib/mcp/*`, および `tests/lib/mcp/vercel-stateless.test.ts`。

**インターフェース:**
- 実装する: `ToolContext { projectId: string; svc: MemoryService; canWriteShared?: boolean }`、`createMcpServer(ctx)`、`handleMcpRequest(req, opts?)`、`resetSessionState()`。
- `handleMcpRequest` は `{ mode?: 'local-session' | 'vercel-stateless'; timeoutMs?: number }` を受け取る。`VERCEL=1` なら既定 mode は `vercel-stateless`、それ以外は `local-session` とする。

- [x] **手順 1: スキーマ／description テストを先に書く。** 16 ツール、必須フィールド、入れ子の `.describe()`、strict な `ReindexInput`、空でない `entities`/`why`/`how_to_apply`、§9.5–§9.7 の description 文言を全て検証する。
- [x] **手順 2: schema と tool handler を実装する。** 返却は text content のみにする。`composeWhyHowBody` は冪等に使い、reference URL を追記し、全書き込みを非同期サービスと共有ゲートへ通す。
- [x] **手順 3: ローカルセッション mode を実装する。** `${projectId}#${canWriteShared ? 'rw' : 'ro'}` ごとに `Promise<Session>` を cache し、reject された promise を削除する。ID 付き message だけを解決し、30 秒の JSON-RPC timeout は HTTP 200 と error `-32000` で返す。
- [x] **手順 4: Vercel stateless mode を実装する。** 各 request で新しい SDK server/transport を作り、内部で合成 `initialize` handshake を行い、受信した JSON-RPC message を dispatch して要求された response ID だけを返す。別の Vercel function instance に `globalThis` が残る前提を置かず、`Mcp-Session-Id` は診断用に受け付けるが永続 server object にはしない。
- [x] **手順 5: route guard を実装する。** `runtime='nodejs'`、`dynamic='force-dynamic'`、`maxDuration=60` を export する。POST だけを受け付け、project ID 欠落/不正は 400、maintenance token は header からだけ読み、GET/DELETE は 405 を返す。
- [x] **手順 6: MCP テストを実行する。** `pnpm vitest run tests/lib/mcp` を実行し、別々の Vercel invocation として `initialize`、`tools/list`、`tools/call` を送っても正しい応答が返るテストを追加する。`feat: expose stateless Vercel MCP endpoint` でコミットする。

#### タスク 5 の検証記録（2026-09-05）

- MCP SDK の `McpServer` / `InMemoryTransport` を使い、16 ツールの schema・description・text content 応答を実装した。`project_id` は URL query、maintenance token は header からのみ取得する。
- local-session は project と read/write 権限ごとの Promise cache、rejected promise の除去、ID 付き応答だけの解決を実装した。
- Vercel stateless mode は request ごとに server/transport を生成し、必要時に合成 initialize handshake を行う。`Mcp-Session-Id` は診断用 header として受け付けるが server object は永続化しない。
- `pnpm test`（42 suites・109 tests）、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build` が成功した。timeout はテストで短縮して HTTP 200 / JSON-RPC `-32000` を確認した。

### タスク 5-A: ユーザー認証、PAT、プロジェクト認可

**対象ファイル:**
- 作成: `src/lib/auth/config.ts`, `src/lib/auth/clerk.ts`, `src/lib/auth/schema.sql`, `src/lib/auth/migrate.ts`, `src/lib/auth/connection.ts`, `src/lib/auth/store.ts`, `src/lib/auth/pat.ts`, `src/lib/auth/access.ts`, `src/proxy.ts`。
- 作成: `src/app/sign-in/[[...sign-in]]/page.tsx`, `src/app/sign-up/[[...sign-up]]/page.tsx`, `src/app/settings/tokens/page.tsx`, `src/app/api/auth/tokens/route.ts`, `src/app/api/projects/[id]/members/route.ts`。
- 作成: `tests/lib/auth/pat.test.ts`, `tests/lib/auth/access.test.ts`, `tests/lib/auth/csrf.test.ts`, `tests/app/auth.routes.test.ts`, `tests/app/project-membership.test.ts`。

**インターフェース:**
- `getWebPrincipal(): Promise<{ userId: string } | null>` — Clerk の `auth()` を使う。
- `requireMcpPrincipal(req): Promise<{ userId: string; tokenId: string }>` — `Authorization: Bearer ltm_...` を SHA-256 で照合し、失効・期限切れ・無効 audience を拒否する。
- `assertProjectAccess(principal, projectId, action: 'read' | 'write' | 'maintain'): Promise<void>` — `projects` と `project_members` を認証 DB から確認する。
- `createPat(userId, label, expiresAt?): Promise<{ token: string; tokenId: string }>`、`revokePat(userId, tokenId): Promise<void>` — 平文 token は返却時だけ保持する。

- [x] **手順 1: 認証境界の失敗テストを書く。** 未認証は UI/API/MCP 全て 401、membership なしは 403、期限切れ・失効 PAT・不正 scheme・空 Bearer は 401、`__shared__` の通常書き込みは 403、maintenance token と curator principal の両方が一致した場合だけ maintain を許可することを固定する。
- [x] **手順 2: 認証 DB を実装する。** memory の再構築対象とは別の local `auth.db` / Vercel の `TURSO_AUTH_DATABASE_URL`・`TURSO_AUTH_DATABASE_TOKEN` に `auth_schema_version`, `projects`, `project_members`, `mcp_tokens` を作り、owner/member role と token hash の一意制約を設ける。`index.db` の `REBUILDABLE_TABLES` に認証テーブルを混ぜない。
- [x] **手順 3: Clerk の UI 認証を実装する。** `clerkMiddleware()` を `src/proxy.ts` に置き、`/sign-in` と `/sign-up` 以外の UI/API を保護する。`ClerkProvider`、`auth()` の非同期利用、ログアウト、未認証時のリダイレクトを実装する。
- [x] **手順 4: PAT 管理画面を実装する。** ラベル・期限を受け取り、作成直後に一度だけ表示する。一覧には prefix、作成日時、最終利用、期限、失効状態だけを表示し、再表示や平文復元をできなくする。
- [x] **手順 5: project membership を実装する。** `POST /api/projects` で slug の所有権を作成し、最初のユーザーを owner にする。owner は member の招待・削除・role 変更ができ、`list_projects` と横断検索は principal が read 権限を持つ project だけを返す。`project_id` は引き続き URL 由来で、認可の対象を選ぶ値として扱う。
- [x] **手順 6: CSRF/CORS とレート制限を実装する。** Web の PUT/DELETE/POST は `Origin` と `Host` の同一性を検証し、MCP は allowlist 以外の Origin を拒否する。Upstash Redis で user/token 単位の失敗レートを制限し、401/403 の理由に token の値を含めない。
- [x] **手順 7: 認証テストを実行してコミットする。** `pnpm vitest run tests/lib/auth tests/app/auth.routes.test.ts tests/app/project-membership.test.ts` を実行し、`feat: add Clerk authentication and project authorization` でコミットする。
#### タスク 5-A の検証記録（2026-09-06）

- 認証 DB を memory index と分離し、local `auth.db` / Vercel Turso adapter に schema version、projects、members、hash-only PAT を実装した。
- Clerk `clerkMiddleware`、`ClerkProvider`、sign-in/sign-up、PAT 設定画面、token/membership API を追加した。
- MCP は `AUTH_REQUIRED=1` または `VERCEL=1` で PAT と project membership を先に検証し、shared write は curator user と maintenance token の二重条件も検証する。mutation API は Origin/Host の same-origin と CORS allowlist を確認する。
- `pnpm vitest run tests/lib/auth tests/app/auth.routes.test.ts tests/app/project-membership.test.ts tests/lib/mcp`、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build` が成功した。

### タスク 6: 共有スコープとテレメトリ／ダッシュボード

**対象ファイル:**
- 作成・変更: `src/lib/telemetry/{schema,migrate,store,recorder,instrument,catalog,query,connection,window}.ts`, `src/lib/mcp/tools/read.ts`, `src/lib/mcp/tools/write.ts`, `src/lib/mcp/server.ts`, `src/lib/auth/access.ts`。
- 作成: `src/app/dashboard/page.tsx`, `src/components/dashboard/{Bar,Delta,Sparkline}.tsx`。
- テスト: `tests/lib/telemetry/*`, `tests/lib/mcp/tools.read.shared.test.ts`, `tests/lib/mcp/tools.write.shared.test.ts`, `tests/app/dashboard.test.ts`。

**インターフェース:**
- 実装する: `getTelemetryStore()`、`recordToolCall()`、`recordConnect()`、`telemetryEnabled()`、`summarize()`、`dailySeries()`、`perTool()`、`perProject()`、`errorBreakdown()`、`curatorStatus()`。
- ローカルの telemetry は `<LTM_HOME>/telemetry.db`、Vercel は別 Turso URL 組（`TURSO_TELEMETRY_DATABASE_URL` / `TURSO_TELEMETRY_AUTH_TOKEN`）を使い、memory index の再構築でイベント履歴を失わないようにする。

- [x] **手順 1: 共有スコープのテストを作成する。** 既定マージ、`include_shared:false`、project 優先の同名衝突、10/50 の上限、get/find fallback、source refs、token 安全な書き込み、Web API の read-only 動作を網羅する。
- [x] **手順 2: 読み取りマージと書き込みゲートを実装する。** `scope`、`superseded_by`、project-first 連結、RRF `k=60`、`SHARED_INDEX_CAP`/`SHARED_SEARCH_CAP` を追加する。現在の project が `__shared__` の場合はマージしない。
- [x] **手順 3: テレメトリテストを作成する。** opt-out、エラー正規化、引数/本文の生データを保存しないこと、session 帰属バイアス、JST 窓、R1 抑制、R4、R6、呼び出しゼロの tool catalog を網羅する。
- [x] **手順 4: テレメトリ adapter と計測を実装する。** initialize で connect を記録し、registrar wrapper 経由で tool call を記録する。障害後は一度だけ警告して無効化し、MCP 応答を壊さない。
- [x] **手順 5: `/dashboard` を実装する。** `days` は既定 30・上限 365、`project` は任意とし、`6.4` の指標を正確に計算する。7/30/90 のリンクを表示し、全日付を `formatJst` で整形する。
- [x] **手順 6: テストを実行してコミットする。** `pnpm vitest run tests/lib/telemetry tests/lib/mcp/tools.*.shared.test.ts tests/app/dashboard.test.ts` を実行し、`feat: add shared scope and usage telemetry` でコミットする。

#### タスク 6 の検証記録（2026-09-06）

- 共有読み取りの project-first dedup、`include_shared:false`、get/find fallback、source refs、RRF の search、10/50 cap、`__shared__` の非マージ、および shared write の無効 token/read-only/完全一致 gate を追加テストで固定した。
- `telemetry.db` を memory index と分離し、local は `<LTM_HOME>/telemetry.db`、Vercel は `TURSO_TELEMETRY_DATABASE_URL` / `TURSO_TELEMETRY_AUTH_TOKEN` の別 Turso DB を使う遅延 adapter とした。13 列 schema、stepwise migration、`LTM_TELEMETRY=0` opt-out、障害時の一度だけの警告を実装した。
- MCP の `initialize` ごとに UUID session を発行して connect を記録し、`registerTool` wrapper で kind・成功/失敗・所要時間・result count/chars・maintenance だけを保存する。引数、本文、エラー原文、token はイベントへ保存しない。
- JST 日境界、前期間比較、全 16 tool catalog、project/tool/error 集計、R1/R4/R6 を含む `/dashboard`（7/30/90 preset、`days` 上限 365、project filter）を実装した。
- `pnpm test`（56 suites・133 tests）、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build` が成功した。

### タスク 7: REST API、UI ページ、KG グラフ

**対象ファイル:**
- 作成・変更: `src/lib/http.ts`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`, `src/app/search/page.tsx`, `src/app/p/[slug]/*`, `src/app/api/projects/route.ts`, `src/app/api/memories/[id]/route.ts`。
- 作成: `src/components/Header.tsx`, `src/components/MemoryEditor.tsx`, `src/components/DeleteMemoryButton.tsx`, `src/components/KgGraph.tsx`, `src/lib/graph/builder.ts`, `src/lib/graph/kg-view.ts`。
- テスト: `tests/app/api.projects.test.ts`, `tests/app/api.memories.test.ts`, `tests/app/api.memories.shared.test.ts`, `tests/lib/graph/build-kg-graph.test.ts`, `tests/lib/graph/kg-view.test.ts`。

**インターフェース:**
- API route は `runtime='nodejs'` と `dynamic='force-dynamic'` を export する。`PUT` は description/body/tags/links の strict patch だけを受け付け、`DELETE` は完全な非同期削除を行う。
- 実装する: `buildKgGraph(data)`、`filterKgGraph(graph, filters)`、`kgNeighbors(graph, nodeId)`。node/edge の種類と重みは §12 に合わせる。

- [x] **手順 1: API テストを作成する。** project ID の欠落/不正、壊れた JSON、データを失わない strict patch 拒否、404/403/500 の対応、PUT/DELETE 成功、shared read-only を網羅する。
- [x] **手順 2: API route を実装する。** query slug を `isValidSlug || isReservedProjectId` で検証し、singleton service だけを呼び出す。正確な content type と status の `jsonResponse`/`errorResponse` を返す。
- [x] **手順 3: ページ/graph テストを作成する。** 全 route が Next.js 16 の Promise 型 params/searchParams を await すること、不正 slug の表示文、shared page で edit/delete を隠すこと、非表示 node に接続する edge が graph filter で落ちることを検証する。
- [x] **手順 4: server page と client component を実装する。** project/type/tag/search page、Markdown 表示、editor の preview/save/delete、superseded badge、§12.3 の React Flow/d3-force 二段階 layout と styling を追加する。
- [x] **手順 5: UI/API テストと build を実行する。** `pnpm test` と `pnpm build` を実行し、`feat: add memory browser and knowledge graph UI` でコミットする。

#### タスク 7 の検証記録（2026-09-06）

- PUT/DELETE /api/memories/[id] に project slug 検証、strict patch、JSON エラー、MemoryNotFound、500、同一オリジン、shared read-only の契約を追加し、厳密な JSON/text の Content-Type を返すようにした。
- /、/search、project/type/tag/memory detail/edit、/graph を Next.js 16 の Promise params/searchParams と dynamic Node route で実装した。shared scope では編集・削除UIを表示せず、詳細では Markdown、entities/aliases、triples、source refs、supersession を表示する。
- buildKgGraph と表示フィルタを実装し、React Flow の memory/entity ノード、membership/triple/link 辺、タグ絞り込み、近傍フォーカス、d3-force の形状変更時だけの座標計算、memory-only 表示を追加した。
- 対象テスト 16 件、pnpm test（60 suite・145 tests）、pnpm lint、pnpm exec tsc --noEmit、NODE_ENV=production pnpm build が成功した。


### タスク 8: Vercel デプロイ、環境変数、CI/CD

**対象ファイル:**
- 作成・変更: `vercel.json`, `.env.example`, `.github/workflows/test.yml`, `.github/workflows/vercel.yml`, `next.config.ts`, `src/app/api/mcp/route.ts`, `Dockerfile`, `docker-compose.yml`。

**インターフェース:**
- Vercel 必須環境変数: `LTM_STORAGE_DRIVER=vercel`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`、`TURSO_AUTH_DATABASE_URL`、`TURSO_AUTH_DATABASE_TOKEN`、`TURSO_TELEMETRY_DATABASE_URL`、`TURSO_TELEMETRY_AUTH_TOKEN`、`BLOB_READ_WRITE_TOKEN`、`UPSTASH_REDIS_REST_KV_REST_API_URL`、`UPSTASH_REDIS_REST_KV_REST_API_TOKEN`、`LTM_MAINTENANCE_TOKEN`、`LTM_CURATOR_USER_ID`、`LTM_BOOTSTRAP_OWNER_USER_ID`（初回移行時のみ）、`LTM_BLOB_PREFIX`、`MCP_PUBLIC_URL`、`MCP_ALLOWED_ORIGINS`、`AUTH_REQUIRED=1`、`CLERK_SECRET_KEY`、`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`、`NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`、`NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`。手動構成では `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` を互換名として使える。
- CI secret は `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。これらや実在する `.env` は絶対にコミットしない。

- [x] **手順 1: Vercel と Clerk を構成する。** Node.js runtime、`maxDuration`、`pnpm build`、`pnpm install --frozen-lockfile`、Edge route 無しを設定する。Vercel Marketplace で Clerk を接続して `CLERK_SECRET_KEY` と `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` を投入し、Blob は private、リージョンは Turso primary の近くにする。
- [x] **手順 2: deploy preflight を追加する。** CI で `pnpm test`、`pnpm lint`、`pnpm build`、Turso FTS probe、使い捨て DB への migration dry-run を deploy 前に実行する。
- [x] **手順 3: preview/production workflow を追加する。** Vercel CLI の version を固定し、`vercel pull --yes`、`vercel build`、`vercel deploy --prebuilt` を実行する。PR ごとに preview を配備し、MCP の `initialize`/`tools/list` smoke を実行して 16 ツールを確認した後だけ promote する。
- [x] **手順 4: production rollback 手順を追加する。** `vercel inspect`、`vercel logs`、`vercel promote`、`vercel rollback` を文書化する。DB migration は migrate/probe → promote の二段階で行い、promote 成功前に旧 Blob 世代を削除しない。
- [x] **手順 5: ローカル配布を動作可能なまま維持する。** Dockerfile の明示的な `schema.sql` copy、`/data` bind mount、port 3939、`scripts/start-mcp.sh` の PID 単位重複チェックを保持する。Docker はローカル/オフライン mode であり Vercel 本番 runtime ではないことを明記する。
- [ ] **手順 6: deploy smoke テストを実行してコミットする。** `POST <MCP_PUBLIC_URL>/api/mcp?project_id=smoke` に `tools/list` を送り、一時 save/get/delete と dashboard 200 を確認する。`ci: add Vercel preview and production deployment` でコミットする。

#### タスク 8 の検証記録（2026-09-06）

- Vercel function設定、Next.jsのproduction security headers、Vercel/Clerk/Turso/Blob/Upstashのenvサンプル、Node 22 + pnpm frozen install、Dockerの明示的schema copy・/data bind mount・3939 portを追加した。
- GitHub Actionsに通常preflight（test/lint/migration dry-run/production build）、資格情報がある場合のTurso probe、Vercel CLI 41.7.3固定のpreview/candidate deploy、smoke後のproduction promoteを追加した。
- scripts/preflight-migration.ts、scripts/vercel-smoke.ts、scripts/start-mcp.shを追加し、Blob key prefixをLTM_BLOB_PREFIXで環境分離できるようにした。rollback、migration順序、orphan GC、Docker、MCP client再起動の手順をdocs/vercel-operations.mdへ記録した。
- pnpm install --frozen-lockfile、Task8対象テスト13件、pnpm test（62 suite・153 tests）、pnpm lint、pnpm exec tsc --noEmit、NODE_ENV=production pnpm build、YAML/JSON構文、bash -n scripts/start-mcp.shが成功した。
- Docker CLIが環境に無くComposeの実解釈は未実行。2026-09-06 に Vercel CLI で preview deployment（dpl_3SjkG9qMUuFzqaJu4UmJurvcymuB）を作成し、vercel inspect で Ready を確認した。MCP認証付き preview smoke は PAT 等の secret 未提供のため未実行で、CI workflowと実行スクリプトは用意済み。

### タスク 9: curator、Claude Code 資産、リモート運用

**対象ファイル:**
- 作成・変更: `skills/long-term-memory/SKILL.md`, `skills/shared-memory-curator/SKILL.md`, `claude-config/hooks/ltm-init-reminder.sh`, `claude-config/claude-md-block.md`, `docs/post-mcp-setup.md`, `scripts/sync-embedded-docs.mjs`, `scripts/curator/*`, `launchd/*`。
- 作成: `scripts/curator/export-remote-snapshot.ts`, `.github/workflows/curator.yml`, `docs/mcp-config.vercel.json`。
- テスト: `tests/docs/post-mcp-setup.test.ts`, `tests/curator/remote-snapshot.test.ts`。

**インターフェース:**
- `docs/mcp-config.vercel.json` は `${MCP_PUBLIC_URL}/api/mcp?project_id=<slug>` を指し、`Authorization: Bearer ${LTM_MCP_TOKEN}` と `X-LTM-Maintenance-Token`（curator のみ）を送る。PAT は UI で発行し、設定ファイルへ平文をコミットしない。
- `export-remote-snapshot.ts` はデプロイ済み MCP endpoint から `list_projects`、`get_memory_index`、`get_memory` を取得し、headless curator 用の一時的で秘密を含まない Markdown snapshot を書き出す。

- [x] **手順 1: クライアントの動作契約を保持する。** skill の能動検索ルール、hook の作業ターンごとの一度だけの提醒、初回全索引の提醒を出さない規則、CLAUDE.md の 6 つの MUST ルール、§14 が要求する全 description 文言を保持する。
- [x] **手順 2: 埋め込み docs を決定的にする。** `docs/post-mcp-setup.md` の sentinel を置換し、sentinel が 0 個なら拒否する。埋め込み内容に triple backtick が含まれる場合はより長い fence を使い、`--check` は drift 時に exit 1 とする。
- [x] **手順 3: リモート curator mode を追加する。** デプロイ済み MCP からサニタイズ済み snapshot を取得し、同じ `claude -p` 権限（`--tools Read Grep Glob`、`--setting-sources user`、strict MCP config）で実行する。PAT は GitHub Actions secret または macOS の chmod 600 env ファイルから Bearer として渡し、MCP config は localhost ではなく Vercel URL を指す。
- [x] **手順 4: Vercel 外でスケジュールする。** ローカル store は macOS launchd で維持し、remote mode は 01:00 UTC（10:00 JST）の GitHub Actions cron を追加する。dry-run では全 write tool を省略し、成功 stamp 更新前に厳密な `CURATION SUMMARY` state machine を要求する。
- [x] **手順 5: 資産テストを実行してコミットする。** `pnpm vitest run tests/docs tests/curator` を実行し、`feat: add Vercel-aware curator and Claude Code assets` でコミットする。

#### タスク 9 の検証記録（2026-09-06）

- long-term-memory skill、shared-memory-curator skill、Claude Code hook、CLAUDE.md MUST block、1本化したpost-mcp-setup prompt、決定的embed同期を追加した。get_memory_indexを入口にしない能動検索、subagentへの検索引き渡し、hookの1セッション1回制御を保持している。
- local/remote curator wrapperにDRY_RUNの外部指定退避、staged配置の絶対パス/TCC検査、Read/Grep/Glob限定、strict MCP config、dry-run時の全write tool禁止、CURATION SUMMARY state machine、last-success保護を実装した。
- MCPのlist_projects/get_memory_index/get_memoryから秘密をサニタイズした一時Markdown snapshotを作るexport script、Vercel MCP config、local MCP config、self-hosted Claude CLIを使う01:00 UTCのremote curator workflow、install script、launchd template、env exampleを追加した。
- pnpm test（64 suite・160 tests）、pnpm lint、pnpm exec tsc --noEmit、NODE_ENV=production pnpm build、YAML/JSON構文、sync --check、curator/hook bash -n、hook 3-turn checkが成功した。Task9対象テストは5件。
- Vercel CLIの認証確認（vercel whoami）、preview deploy、vercel inspect による Ready 確認が成功した。実remote snapshot/curator実行は PAT と maintenance token 等の secret が必要なため未実行。

### タスク 10: 完全受け入れ、可観測性、引き渡し

**対象ファイル:**
- 変更: `README.md`、`README.en.md`、`docs/architecture.md`、`docs/mcp-setup.md`、`docs/reproduction-spec.md`（実装固有の Vercel 追補が必要な場合のみ）。規範要件を書き換えない。
- 作成: `docs/vercel-operations.md`, `docs/eval/vercel-smoke.json`。

- [ ] **手順 1: unit/integration テスト一式を実行する。** `pnpm test`、`pnpm lint`、`pnpm build` を実行し、仕様書の 69 テストファイルに加えて provider/lock/stateless テストも通ることを確認する。
- [ ] **手順 2: クリーン reindex 訓練を実行する。** 使い捨て store へ Markdown object だけをコピーし、索引を削除して `reindex` を実行する。全 memory、tag、link、entity、triple、`body_chars`、supersession marker が正本と一致することを比較する。
- [ ] **手順 3: Vercel end-to-end smoke を実行する。** preview URL に対して MCP initialize、16 ツール列挙、KG 付き project memory の save、日本語部分文字列と entity による search、UI/API からの read、telemetry/dashboard 件数、shared read-only/write-token 動作を確認し、最後に削除する。
- [ ] **手順 4: 耐障害性チェックを実行する。** Blob 障害、Turso 一時エラー、Redis lock 競合、function instance 変更を強制し、retry/reconcile で最後の可視状態が保たれること、raw token/body が log/telemetry に入らないことを確認する。
- [ ] **手順 5: 運用手順を文書化する。** Marketplace provisioning（Turso、Blob、Upstash）、env 名、migration 順序、preview promote、rollback、orphan GC、curator scheduling、tool description 変更後に Claude Code を再起動する要件を記録する。
- [ ] **手順 6: 計画を自己レビューする。** §1–§19 の全要件に task があること、`TBD`/`TODO`/曖昧な placeholder がないこと、全 interface 名が後続参照と一致することを確認し、その後に計画完了とする。

## フェーズゲート

1. **ゲート 0:** 足場が build でき、Turso probe が SQLite 必須機能を通過する。
2. **ゲート 1:** Markdown round-trip と両ストレージ adapter の契約テストが通る。
3. **ゲート 2:** local/Turso 索引の migration/rebuild と失敗順序テストが通る。
4. **ゲート 3:** コアサービス、KG、FTS、PPR、rerank、評価テストが通る。
5. **ゲート 4:** local-session と Vercel-stateless MCP の両方が 16 ツールを公開する。
6. **ゲート 5:** 共有スコープ、認証／認可、テレメトリ、REST/UI、グラフ、ダッシュボードのテストが通る。
7. **ゲート 6:** Clerk サインイン＋PAT を含む preview の initialize/tools-list/save/search/read/delete smoke と CI promotion が通る。
8. **ゲート 7:** curator dry-run、remote snapshot、全受け入れ、clean reindex が通る。

## リスク判断

- **Turso 機能不一致:** FTS5 trigram/contentless delete は hard gate とする。Postgres `pg_trgm` へ黙って置き換えると規範の FTS5 契約に違反するため、未対応なら downgrade せず停止する。
- **Vercel の一時 instance:** Vercel transport は request ごとに stateless であり、in-memory session cache を信頼しない。local mode だけは仕様どおり Promise cache を保持する。
- **サービス間の原子性:** Blob と DB は transaction を共有できない。immutable Blob 世代、DB pointer の commit/order、orphan GC で可視状態と復旧を担保し、テストで利用者から見える不変条件を検証する。
- **Curator 実行:** Vercel Functions には Claude CLI や durable local store を置かない。production scheduler は外部で動かし、Clerk/PAT と maintenance token の両方でデプロイ済み MCP に接続する。launchd/Docker はローカル用に残す。
- **認証:** Clerk の session cookie を MCP に長期流用しない。PAT は hash 保存・一度だけ表示・明示失効とし、project membership を全データアクセスの前提にする。

計画は `docs/superpowers/plans/2026-09-05-vercel-long-term-memory.md` に保存しました。実行方法は次の 2 つです。

**1. サブエージェント駆動（推奨）** — タスクごとに新しいサブエージェントを割り当て、タスク間でレビューする

**2. インライン実行** — `executing-plans` を使い、このセッションでチェックポイントを挟みながら実行する

どちらの方法にしますか？
