# long-term-memory 完全再現仕様書

> **この文書の目的**: このリポジトリのプログラムを、ソースコードを見ずに**別のエージェント（Codex 等）が一から再実装できる**ようにする。
> 対象コミット: 初版 `59e8375`（2026-08-02）以降、本文へ継続的に追随（直近反映: `18c1330`, 2026-09-03 — テレメトリ R1 バイアス訂正・ダッシュボード拡張）。
> 「なぜそうなっているか」は [docs/architecture.md](architecture.md) と [CLAUDE.md](../CLAUDE.md) にもあるが、**本書が実装契約としての正本**。両者に差異がある場合は本書を採る（§18 に既知のドリフトを記載）。

---

## 目次

| # | セクション | 何が書いてあるか |
|---|---|---|
| 0 | [使い方](#0-この文書の使い方) | Codex への渡し方、分割単位 |
| 1 | [成果物の定義](#1-成果物の定義完成条件) | 何を作れば「再現できた」か |
| 2 | [技術スタック](#2-技術スタックと固定バージョン) | 依存とバージョン、設定ファイル全文 |
| 3 | [ファイル構成](#3-ファイル構成) | 作るべきファイル一覧と役割 |
| 4 | [環境変数](#4-環境変数) | 全 env と既定値・効き先 |
| 5 | [データモデル（正本）](#5-データモデル正本-markdown) | frontmatter 仕様・serialize/parse 規則 |
| 6 | [SQLite スキーマ](#6-sqlite-スキーマと-migration) | schema.sql 全文・再構築 migration |
| 7 | [コアレイヤ](#7-コアレイヤ実装仕様) | paths / slug / markdown / db / mutex / kg / reconcile / MemoryService |
| 8 | [検索](#8-検索仕様) | FTS5 trigram・bm25・PPR・RRF |
| 9 | [MCP レイヤ](#9-mcp-レイヤ) | 16 ツールの完全なスキーマと description |
| 10 | [共有スコープ](#10-共有スコープ-__shared__) | `__shared__` の読み書き規則 |
| 11 | [REST API / Web UI](#11-rest-api-と-web-ui) | ルート表と各ページの責務 |
| 12 | [グラフ可視化](#12-グラフ可視化-kggraph) | React Flow + d3-force |
| 13 | [配布・運用](#13-配布運用docker--scripts--launchd) | Docker / compose / curator / launchd |
| 14 | [クライアント資産](#14-クライアント側資産claude-code-側) | skill / hook / CLAUDE.md / install.sh |
| 15 | [テスト仕様](#15-テスト仕様受け入れ条件) | 69 ファイル・全ケース＝受け入れ条件 |
| 16 | [実装順序](#16-実装順序とフェーズゲート) | フェーズ 0–11 と Vercel 認証オーバーレイのゲート |
| 17 | [落とし穴](#17-再現時に必ず踏む落とし穴チェックリスト) | 踏む前に読むべき 20 項目 |
| 18 | [既知のドリフト・非目標](#18-既知のドリフトと非目標) | 本書と既存 docs の差、作らないもの |
| 19 | [Vercel 公開時の認証・認可](#19-vercel-公開時の認証認可) | Clerk、PAT、プロジェクト権限、公開運用 |

---

## 0. この文書の使い方

Codex に一括で渡すと文脈が溢れる。**フェーズ単位で切って渡す**のが前提。

```mermaid
flowchart LR
    A["§1-§4<br/>スコープ・環境"] --> B["§5-§7<br/>コア（TDD 可能）"]
    B --> C["§8<br/>検索"]
    C --> D["§9-§10<br/>MCP"]
    D --> E["§11-§12<br/>REST + UI"]
    E --> F["§13-§14<br/>運用・クライアント"]
    G["§15 テスト一覧"] -.->|"各フェーズの受け入れ条件"| B & C & D & E
    H["§17 落とし穴"] -.->|"着手前に必ず読む"| B & C & D & E
```

各フェーズは **§15 のテストケースが受け入れ条件**。テストを先に書いて（TDD）から実装させると再現度が上がる。§17 の落とし穴は、実装中に必ず一度は踏むもので、知らずに進めると「動くが仕様と違う」状態になる。

---

## 1. 成果物の定義（完成条件）

**Claude Code 用の長期記憶 MCP サーバ + 閲覧 UI。Next.js 単一アプリで MCP エンドポイント (`/api/mcp`) と Web UI を同居させる。**

### 1.1 満たすべき機能要件

| # | 要件 |
|---|---|
| F1 | MCP over Streamable HTTP を `POST /api/mcp?project_id=<slug>` で提供し、**16 ツール**を公開する |
| F2 | 記憶は `user` / `feedback` / `project` / `reference` / `session` の 5 型 |
| F3 | **markdown が正本**（`<LTM_HOME>/projects/<project_id>/memories/<name>.md`）、SQLite (`index.db`) は再構築可能な索引 |
| F4 | プロジェクトは URL クエリの `project_id` でパーティション。**ツール引数では渡さない** |
| F5 | 全文検索は SQLite FTS5（trigram トークナイザ、bm25 列重み付き） |
| F6 | 連想検索は Personalized PageRank（HippoRAG 方式）。エンティティ抽出は**クライアント（LLM）側**、サーバは LLM も埋め込みも持たない |
| F7 | 予約 project_id `__shared__` による全プロジェクト共通スコープ。読み取りは自動マージ、書き込みはトークンゲート |
| F8 | Web UI でプロジェクト一覧・記憶一覧・詳細・編集・削除・全文検索・知識グラフ可視化ができる |
| F9 | 起動時 `reconcile` で markdown → DB のドリフトを自動修復。`reindex` ツールで全再構築 |
| F10 | 書き込みは `project_id` 単位で直列化され、markdown / DB のどちらかだけが更新された状態を残さない |
| F11 | Vercel 公開時は Clerk 認証または MCP PAT を必須とし、project membership に基づく認可を全ての UI / REST / MCP 読み書きへ適用する |

### 1.2 満たすべき非機能要件

- **索引は使い捨て**: `index.db` を消しても markdown から完全復元できる。SQLite を直接 UPDATE する経路を作らない。
- **削除は完全削除**（soft delete なし）。
- **日時表示はすべて JST**（`Asia/Tokyo`）。内部保持は ISO 8601 UTC 文字列。
- **認証は実行環境で切り替える**。localhost の `AUTH_REQUIRED=0` は匿名アクセスを許可するが、Vercel の `AUTH_REQUIRED=1` は Clerk のブラウザセッションまたは MCP PAT を必須とする。共有スコープの maintenance token は認証済み curator に対する追加ゲートである。
- テスト 69 ファイル（§15）が緑。

---

## 2. 技術スタックと固定バージョン

### 2.1 ランタイム

| 項目 | 値 | 備考 |
|---|---|---|
| Node.js | 22.x（開発機 v22.15.0 / Docker `node:22-bookworm-slim`） | CI は 20 でも通る |
| パッケージマネージャ | pnpm（開発機 11.1.3 / CI `pnpm/action-setup@v3` version 9） | corepack 有効化前提 |
| ポート | **3939 固定**（`.mcp.json` と揃える） | `pnpm dev` 単体は Next.js 既定の 3000 になるので `PORT=3939` を付ける |

### 2.2 package.json（全文）

```json
{
  "name": "long-term-memory",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@clerk/nextjs": "^7.0.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@xyflow/react": "^12.10.2",
    "better-sqlite3": "^12.10.0",
    "d3-force": "^3.0.0",
    "gray-matter": "^4.0.3",
    "next": "16.2.6",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "react-markdown": "^10.1.0",
    "ulid": "^3.0.2",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/d3-force": "^3.0.10",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitest/coverage-v8": "^4.1.6",
    "eslint": "^9",
    "eslint-config-next": "16.2.6",
    "tsx": "^4.22.2",
    "typescript": "^5",
    "vitest": "^4.1.6"
  }
}
```

各依存の役割:

| 依存 | 用途 |
|---|---|
| `@modelcontextprotocol/sdk` | `McpServer` と `InMemoryTransport`。HTTP との橋渡しは自作（§9.3） |
| `@clerk/nextjs` | Vercel 公開時のブラウザ認証、セッション、サインイン／サインアップ |
| `better-sqlite3` | 同期 SQLite。FTS5 と WAL を使う。**ネイティブモジュール**（§17-1） |
| `gray-matter` | frontmatter の serialize / parse。YAML 1.1 の型強制に注意（§17-4, §17-5） |
| `ulid` | 記憶 ID・エンティティ ID（26 文字、時系列ソート可能） |
| `zod` | MCP ツール入力スキーマ + `MemorySchema` の実行時検証 |
| `@xyflow/react` + `d3-force` | 知識グラフ可視化（React Flow ノード + force レイアウト） |
| `react-markdown` | 記憶本文のレンダリング（詳細ページ・編集プレビュー） |
| `tsx` | `scripts/eval-recall.ts` の実行 |

### 2.3 設定ファイル（全文）

**`next.config.ts`** — ネイティブモジュールを外部化しないと build が失敗する（§17-1）:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
```

**`tsconfig.json`** — `strict: true`、パスエイリアス `@/* → ./src/*`、`include` に `**/*.mts` を含める（`scripts/sync-embedded-docs.mjs` 用ではなく `.mts` 対応）:

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts", "**/*.mts"],
  "exclude": ["node_modules"]
}
```

**`vitest.config.ts`** — `tests/**` のみ、node 環境、`@` エイリアスを tsconfig と揃える:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'] },
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
});
```

**`eslint.config.mjs`**:

```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
```

**`pnpm-workspace.yaml`** — ネイティブビルドを許可するパッケージを明示（pnpm 10+ は既定でビルドスクリプトを実行しない）:

```yaml
allowBuilds:
  better-sqlite3: true
  esbuild: true
  sharp: true
  unrs-resolver: true
onlyBuiltDependencies:
  - better-sqlite3
  - esbuild
  - sharp
  - unrs-resolver
```

**`.github/workflows/test.yml`**:

```yaml
name: test
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
```

**`.gitignore` の要点**（Next.js 既定に加えて）:

```gitignore
.env*
!.env.example
.ltm-dev.log
/.long-term-memory        # 末尾 / を付けない（.long-term-memory.tgz も覆う）
/.long-term-memory.*
*.backup
*.bak
*.orig
/.superpowers/
/.mcp.json
```

**`.dockerignore`**:

```
.git
.github
.claude
.next
node_modules
.ltm-dev.log
*.log
docs
tests
coverage
.mcp.json
.DS_Store
```

---

## 3. ファイル構成

### 3.1 全体像

```
long-term-memory/
├── AGENTS.md                   # エージェント向け開発・更新ルール
├── src/
│   ├── app/                    # Next.js App Router（UI + API + MCP）
│   ├── components/             # クライアントコンポーネント 4 つ
│   └── lib/                    # ロジック（テスト対象の中心）
├── tests/                      # Vitest 69 ファイル
├── scripts/                    # 起動・評価・curator・docs 同期
├── skills/                     # Claude Code skill（利用側 + curator 側）
├── claude-config/              # クライアント資産インストーラ
├── launchd/                    # macOS 日次ジョブ plist テンプレ
├── docs/                       # 設計・運用・評価
├── Dockerfile / docker-compose.yml / .env.example
├── .devcontainer/Dockerfile / compose.yaml / devcontainer.json / README.md
└── 設定ファイル（§2.3）
```

### 3.2 `src/lib/` — ロジック層（役割表）

| ファイル | 行数目安 | 役割 | 仕様 |
|---|---|---|---|
| `paths.ts` | 27 | `LTM_HOME` 解決と保存先パス生成 | §7.1 |
| `slug.ts` | 34 | slug 検証・予約 project_id | §7.2 |
| `http.ts` | 12 | `jsonResponse` / `errorResponse` | §11.1 |
| `datetime.ts` | 16 | `formatJst`（Asia/Tokyo） | §7.9 |
| `markdown/frontmatter.ts` | 79 | `serializeMemory` / `parseMemoryString` | §5.2, §5.3 |
| `markdown/file-io.ts` | 25 | `atomicWriteText` / `readMemoryFile` / `computeHash` | §7.3 |
| `db/schema.sql` | 95 | スキーマ定義（正本） | §6.1 |
| `db/migrate.ts` | 91 | 再構築 migration（`CURRENT_VERSION = 5`） | §6.2 |
| `db/connection.ts` | 13 | `openDb`（WAL + FK + migrate） | §6.3 |
| `memory/types.ts` | 88 | `MemorySchema`（`supersedes` 含む） / `bodyChars` / エラー型 | §5.1 |
| `memory/mutex.ts` | 19 | `KeyedMutex` | §7.4 |
| `memory/kg.ts` | 100 | `applyMemoryKg` / `removeMemoryKg` | §7.5 |
| `memory/reconcile.ts` | 130 | `reconcile` / `reindex` | §7.6 |
| `memory/rrf.ts` | 21 | `rrfMerge` | §8.5 |
| `memory/rerank.ts` | 87 | 時間減衰 + supersede 降格の純関数（`rerank` / `decayFactor` / `normalizeRelevance`） | §8.6 |
| `memory/service.ts` | 851 | `MemoryService`（CRUD・検索・KG 読み出し・supersede） | §7.7 |
| `memory/singleton.ts` | 15 | プロセス内シングルトン | §7.8 |
| `graph/ppr.ts` | 99 | `personalizedPageRank` | §8.4 |
| `graph/assoc.ts` | 115 | 連想グラフ構築 + シード解決 + ランキング | §8.3 |
| `graph/builder.ts` | 61 | UI 用 KG 構築（`buildKgGraph`） | §12.1 |
| `graph/kg-view.ts` | 58 | 表示フィルタ・近傍計算 | §12.2 |
| `eval/metrics.ts` | 16 | `recallAtK` / `reciprocalRank` | §8.7 |
| `mcp/schemas.ts` | 144 | 全ツールの zod 入力スキーマ | §9.1 |
| `mcp/context.ts` | 16 | `extractProjectId` / `extractMaintenanceToken` | §9.4 |
| `mcp/auth.ts` | 14 | `grantsSharedWrite`（定数時間比較） | §10.3 |
| `auth/config.ts` / `auth/clerk.ts` | — | Clerk 初期化、Web principal 取得 | §19 |
| `auth/schema.sql` / `auth/migrate.ts` / `auth/connection.ts` | — | 認証 DB の schema version、migration、local/Turso 接続 | §19 |
| `auth/store.ts` / `auth/pat.ts` / `auth/access.ts` | — | PAT、project membership、アクセス判定 | §19 |
| `proxy.ts` | — | Clerk middleware と保護ルート | §19 |
| `mcp/server.ts` | 23 | `createMcpServer`（ToolContext 定義） | §9.2 |
| `mcp/session.ts` | 70 | transport セッションキャッシュ | §9.3 |
| `mcp/transport.ts` | 65 | HTTP ↔ JSON-RPC ブリッジ | §9.3 |
| `mcp/tools/read.ts` | 213 | 読み取り 6 ツール（共有マージ含む） | §9.5 |
| `mcp/tools/write.ts` | 181 | 書き込み 8 ツール（共有ゲート含む） | §9.6 |
| `mcp/tools/meta.ts` | 27 | `list_projects` / `reindex` | §9.7 |
| `mcp/tools/compose.ts` | 14 | `composeWhyHowBody` | §9.6 |
| `mcp/tools/util.ts` | 9 | `json` / `text`（MCP 結果ラッパ） | §9.2 |

### 3.3 `src/app/` と `src/components/`

| ファイル | ルート / 役割 |
|---|---|
| `app/layout.tsx` | ルートレイアウト（`<Header />` + `<main>`、metadata） |
| `app/globals.css` | 全 CSS（§11.4 に全文） |
| `app/page.module.css` | 未使用に近い Next.js テンプレ残り（142 行、任意） |
| `app/page.tsx` | `/` プロジェクト一覧 |
| `app/search/page.tsx` | `/search` 全プロジェクト横断全文検索 |
| `app/p/[slug]/page.tsx` | `/p/<slug>` 型別カウント |
| `app/p/[slug]/memories/page.tsx` | `/p/<slug>/memories?type=&tag=` 一覧 |
| `app/p/[slug]/memories/[name]/page.tsx` | 詳細（entities / triples / 本文 markdown） |
| `app/p/[slug]/memories/[name]/edit/page.tsx` | 編集（共有スコープは読み取り専用表示） |
| `app/p/[slug]/graph/page.tsx` | `/p/<slug>/graph` 知識グラフ |
| `app/api/mcp/route.ts` | `POST` のみ。GET/DELETE は 405 |
| `app/api/projects/route.ts` | `GET` プロジェクト一覧 JSON |
| `app/api/memories/[id]/route.ts` | `PUT` / `DELETE`（`__shared__` は 403） |
| `components/Header.tsx` | ヘッダ（brand / Projects / Search） |
| `components/MemoryEditor.tsx` | 編集フォーム（`'use client'`、プレビュー付き） |
| `components/DeleteMemoryButton.tsx` | 一覧からの削除ボタン（`confirm` 必須） |
| `components/KgGraph.tsx` | React Flow + d3-force（382 行、§12.3） |

### 3.4 その他

| ファイル | 役割 | 仕様 |
|---|---|---|
| `scripts/start-mcp.sh` | :3939 の二重起動を防いで dev server 起動 | §13.3 |
| `scripts/eval-recall.ts` | bm25 vs hybrid の recall@5 / MRR 比較 | §8.7 |
| `scripts/sync-embedded-docs.mjs` | docs 埋め込みブロックを正本から再生成 | §14.5 |
| `scripts/curator/run-curation.sh` | 日次 curator の headless 実行 wrapper（306 行） | §13.4 |
| `scripts/curator/install.sh` | curator 資産を TCC 非保護領域へステージ | §13.4 |
| `scripts/curator/env.example` / `ltm-shared-curator.mcp.json` | curator 設定テンプレ | §13.4 |
| `launchd/com.user.ltm-shared-curator.plist` | 日次 10:00 JST 実行テンプレ | §13.5 |
| `skills/long-term-memory/SKILL.md` | 利用側 skill（219 行） | §14.1 |
| `skills/shared-memory-curator/SKILL.md` | curator 用手順書（102 行） | §13.4 |
| `docs/post-mcp-setup.md` | skill / hook / CLAUDE.md ブロックを `~/.claude` に設置する手順（コピペプロンプト 1 本） | §14.4 |
| `claude-config/hooks/ltm-init-reminder.sh` | UserPromptSubmit hook（実作業前の検索リマインド、81 行） | §14.2 |
| `claude-config/claude-md-block.md` | `~/.claude/CLAUDE.md` に差し込む MUST ブロック | §14.3 |

---

## 4. 環境変数

| 変数 | 既定 | 効き先 | 説明 |
|---|---|---|---|
| `LTM_HOME` | `~/.long-term-memory` | サーバ | ストアのルート。`index.db` と `projects/` の親 |
| `LTM_MAINTENANCE_TOKEN` | (未設定) | サーバ | 共有スコープ書き込みトークン。**未設定なら `__shared__` は全員読み取り専用**（安全側既定） |
| `AUTH_REQUIRED` | `0`（local）/ `1`（Vercel） | サーバ | `1` では UI / REST / MCP の未認証アクセスを拒否 |
| `CLERK_SECRET_KEY` | (Vercel 必須) | サーバ | Clerk のサーバ検証キー。ログへ出さない |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | (Vercel 必須) | UI | Clerk の公開キー |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/sign-in` / `/sign-up` | UI | 認証ページのパス |
| `TURSO_AUTH_DATABASE_URL` / `TURSO_AUTH_DATABASE_TOKEN` | (Vercel 必須) | auth store | projects / members / PAT の永続 DB。memory index と分離 |
| `LTM_CURATOR_USER_ID` | (Vercel 必須) | MCP shared write | maintenance token と組み合わせる curator principal |
| `LTM_BOOTSTRAP_OWNER_USER_ID` | (初回移行時のみ) | auth store | 既存 project の owner を一度だけ割り当てる移行用 user id |
| `MCP_ALLOWED_ORIGINS` | `MCP_PUBLIC_URL` | MCP | CORS を許可する origin のカンマ区切り allowlist |
| `LTM_MCP_TOKEN` | (クライアント側のみ) | Claude Code / curator | 平文 PAT。サーバ側では保存しない |
| `PORT` | 3000（Next.js 既定） | サーバ | 本プロジェクトは 3939 前提 |
| `NODE_ENV` | — | サーバ | Docker runner では `production` |
| `LTM_STORE_HOST` | `./.long-term-memory` | docker compose のみ | ホスト側 bind mount 元。絶対 / `~/...` / 相対のいずれか |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | post-mcp-setup のプロンプト | クライアント資産の設置先 |
| `DRY_RUN` | `0` | curator / `scripts/curator/install.sh` | `1` で書き込みなし |
| `LTM_CURATOR_ENV` | `~/.config/ltm-curator/env` | curator | 未追跡 env ファイルの位置 |
| `CLAUDE_BIN` | `claude` | curator | staged 配置では**絶対パス必須** |
| `LTM_CURATOR_PATH` | 現在の `PATH` | curator | launchd は PATH を継承しないため node の場所を明示 |
| `LTM_STORE` | repo 配置なら `<repo>/.long-term-memory` | curator | 横断スキャン対象ストア。staged では絶対パス必須かつ TCC 非保護 |
| `LTM_CURATOR_SKILL` / `LTM_CURATOR_MCP_CONFIG` / `LTM_REPO_ROOT` / `LTM_CURATOR_LOG_DIR` | 自動解決 | curator | 上書き用 |

---

## 5. データモデル（正本 markdown）

### 5.1 Memory 型（`src/lib/memory/types.ts`）

```ts
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'session'] as const;

export const EntitySchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});
export const TripleSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);
export const SourceRefSchema = z.object({
  // .describe() 付き（バリデーションには無関係）。このスキーマは MCP 入力の
  // `source_refs` に埋め込まれて JSON Schema として配信されるため、入れ子の
  // 名前付きフィールドも自己文書化する必要がある。§9.1 参照。
  project_id: z.string().min(1).describe('...'),
  memory: z.string().min(1).describe('...'),
});

export const MemorySchema = z.object({
  id: z.string().min(1),            // ULID
  name: z.string().min(1),          // slug
  description: z.string().min(1),   // 一行要約（空文字は不可）
  type: z.enum(MEMORY_TYPES),
  tags: z.array(z.string()).default([]),
  links: z.array(z.string()).default([]),   // 他 memory の name
  entities: z.array(EntitySchema).default([]),
  triples: z.array(TripleSchema).default([]),
  source_refs: z.array(SourceRefSchema).optional(),
  // Names of memories in the SAME project that this one replaces (§8.6).
  // `.min(1)`（`z.string()` ではなく）は空文字列 `['']` が
  // serialize → parse を経由して静かに `[]` に化ける事故を防ぐため。
  // `entities.aliases` と同じ厳格さに揃えている。
  supersedes: z.array(z.string().min(1)).default([]),
  body: z.string(),                 // 本文（空文字可）
  created_at: z.string(),           // ISO 8601 UTC
  updated_at: z.string(),
});
```

**`bodyChars(body)`** — 本文長を**Unicode コードポイント数**で返す（`[...body].length`）。UTF-16 単位ではないので `𠮷` は 1 と数える。これは §8.1 の trigram 閾値と数え方を揃えるため。

用途: 読み取りツールが返す `body_chars` は「**まだ読んでいない本文の文字数**」。index / 検索結果が description 一行で自己完結して見えると、本文を一度も読まないまま作業に入る（実測: `search_memories` 通算 1 回、`find_related` 0 回）。欠落感を可視化するための列であり、**設計意図が挙動に直結している**ので必ず実装する。

エラー型 3 つ:

| 型 | メッセージ |
|---|---|
| `MemoryNotFoundError(idOrName)` | `memory not found: <idOrName>` |
| `MemoryConflictError(name)` | `memory name already exists: <name>` |
| `UnknownEntityError(name)` | `triple references unknown entity (not in entities list): <name>` |

入力型: `SaveInput`（`name, description, type, body` 必須 + `tags?, links?, entities?, triples?, source_refs?, supersedes?`）、`UpdateInput`（全て optional のパッチ、`supersedes?` も含む）。`save()` は `MemorySchema.parse` を呼ばないため、`.min(1)` フィルタが入口で効くのは `update()` 経路のみ（部分的な閉じ方だが、Codex レビュー指摘を受けた上での既定の採用）。

### 5.2 serialize 規則（`serializeMemory`）

frontmatter のキー順は**固定**（gray-matter は挿入順で出力する）:

1. `id`, `name`, `description`, `type`, `tags`, `links`, `created_at`, `updated_at` — 常に出力
2. `entities` — **非空のときだけ**。`aliases` が空の要素は `{ name }` のみ（`aliases: []` を書かない）
3. `triples` — 非空のときだけ。`[s, p, o]` の 3 要素配列
4. `source_refs` — 非空のときだけ。`{ project_id, memory }`
5. `supersedes` — 非空のときだけ。置き換える同一プロジェクト内の memory name の配列（schema v5）

本文は末尾改行を保証（`body.endsWith('\n') ? body : body + '\n'`）してから `matter.stringify(body, data)`。

出力例:

```yaml
---
id: 01KS203H51Z8822PWSKZ2QBBQ8
name: storage-architecture
description: markdown正 + SQLite索引 のハイブリッド構成
type: project
tags:
  - architecture
  - storage
links: []
created_at: '2026-05-20T06:10:27.105Z'
updated_at: '2026-06-02T07:51:42.244Z'
entities:
  - name: Markdown
    aliases:
      - markdown
  - name: SQLite
    aliases:
      - index.db
  - name: MemoryService
triples:
  - - SQLite
    - indexes
    - Markdown
---
本文（markdown）…
```

### 5.3 parse 規則（`parseMemoryString`）

`matter(md)` の結果から候補オブジェクトを組み、**最後に `MemorySchema.parse` を通す**（不正な markdown はここで例外）。個別処理:

| フィールド | 処理 |
|---|---|
| `tags` / `links` | 配列でなければ `[]` |
| `entities` | 配列でなければ `[]`。各要素の `aliases` は文字列かつ非空のものだけ残す |
| `triples` | 「配列 かつ 長さ 3 かつ 全要素が文字列」以外は**捨てる**（arity 違いはエラーにしない） |
| `source_refs` | `project_id` / `memory` が両方文字列のものだけ残す |
| `supersedes` | 配列でなければ `[]`。`typeof s === 'string' && s.length > 0` を満たす要素だけ残す（空文字列は除去） |
| `body` | 本文の先頭・末尾の連続改行を除去（`replace(/^\n+/, '').replace(/\n+$/, '')`） |
| `created_at` / `updated_at` | **`Date` オブジェクトなら `toISOString()` に戻す**（§17-4） |

### 5.4 ディレクトリレイアウト

```
<LTM_HOME>/                        # 既定 ~/.long-term-memory
├── index.db                       # SQLite（+ -wal / -shm）
└── projects/
    ├── <project_id>/              # slug（a-z0-9 とハイフン）
    │   └── memories/
    │       └── <name>.md
    └── __shared__/                # 予約スコープ（同じ形）
        └── memories/*.md
```

`Storage` インターフェースは `configJson`（`<home>/config.json`）、`logsDir`（`<home>/logs`）、`memoryIndexMd`（`projects/<slug>/MEMORY.md`）、`projectDir` も定義するが、**現行の実行パスでは未使用**（`memoriesDir` のみ `reconcile` が使う）。テスト（`tests/lib/paths.test.ts`）はパス生成のみ検証するので、値だけ合わせておけばよい。

---

## 6. SQLite スキーマと migration

### 6.1 `src/lib/db/schema.sql`（全文・これがスキーマの正本）

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  description  TEXT NOT NULL,
  body_chars   INTEGER NOT NULL DEFAULT 0,
  file_path    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS tags (
  memory_id TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS links (
  src_id   TEXT NOT NULL,
  dst_name TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_name),
  FOREIGN KEY (src_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- Supersession is deliberately NOT stored in `links`: links are PPR graph edges
-- (ASSOC_WEIGHTS.manualLink = 2.0), so folding supersedes into them would
-- silently change associative recall.
CREATE TABLE IF NOT EXISTS supersedes (
  src_id   TEXT NOT NULL,          -- 新しい側（superseder）
  dst_name TEXT NOT NULL,          -- 置き換えられる側の name
  PRIMARY KEY (src_id, dst_name),
  FOREIGN KEY (src_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- trigram: substring matching that works for CJK (unicode61 indexed a whole
--   run of kanji/kana as a single token, so Japanese barely matched).
-- contentless_delete=1: lets us DELETE FROM memories_fts WHERE rowid = ? instead
--   of the fragile "reconstruct the old row and INSERT '(delete)'" pattern.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  name, description, body, content='', contentless_delete=1, tokenize='trigram'
);

CREATE INDEX IF NOT EXISTS idx_memories_project_type ON memories(project_id, type);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_supersedes_dst ON supersedes(dst_name);

CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id   TEXT NOT NULL,
  alias       TEXT NOT NULL,
  asserted_by TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias, asserted_by),
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (asserted_by) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id   TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity_id),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_edges (
  src_entity_id TEXT NOT NULL,
  dst_entity_id TEXT NOT NULL,
  relation      TEXT NOT NULL,
  asserted_by   TEXT NOT NULL,
  PRIMARY KEY (src_entity_id, dst_entity_id, relation, asserted_by),
  FOREIGN KEY (src_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (dst_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (asserted_by)   REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entities_project_name ON entities(project_id, name);
CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_asserted ON entity_aliases(asserted_by);
CREATE INDEX IF NOT EXISTS idx_entity_edges_asserted ON entity_edges(asserted_by);
CREATE INDEX IF NOT EXISTS idx_entity_edges_src ON entity_edges(src_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_edges_dst ON entity_edges(dst_entity_id);
```

ER 図:

```mermaid
erDiagram
    memories ||--o{ tags : has
    memories ||--o{ links : "src (dst は name 参照・FK なし)"
    memories ||--o{ supersedes : "src (dst は name 参照・FK なし)"
    memories ||--o{ memory_entities : belongs
    entities ||--o{ memory_entities : member
    entities ||--o{ entity_aliases : alias
    entities ||--o{ entity_edges : "src / dst"
    memories ||--o{ entity_edges : asserted_by
    memories ||--|| memories_fts : "rowid で 1:1（contentless）"
```

設計上の要点:

- **`links.dst_name` は name 参照で FK なし**。存在しない名前を指せる（`findRelated` は解決できない dst を黙って無視する）。プロジェクト修飾もされないので、rename 時の掃引は `project_id` でスコープする（§7.7 rename）。
- **`supersedes` は `links` と同型だが別テーブル**（`src_id` に FK、`dst_name` は FK なしの name 参照）。存在しない name を指した場合の挙動も `links` と同じく寛容（JOIN が空になるだけ）。`__shared__` を跨ぐ supersede は対象外（共有への書き込みは curator 経由のみのため）。
- **`entity_edges.asserted_by` が provenance**。あるトリプルを主張する記憶が全部消えればエッジも消える。
- **`entity_aliases` も `asserted_by` 単位**。同じ別名を複数記憶が主張すれば複数行入る。1 記憶を消しても他が主張する別名は残る。
- **`memories_fts` は contentless (`content=''`)**。本文を保持しないので UI 表示には使えず、hydrate は必ず markdown から。

### 6.2 再構築 migration（`migrate.ts`）

```ts
const CURRENT_VERSION = 5;

// CRITICAL: every table and virtual table declared in schema.sql must be
// listed here (FK 安全な DROP 順), otherwise a version bump never drops that
// table and any future column/PK/constraint change to it silently no-ops.
export const REBUILDABLE_TABLES = [
  'entity_edges', 'entity_aliases', 'memory_entities', 'entities',
  'supersedes', 'links', 'tags', 'memories_fts', 'memories',
];
```

`schema.sql` の全テーブルを `REBUILDABLE_TABLES` が網羅していることは、テスト（`tests/lib/db/migrate.test.ts`）が突き合わせで強制する。schema v4 → v5 の追加分（`supersedes`）を漏らすとテストが落ちる。

手順:

```mermaid
flowchart TD
    A["CREATE TABLE IF NOT EXISTS schema_version"] --> B["stored version を読む"]
    B --> C{"stored が undefined?"}
    C -->|"はい（新規 DB）"| E["applySchema"]
    C -->|"いいえ"| D{"stored == CURRENT_VERSION?"}
    D -->|"はい"| E
    D -->|"いいえ"| F["REBUILDABLE_TABLES を DROP"] --> E
    E --> G{"stored の有無"}
    G -->|"undefined"| H["INSERT version"]
    G -->|"不一致"| I["UPDATE version"]
```

- **`schema_version` は DROP しない**（stored version を読むため）。
- **列追加・トークナイザ変更・`contentless_delete` の有効化は、この版上げでしか反映されない**。`CREATE ... IF NOT EXISTS` は既存 DB では黙って no-op になる。
- DROP 後は `openDefault()` の `reconcile()` が markdown から全再構築する（markdown が正本だから安全）。
- `applySchema` は `schema.sql` を `readFileSync(join(here, 'schema.sql'))` で読む。**`here` は `dirname(fileURLToPath(import.meta.url))`**。Docker runner ではこのファイルを `.next` と別に明示コピーする必要がある（§13.1）。
- **`splitStatements`**: `/;\s*\n/` で分割し、**各文の中の `--` 始まり行を除去**する。文単位で「`--` で始まるチャンクを捨てる」実装にすると、コメント直後の `CREATE` ごと落ちる（`memories_fts` が作られない）。

```ts
function splitStatements(sql: string): string[] {
  return sql.split(/;\s*\n/)
    .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter((s) => s.length > 0);
}
```

### 6.3 接続（`connection.ts`）

```ts
export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
```

**`foreign_keys = ON` は必須**（ON DELETE CASCADE に依存している）。

### 6.4 テレメトリ DB（`src/lib/telemetry/`）

**`telemetry.db` は `index.db` と別ファイル**で、MCP ツール呼び出しのイベントログを記録する。`index.db` と異なり、markdown の正本がないため**再構築不可**。

**ファイル構成**（`src/lib/telemetry/`）:

| ファイル | 役割 |
|---|---|
| `schema.sql` | `telemetry_version` / `tool_events` の DDL |
| `migrate.ts` | stepwise migration。`CURRENT_TELEMETRY_VERSION` と、`schema.sql` が実際に表す `SCHEMA_BASE_VERSION` を分離。フレッシュインストールは `schema.sql` 適用 → `SCHEMA_BASE_VERSION` を刻印 → `target > SCHEMA_BASE_VERSION` なら通常の step-replay 経路へ再帰する（アップグレードと同じ経路を通すことで、`schema.sql` 適用直後に将来バージョンを直接刻印して step を飛ばす事故を防ぐ） |
| `store.ts` | `TelemetryStore`（`open` / `openDefault` / `recordToolCall` / `recordConnect` / `withDb` / `close`）と singleton（`getTelemetryStore` / `resetTelemetryStore`） |
| `recorder.ts` | 例外を絶対に外へ出さない記録関数 `recordToolCall` / `recordConnect`、エラー正規化 `errorCode`、**`LTM_TELEMETRY=0` の opt-out 判定はここ（`telemetryEnabled()`）** |
| `instrument.ts` | `instrumentRegistrar(server, kind, record, ctx)` — `registerTool` を包む。`measure()` で件数・文字数のみ抽出 |
| `catalog.ts` | `TOOL_CATALOG`（全ツールの名前と kind。0 回のツールを表に出すために必須） |
| `query.ts` | 集計クエリ（純関数） |
| `connection.ts` | project_id → 直近接続 ID のレジストリ。`transport.ts` が `initialize` で発番し、`instrument.ts` が呼び出し時に引く |
| `window.ts` | 集計窓の解決（JST 日境界への丸めと、前期間比較用の直前窓） |

**帰属の近似と双方向バイアス（`connection.ts`）**: `tools/call` リクエストは自分がどの接続（`Mcp-Session-Id`）から来たかを名乗らないため、呼び出しは「その `project_id` で直近に成功した `initialize`」に帰属させる近似でしかない。誤帰属は読み取りを別の（新しい）接続へ付け替えるだけで、接続そのものを捏造することはない。しかしこの付け替えは**双方向に効く**: 読み取りを奪われた古い接続は悲観側（未読扱いのまま）に振れ、逆に自分では読んでいない新しい接続がその読み取りを受け取ると楽観側（既読扱い）に振れる。一方向にしか効かないのは**プロセス再起動由来の未帰属**だけで、これは本サーバが `Mcp-Session-Id` の失効をクライアントに通知しないために起きる（再起動後の呼び出しが `session_id` NULL のまま恒久的に未帰属となる）。この片方向ケースは常に悲観側（未読扱い）にしか振れない。

**R1/R4/R6 アラート（`src/app/dashboard/page.tsx` で計算、`spec §3` = `docs/superpowers/specs/2026-08-27-usage-telemetry-dashboard-design.md`）**:

| ID | 定義 | 計算 | 抑制条件 |
|---|---|---|---|
| R1 | 読み取りを 1 回も行わなかった接続（readless connection）の比率が 50% 超 | `summary.readlessRate`（`summarize()`）= `(connectionsTracked - connectionsWithRead) / connectionsTracked`。`connectionsWithRead` は「`session_id` が一致する `kind='read'` の `tool_call` が 1 件でも EXISTS するか」を **時間窓で区切らず**判定（窓終端近くで開いた接続が窓外で読む取りこぼしを防ぐため） | `unattributedCalls / calls > R1_ATTRIBUTION_FLOOR`（= 0.1）のとき `r1Suppressed = true` でアラート自体を出さない。`unattributedCalls` は `session_id IS NULL` の `tool_call` 件数（schema v2 以前の行、または再起動由来の未帰属） |
| R4 | `remember_project_fact` の呼び出し件数が `remember_session_summary` を上回る | `perTool()` の集計から該当 2 ツールの `calls` を引いて比較するだけ（`projectFacts > sessionSummaries`）。「完了報告が project 型で保存され滞留する病理」の兆候 | なし |
| R6 | curator（`maintenance=1` の書き込み）の最終成功時刻からの経過日数が `CURATOR_STALE_DAYS`（= 2 日）以上、または一度も無い | `curatorStatus()` が返す `lastWriteIso`（`kind='write' AND maintenance=1 AND ok=1` の `MAX(ts)`、**窓に依存しないグローバル最終時刻**）と `now` の差 | なし |

ダッシュボードの主要指標（`query.ts`）: `summarize`（呼び出し数・kind 別内訳・connect数・エラー率・readlessRate・callsPerConnect）、`dailySeries`（JST 日別の read/write/meta/connects/errors/maintenanceWrites。**`maintenance` 判定は `kind='write'` に限定**——curator は書き込み前に読み取りも行うため、読み取りまで数えるとハートビートの健全性が実態の4倍に見えて過大評価になる）、`perTool`（ツール別の呼び出し数・エラー率・zeroResultsの比率・`result_chars` の p95・最終使用時刻）、`perProject`、`errorBreakdown`（`error_code × tool` のクロス集計）、`curatorStatus`。UI 側の部品（`src/components/dashboard/`）は `Bar`（比率バー）・`Delta`（前期間比較の増減表示）・`Sparkline`（日次系列）。期間は `7/30/90` 日のプリセットリンクと `?project=` フィルタで切り替える（`period-nav`、§11.3）。

- **パス**: `<LTM_HOME>/telemetry.db`（`LTM_HOME` は `index.db` と同じ）。
- **スキーマ（`tool_events`、全 13 列）**: `id`（INTEGER PK）、`ts`（ISO8601 UTC）、`event`（`'tool_call' | 'connect'`）、`project_id`、`session_id`（`initialize` ごとの `randomUUID()`。v2 で追加。v2 以前の行は NULL）、`tool`（`connect` のとき NULL）、`kind`（`'read' | 'write' | 'meta'`。`connect` のとき NULL）、`ok`（0/1）、`error_code`（`not_found` / `conflict` / `validation` / `internal` の 4 値に閉じる。または NULL）、`duration_ms`、`result_count`（配列結果の要素数、ベストエフォート）、`result_chars`（応答テキストの文字数）、`maintenance`（0/1。`canWriteShared` = curator 由来かの識別）。**引数・本文・エラーメッセージ原文は保存しない**。
- **`event` は 2 種類**: `tool_call`（`registerTool` ラップ経由、または `tools/call` のプロトコルエラー）と `connect`（JSON-RPC `initialize` の検出、`handleMcpRequest` 内）。**`connect` の総数は 2026-07-28 診断（197 セッション中 19 しか繋がなかった）を恒久的に再現できる唯一の指標**であり、テレメトリ設計の主目的の一つ（spec §1 参照）。
- **migration パターン**: `src/lib/telemetry/migrate.ts` は stepwise アプローチ。新 step を追加するのみで、既存テーブルの DROP や列削除は禁止。`index.db` のように版上げ時に全再構築する仕様ではない。
- **`schema.sql` に含めない**: memory 記録の正本は markdown だから `schema.sql` と `REBUILDABLE_TABLES` の一致テストで rebuild を強制できるが、telemetry はイベントログなので markdown 正本がない。版上げ時に全テーブル DROP されると使用履歴が全消しになる（§6.2 参照）。
- **無効化**: `LTM_TELEMETRY=0` で記録をスキップ。判定は `registerTool` ラップ（`instrument.ts`）ではなく **`src/lib/telemetry/recorder.ts` の `telemetryEnabled()`**（`process.env.LTM_TELEMETRY !== '0'`）で行う。同じ関数がストア障害時の「1 回だけ警告して以後無効化」ラッチ（`brokenStore`）も持つ。
- **集計・表示**: `/dashboard` で全体の使用統計、`?project=<slug>` で特定プロジェクトのみ、`?days=<n>`（既定 30・上限 365）で期間。窓は JST 日境界に丸める。R1 / R4 / R6 の定義・計算・帰属バイアスは本節前段（上記の帰属バイアス説明と表）を参照。UI ルートの詳細は §11.3。

---

## 7. コアレイヤ実装仕様

### 7.1 `paths.ts`

```ts
export function resolveStorage(): Storage {
  const home = process.env.LTM_HOME ?? join(homedir(), '.long-term-memory');
  return {
    home,
    indexDb: join(home, 'index.db'),
    configJson: join(home, 'config.json'),
    logsDir: join(home, 'logs'),
    projectDir: (s) => join(home, 'projects', s),
    memoriesDir: (s) => join(home, 'projects', s, 'memories'),
    memoryFile: (s, n) => join(home, 'projects', s, 'memories', `${n}.md`),
    memoryIndexMd: (s) => join(home, 'projects', s, 'MEMORY.md'),
  };
}
```

**`resolveStorage()` は呼び出しごとに env を読む**（モジュールロード時にキャッシュしない）。テストが `LTM_HOME` を差し替えて使うため。

### 7.2 `slug.ts`

```ts
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SHARED_PROJECT_ID = '__shared__';
```

| 関数 | 契約 |
|---|---|
| `isValidSlug(s)` | 文字列 かつ 1..64 文字 かつ `SLUG_RE` |
| `isReservedProjectId(s)` | `s === '__shared__'` |
| `assertProjectId(v)` | slug **または**予約 ID 以外で `SlugError` |
| `assertMemoryName(v)` | slug 以外で `SlugError`（予約 ID は不可） |

`SlugError` は `field` / `value` を持ち、メッセージは `invalid <field>: <value> (expected lowercase a-z, 0-9, hyphen-separated, 1..64 chars)`。

**`__shared__` は意図的に slug 正規表現を通らない**（アンダースコア）。ユーザ作成プロジェクトと絶対に衝突しないため。受理するのは `assertProjectId` と `reconcile` のディレクトリ走査だけで、**`isValidSlug` 自体は緩めない**。

### 7.3 `markdown/file-io.ts`

```ts
export function atomicWriteText(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, contents, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}
```

- `readMemoryFile(path)` = `parseMemoryString(readFileSync(path, 'utf8'))`
- `computeHash(text)` = SHA-256 hex（`content_hash` に使う。**markdown 全文のハッシュ**であって本文だけではない）

### 7.4 `KeyedMutex`

キーごとに Promise チェーンを作り、同一キーの処理を直列化する。

```ts
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((r) => { release = r; });
    const next = prev.then(() => slot);
    this.chains.set(key, next);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }
}
```

要件: 同一キーは直列、異なるキーは並行、`fn` が throw してもチェーンが詰まらない、最後の待ち手が抜けたらエントリを削除（リーク防止）。

### 7.5 `memory/kg.ts` — 知識グラフ反映

**`applyMemoryKg(db, projectId, memoryId, { entities, triples })`** は必ず `db.transaction` の中で呼ぶ。手順:

```mermaid
flowchart TD
    A["1. この記憶の過去の主張を撤回<br/>memory_entities / entity_edges / entity_aliases を asserted_by で DELETE"] --> B["2. triples の主語・目的語が entities の正規名にあるか検証<br/>無ければ UnknownEntityError"]
    B --> C["3. entities を upsert（ensureEntity）<br/>+ aliases（INSERT OR IGNORE、provenance 付き）<br/>+ memory_entities（INSERT OR IGNORE）"]
    C --> D["4. triples を entity_edges へ（INSERT OR IGNORE）"]
    D --> E["5. 参照されなくなった entity を prune"]
```

- **1 の明示撤回が必要**: 再適用時は `memories` 行が残っているので `ON DELETE CASCADE` は発火しない。冪等性のため自分で消す。
- **検証は正規名のみ**。別名を triple の主語/目的語に書いても `UnknownEntityError`。
- 同名の entity エントリが 2 つあれば、aliases はマージされ 1 ノードになる（`memory_entities` は `INSERT OR IGNORE` なので重複所属は no-op）。
- `ensureEntity`: `SELECT id FROM entities WHERE project_id = ? AND name = ?` → 無ければ `ulid()` で作る。
- `pruneOrphanEntities`: `DELETE FROM entities WHERE project_id = ? AND id NOT IN (SELECT entity_id FROM memory_entities)`。entity id が ULID で全域一意なので、この副問い合わせは他プロジェクトを壊さない。aliases / edges は CASCADE で消える。

**`removeMemoryKg(db, projectId, memoryId)`**: `memory_entities` / `entity_edges` / `entity_aliases` を `memoryId` 起点で削除 → prune。**他の記憶が主張した別名は残す**のが要件。

### 7.6 `memory/reconcile.ts`

**`reconcile(db, storage)`** — 差分同期。全体を 1 トランザクションで包み、**ファイルごとに savepoint**（`db.transaction` のネスト）を張る。

```mermaid
flowchart TD
    A["projects/ 配下のディレクトリ列挙<br/>（isValidSlug または __shared__ のみ）"] --> B["各 memories/*.md を読む"]
    B --> C{"parseMemoryString 成功?"}
    C -->|"失敗"| C2["continue（seenIds に入れない<br/>→ 下の sweep で DB 行が消える）"]
    C -->|"成功"| D["seenIds.add(memory.id)<br/>※upsert より先に入れる"]
    D --> E{"content_hash 一致?"}
    E -->|"一致"| F["スキップ"]
    E -->|"不一致 / 新規"| G["savepoint 内で upsertMemory"]
    G -->|"例外"| H["この 1 ファイルのみロールバックし警告ログ<br/>（basename と project だけ出す）"]
    B --> I["sweep: seenIds に無い or ファイルが消えた DB 行を削除"]
```

- **`seenIds.add` を upsert より前に置く**理由: upsert に失敗したファイルも「disk にはある」ので、既存 DB 行を sweep で消してはいけない。一方 parse 失敗は `continue` で seen に入らないため、行は消える（壊れた markdown は索引から外す）。
- ログは `basename(filePath)` と `projectId` のみ。絶対パスを出すと `LTM_HOME` / OS ユーザ名が漏れる。
- `upsertMemory` は既存行があれば「FTS を rowid で DELETE → `UPDATE memories ...` → tags/links を DELETE」してから、共通処理で tags / links / FTS / KG を入れ直す。
- sweep 時は FTS 行 → `removeMemoryKg` → tags → links → memories の順に削除。

**`reindex(db, storage)`** — 全消し + reconcile。

```ts
db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')").run();  // 失敗したら DELETE FROM にフォールバック
// → entity_edges, memory_entities, entity_aliases, entities, links, tags, memories を DELETE
reconcile(db, storage);
```

### 7.7 `MemoryService`（`memory/service.ts`）

コンストラクタは private。生成は `MemoryService.openDefault()` のみ:

```ts
static openDefault(): MemoryService {
  const storage = resolveStorage();
  const db = openDb(storage.indexDb);
  const svc = new MemoryService(db, storage);
  svc.reconcile();          // 起動時に必ず走る
  return svc;
}
```

#### メソッド一覧と契約

| メソッド | 同期/非同期 | 契約 |
|---|---|---|
| `save(projectId, input)` | 同期 | 名前重複で `MemoryConflictError`。ULID 発行、`created_at = updated_at = now` |
| `get(projectId, idOrName)` | 同期 | `id = ?` OR `name = ?` で検索 → markdown を hydrate。無ければ `MemoryNotFoundError` |
| `listByType(projectId, type, limit = 100)` | 同期 | `updated_at DESC`、markdown を hydrate |
| `listSummaries(projectId, { type?, limit? })` | 同期 | **markdown を読まない** DB のみのサマリ |
| `searchByTag(projectId, tags, match = 'any')` | 同期 | hydrate 版 |
| `searchByTagSummaries(...)` | 同期 | DB のみ版 |
| `update(projectId, idOrName, patch)` | 同期 | 部分更新。§7.7.2 の不変条件 |
| `forget(projectId, idOrName, reason?)` | 同期 | 完全削除。ファイル削除 → DB tx の順 |
| `linkMemories(projectId, src, dstName)` | 同期 | 冪等（既存なら何もせず return） |
| `findRelated(projectId, idOrName, depth = 1)` | 同期 | BFS。`{ nodes, truncated }` |
| `rename(projectId, oldName, newName)` | 同期 | ファイル移動 + 被リンク掃引 |
| `listProjects()` | 同期 | `{ id, count, updated_at, shared }[]`、`MAX(updated_at) DESC` |
| `searchFulltext(projectId, query, opts?)` | 同期 | §8.1 |
| `searchAssociative(projectId, query, opts?)` | 同期 | §8.2 |
| `readKgGraph(projectId)` | 同期 | UI 用の生 KG データ |
| `kgStats(projectId)` | 同期 | `{ entities, edges, memberships }` |
| `reconcile()` / `reindex()` | 同期 | 委譲 |
| `saveAsync` / `updateAsync` / `forgetAsync` / `linkMemoriesAsync` / `renameAsync` | 非同期 | **`mutex.run(projectId, ...)` で包んだ版**。MCP / REST からは必ずこちらを使う |
| `withDb(fn)` | 同期 | 生 DB を渡す。呼び出し側は読み取り専用で使う約束 |
| `close()` | 同期 | `db.close()` |

`protected hydrate(_id, filePath)` = `readMemoryFile(filePath)`。テストで差し替えられるよう protected にしてある。

#### 7.7.1 `save` のトランザクション順序

```mermaid
flowchart TD
    A["重複チェック（project_id + name）"] --> B["ULID / now / filePath を決定"]
    B --> C["serializeMemory → computeHash"]
    C --> D["atomicWriteText（markdown を先に書く）"]
    D --> E["DB tx: memories INSERT → tags → links → memories_fts → applyMemoryKg"]
    E -->|"成功"| F["Memory を返す"]
    E -->|"例外"| G["書いた markdown を削除して rethrow"]
```

FTS への INSERT は rowid を副問い合わせで解決する:

```sql
INSERT INTO memories_fts (rowid, name, description, body)
VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, ?, ?)
```

#### 7.7.2 `update` の不変条件

1. 対象行を引く（無ければ `MemoryNotFoundError`）。
2. **現在の markdown を読み**、`patch.X ?? current.X` でマージ（省略フィールドは保持）。`updated_at = now`。
3. **KG 不変条件**: `type` が `user` / `feedback` / `project` で、`current.entities.length > 0` かつ `updated.entities.length === 0` なら例外:
   `cannot empty entities on a "<type>" memory: KG-bearing memories must keep at least one entity`
   （元々 entities が無い記憶は不変条件の対象外 — 他フィールドの編集は許す）
4. **`MemorySchema.parse(updated)`**。パッチスキーマの `z.string()` は通るが `min(1)` に反する空 description などをここで弾く。書き込んでしまうと markdown が parse 不能になり、次の reconcile で行が消える。
5. `atomicWriteText(new)` → DB tx。**失敗したら旧内容の markdown を書き戻す**。
6. DB tx の中身: `memories` の `description` / `body_chars` / `content_hash` / `updated_at` を UPDATE → tags 全消し再挿入 → links 全消し再挿入 → FTS を rowid で DELETE して再 INSERT → `applyMemoryKg`。

#### 7.7.3 `forget` の順序（重要）

**markdown を先に消して、その後 DB tx**。逆にすると、間でプロセスが死んだときファイルが生き残り、次の reconcile が記憶を「復活」させる。先に消せば孤立した DB 行が sweep されるだけで自己修復になる。

#### 7.7.4 `findRelated`

```ts
const cappedDepth = Math.min(Math.max(depth, 1), 3);
const truncated = depth > 3;
```

`links.dst_name` を name で解決しながら BFS。解決できない dst は黙って無視。戻り値は `{ nodes: Memory[]（開始ノードを含む）, truncated }`。MCP スキーマ側で depth は 1..3 に制限されるので、`truncated: true` はサービス直呼びのときだけ起きる。

#### 7.7.5 `rename`

```mermaid
flowchart TD
    A["新 name の衝突チェック → MemoryConflictError"] --> B["新パスへ atomicWriteText"]
    B --> C["DB tx"]
    C --> C1["memories の name / file_path / content_hash / updated_at を UPDATE"]
    C1 --> C2["links.dst_name を掃引<br/>※src が同一 project の行のみ"]
    C2 --> C3["FTS を rowid で DELETE → 再 INSERT"]
    C -->|"例外"| E["新ファイルを削除して rethrow"]
    C --> D["旧ファイルを削除"]
    D --> F["被リンク元の markdown も掃引<br/>+ content_hash を更新"]
```

- **`links` 掃引を project でスコープする**: `dst_name` はプロジェクト修飾されていないので、他プロジェクトの同名記憶へのリンクを書き換えてしまう。
  ```sql
  UPDATE links SET dst_name = ?
  WHERE dst_name = ? AND src_id IN (SELECT id FROM memories WHERE project_id = ?)
  ```
- **掃引した markdown の `content_hash` を必ず更新する**。しないと以後の reconcile が毎回ハッシュ不一致を検出して無駄な再 upsert を続ける。
- `body` は変わらないので **`body_chars` は触らない**（`linkMemories` も同様）。

#### 7.7.6 `attachTagsLinks`（N+1 回避）

サマリ行に tags / links を付ける処理は **`IN` を 500 件ずつにチャンクする**。SQLite のバインドパラメータ上限（`SQLITE_MAX_VARIABLE_NUMBER`、同梱ビルドで 32766）を超えないため。

#### 7.7.7 `searchByTag` の `match: 'all'`

タグを `[...new Set(tags)]` で**重複除去してから** `HAVING COUNT(DISTINCT t.tag) = N` する。除去しないと同じタグを 2 回渡された時に閾値へ到達できず 0 件になる。

### 7.8 シングルトン（`memory/singleton.ts`）

```ts
let instance: MemoryService | null = null;
export function getMemoryService(): MemoryService {
  if (!instance) instance = MemoryService.openDefault();
  return instance;
}
export function resetMemoryService(): void {
  if (instance) { try { instance.close(); } catch {} instance = null; }
}
```

MCP と UI は**同じシングルトンを共有**する（書き込み経路を一系統にするため）。`resetMemoryService` はテスト用フック。

### 7.9 `datetime.ts`

```ts
const JST_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZone: 'Asia/Tokyo',
});

export function formatJst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;   // parse できなければ原文を返す
  return JST_FORMATTER.format(d).replace(/\//g, '-');
}
```

出力例: `2026-05-20 15:10:27`。UI の日時表示は**必ずこれを通す**。

---

## 8. 検索仕様

### 8.1 全文検索（`searchFulltextIds` / `searchFulltext`）

```mermaid
flowchart TD
    Q["query"] --> T["ftsTokens: /[^\p{L}\p{N}]+/u で分割"]
    T --> Z{"トークン 0 件?"}
    Z -->|"はい"| E0["空配列"]
    Z -->|"いいえ"| M{"3 コードポイント以上の<br/>トークンがある?"}
    M -->|"無い"| LIKE["likeFallback<br/>name/description の LIKE、OR 結合、updated_at DESC の順位から relevance を降順採番"]
    M -->|"ある"| AND["implicit-AND で MATCH<br/>各トークンを二重引用符で囲む"]
    AND --> R{"0 件 かつ<br/>トークン 2 個以上?"}
    R -->|"はい"| OR["OR で再試行"]
    R -->|"いいえ"| OUT["結果"]
    OR --> OUT
```

実装の要点:

```ts
const FTS_MIN_TOKEN_LEN = 3;                          // trigram の最小マッチ長（コードポイント）
function codePointLength(s: string) { return [...s].length; }
function ftsTokens(raw: string) { return raw.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0); }
function ftsPhrases(tokens: string[], op: 'AND' | 'OR') {
  return tokens.map((t) => `"${t}"`).join(op === 'AND' ? ' ' : ' OR ');
}
```

- **各トークンを `"..."` で囲むことが必須**。生クエリを MATCH に渡すと `better-sqlite3` / `Server.connect` のようなハイフン・ドットを含む語で FTS5 構文エラー（SqliteError）になる。
- **bm25 の列重み**: `ORDER BY bm25(memories_fts, 10.0, 5.0, 1.0)` — name 10 / description 5 / body 1。より目立つ列のヒットが本文だけのヒットを上回る。
- SQL 側でかける絞り込み: `m.project_id = ?`、`opts.type` があれば `AND m.type = ?`、`opts.tags` があれば `AND EXISTS (SELECT 1 FROM tags t WHERE t.memory_id = m.id AND t.tag IN (...))`。
- `opts.limit` が既知のときだけ `LIMIT` を SQL に押し込む（PPR 経路はシード全件が必要なので付けない）。
- `likeFallback` は `name` / `description` のみ対象（**body は markdown と FTS にしか無い**）。トークン OR、`ORDER BY m.updated_at DESC`。bm25 スコアが無いので `relevance` は SQL では出せない。行を `updated_at DESC` で取得した後、JS 側でその並び順を降順の `relevance`（先頭行 = 件数、末尾行 = 1）に変換して `rerank()` に渡す。SQL の日付関数に頼らず JS で計算するのは、`updated_at` がミリ秒 + `Z` 付きの ISO-8601 文字列で、SQLite 側のパースに賭けるのは避けたい risk だから。**flat な `0 AS relevance` にしてはいけない**: `normalizeRelevance` はゼロ分散の集合を全件 `1` に丸めるため、relevance が意味を持たなくなり `decayFactor` だけが順序を決める。`user` / `feedback` は `halfLife: null`（decay は常に 1）なので、flat relevance のもとでは古い `user`/`feedback` の記憶がどれだけ新しくても他の型の記憶を押しのけて上位に来てしまう（実際に 2000 日前の `user` 記憶が 1 日前の `project` 記憶より上に出た）。recency 由来の relevance に変えたことで `normalizeRelevance` は候補を recency 順に `[0,1]` へ実際に広げ、decay は `RECENCY_WEIGHT`（0.2）を上限とする tiebreak という本来の役割に戻る。

日本語での挙動:

| クエリ | 挙動 |
|---|---|
| `削除のパターン` | `削除のパターン` が 1 トークン（8 文字）→ trigram で部分一致する |
| `削除` | 2 文字なので MATCH から除外され、**全トークンが 3 文字未満 → LIKE フォールバック**（本文には当たらない） |
| `better-sqlite3` | `better` / `sqlite3` の 2 トークン。引用句化されるのでクラッシュしない |

### 8.2 連想検索（`searchAssociative`）

**schema v5 で両経路にリランク（§8.6）が配線された。** `limit` の既定は **20**。候補プールは `Math.max(limit * 5, CANDIDATE_POOL_MIN)`（`CANDIDATE_POOL_MIN = 200`）。実データの最大プロジェクトが 190 件なので 200 なら実質全件になり、silent cap にならない。

```mermaid
flowchart TD
    A["searchAssociative(query, opts)"] --> B{"queryEntities が空?"}
    B -->|"はい"| C["bm25 経路<br/>searchFulltextIds(type, tags, limit=候補プール件数)"]
    C --> C2["rerankRows: superseded フラグを付けて rerank()<br/>→ limit 件に slice → hydrate"]
    B -->|"いいえ"| D["FTS ヒットを全件取得（ids のみ・limit なし、type/tags フィルタ済み）"]
    D --> E["rankMemoriesByPpr(db, projectId, ftsIds, queryEntities)"]
    E --> F{"ランキング 0 件?"}
    F -->|"はい（孤立ノード / 空グラフ）"| G["ftsHits を rerankRows → limit 件に slice → hydrate"]
    F -->|"いいえ"| H["memories を type/tags で SQL フィルタ（1 クエリ、id→row の Map）"]
    H --> I["ranked の各エントリを Map で引き、relevance を PPR score に置き換え<br/>Map に無い（フィルタで落ちた）ものは除外"]
    I --> J["rerankRows: superseded フラグを付けて rerank()<br/>→ limit 件に slice → hydrate"]
```

- **type / tags フィルタは両経路とも SQL で先にかける**。bm25 経路は `searchFulltextIds` の `WHERE m.type = ?` / `EXISTS (... tags ...)`。PPR 経路は PPR ランキング後に `memories` テーブルへ 1 クエリ投げて type/tags で絞り、その結果に無い id（＝フィルタで落ちた候補）を捨てる。
- **フィルタ → 正規化 → rerank → `limit` で slice、の順を両経路で揃えている**（2026-08-13 の Codex 横断レビューで修正）。当初の PPR 経路は「ランキング順に走査しながら type フィルタ → hydrate → tag フィルタ → limit 件に達したら打ち切り」という実装で、`limit` まで詰めながらフィルタしていた。これは `rerank()` の `normalizeRelevance`（min-max 正規化）の母集団を bm25 経路と揃えられず、**同じ絞り込みクエリが `query_entities` の有無で違う順序を返す**バグだった。フィルタは全候補に対して行い、残った集合で正規化してから `limit` を適用する。
- 最終的に hydrate されるのは返す件数分だけ（シード段・フィルタ段は id のみで安い）。

### 8.3 連想グラフ（`graph/assoc.ts`）

ノード: 記憶 id はそのまま、エンティティは `ent:` プレフィックス。**無向・重み付き**（両方向に同じ重みの辺を張る）。

```ts
export const ASSOC_WEIGHTS = {
  manualLink: 2.0,  // 人が張った memory ↔ memory リンク
  triple: 1.0,      // entity ↔ entity（triple 由来）
  membership: 1.0,  // memory ↔ entity
};
export const PPR_DEFAULTS: PprOptions = { alpha: 0.15, maxIter: 100, tol: 1e-6 };
```

構築手順:

1. 当該プロジェクトの全 memory を空隣接でノード登録。
2. 全 entity を `ent:<id>` でノード登録。
3. `memory_entities` → `membership`（w=1）。
4. `entity_edges` を `GROUP BY src, dst` して `COUNT(*)` を取り、`triple × count` を重みにする。**方向の違う行（X→Y と Y→X）は別グループなので、実効的な X↔Y 重みは両者の和**になる（PoC 上の許容、質量は保存される）。
5. `links` を `dst.name = l.dst_name AND dst.project_id = src.project_id` で解決して `manualLink`（w=2）。
6. **自己ループ（`a === b`）は張らない**（`[X, rel, X]` のような triple。PPR を歪める）。

`resolveSeedEntities(db, projectId, names)`: 正規名 `COLLATE NOCASE` → ヒットしなければ別名 `COLLATE NOCASE` の順で解決。大文字小文字を無視するのは、LLM が生成する `docker` を正規名 `Docker` に当てるため。

`rankMemoriesByPpr(db, projectId, ftsHitMemoryIds, queryEntityNames, opts?)`:

```ts
const seeds = [...new Set([...ftsHitMemoryIds, ...entitySeeds])].filter((s) => graph.adjacency.has(s));
if (seeds.length === 0) return [];
const scores = personalizedPageRank(graph, seeds, o);
// memory ノードのみ、score > 1e-12 のものをスコア降順で返す
```

### 8.4 Personalized PageRank（`graph/ppr.ts`）

漸化式:

```
r = alpha * s + (1 - alpha) * Wᵀ r
```

- `s` はシード上の一様分布（`1 / |validSeeds|`）
- `W` は重み正規化した遷移行列（各ノードの重み和 `outDeg` で割る）
- `alpha = 0.15` は**リスタート（テレポート）確率**。低いほどシードから遠くまで質量が広がる＝連想想起が効く
- **dangling ノード（重み和 0）の質量はシード分布へ戻す**（質量保存）
- 収束判定は L1 差分 `< tol`、最大 `maxIter` 回

```ts
for (let iter = 0; iter < maxIter; iter++) {
  const next = new Map<string, number>();
  for (const n of graph.nodes) next.set(n, alpha * (s.get(n) ?? 0));   // テレポート項
  let dangling = 0;
  for (const n of graph.nodes) {
    const mass = r.get(n)!;
    if (mass === 0) continue;
    const deg = outDeg.get(n)!;
    if (deg === 0) { dangling += mass; continue; }
    for (const e of graph.adjacency.get(n)!) {
      next.set(e.to, next.get(e.to)! + walk * mass * (e.w / deg));
    }
  }
  if (dangling > 0) for (const seed of validSeeds) next.set(seed, next.get(seed)! + walk * dangling * seedMass);
  let delta = 0;
  for (const n of graph.nodes) delta += Math.abs(next.get(n)! - r.get(n)!);
  r = next;
  if (delta < tol) break;
}
```

満たすべき性質（テストがこれを検証する）:
- シード側のノードが遠いノードより上位
- 非対称性: `PPR(seed=A)` が A に与える質量 > `PPR(seed=C)` が A に与える質量
- スコア合計 ≈ 1
- シードが空 / グラフに無い → 空 Map
- 孤立シードでも落ちない

**重要な注意（チューニングの前提）**: triple の**述語（relation）はランキングに影響しない**。効くのは (src, dst) の連結性・多重度・端点の正規名一致だけ。述語を工夫しても想起順は変わらない。

### 8.5 RRF（`memory/rrf.ts`）

```ts
export function rrfMerge<T>(lists: T[][], keyOf: (item: T) => string, k = 60): T[] {
  const scores = new Map<string, number>();
  const kept = new Map<string, T>();
  for (const list of lists) {
    list.forEach((item, i) => {
      const key = keyOf(item);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
      if (!kept.has(key)) kept.set(key, item);
    });
  }
  return [...kept.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!).map((key) => kept.get(key)!);
}
```

- ランクベースなので bm25 と PPR のスコアスケール差に影響されない。
- **最初に現れたリストのオブジェクトが残る**。呼び出し側はリスト順で優先度を表現する（project → shared）。

### 8.6 時間減衰と supersession によるリランク（`memory/rerank.ts`、schema v5）

**問題**: `updated_at` が `ORDER BY` に現れるのは `likeFallback` だけで、bm25 経路も PPR 経路も新旧を区別しない。supersede された古い事実が現行の事実と同じ重みで返っていた。設計の経緯・検討した3案（加重 RRF / 正規化+加算 / 乗算）は `docs/superpowers/specs/2026-08-13-memory-time-decay-supersession-design.md` を参照。

**式（両経路共通）**:

```
final = normalize(relevance) + RECENCY_WEIGHT * decay(age, type) - (superseded ? SUPERSEDED_PENALTY : 0)
```

**定数（実装契約なので数値で固定）**:

| 定数 | 値 | 意味 |
|---|---|---|
| `RECENCY_WEIGHT` | **0.2** | 新しさが正規化スケール（[0,1]）を動かせる上限。正規化後の関連度差が 0.2 を超えるペアは、減衰が最大に効いても順序が入れ替わらない |
| `SUPERSEDED_PENALTY` | **0.5** | supersede された記憶に一律で引く値。順位を下げるが検索結果から消さない |
| `HALF_LIFE_DAYS.user` | **null**（減衰なし） | 嗜好は古びない |
| `HALF_LIFE_DAYS.feedback` | **null**（減衰なし） | 規約・確定判断は古びない |
| `HALF_LIFE_DAYS.reference` | **180**（日） | 外部リソースへのポインタ |
| `HALF_LIFE_DAYS.project` | **60**（日） | 進行中の意思決定・状態 |
| `HALF_LIFE_DAYS.session` | **30**（日） | セッション要約 |

```ts
export const HALF_LIFE_DAYS: Record<MemoryType, number | null> = {
  user: null, feedback: null, reference: 180, project: 60, session: 30,
};
export const RECENCY_WEIGHT = 0.2;
export const SUPERSEDED_PENALTY = 0.5;

function decayFactor(updatedAt: string, now: Date, type: MemoryType): number {
  const halfLife = HALF_LIFE_DAYS[type];
  if (halfLife === null) return 1;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 1;                       // parse 不能 → 減衰なし（NaN 混入より安全側）
  const ageDays = Math.max(0, (now.getTime() - t) / 86_400_000);  // 未来日は 0 にクランプ
  return 0.5 ** (ageDays / halfLife);
}

function normalizeRelevance(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min;
  if (span === 0) return values.map(() => 1);          // 単一件 / 全件同スコア → 1.0
  return values.map((v) => (v - min) / span);
}

// Array.prototype.sort は安定ソートなので、同スコアは呼び出し側の入力順
// （＝両経路とも relevance 順）を保つ。
function rerank<T extends RerankItem>(items: T[], now: Date): T[] { /* §上記の式を適用してソート */ }
```

`relevance` の出どころは経路によって変わる: bm25 経路は `-bm25(memories_fts, 10, 5, 1)`（SQLite の `bm25()` は小さいほど良いので符号を反転）、PPR 経路は `personalizedPageRank` の定常確率をそのまま使う。

**基準日は `updated_at`**。`link_memories` と `rename` は本文を変えなくても `updated_at` を更新するため厳密には「最後に触られた日」だが、実測でこの 2 経路の呼び出しは 0 回であり実用上は本文更新日として扱える。`content_updated_at` 列は追加していない。

**supersede の逆引き**（`MemoryService.supersededByMap(projectId)`）:

```sql
SELECT s.dst_name AS dst, src.name AS src
  FROM supersedes s JOIN memories src ON src.id = s.src_id
 WHERE src.project_id = ?
 ORDER BY src.updated_at, src.name
```

昇順で走査し `Map.set` で後勝ちにすることで、同じ名前を複数の記憶が supersede した場合は**最も新しく更新された superseder が勝つ**。自己 supersede（`dst === src`）は無視。**推移閉包は取らない**（A→B→C で C は自分を指す B の宣言だけを見る）。存在しない name を supersede した場合は `links` と同じく寛容に無視する。

**返り値への付与**: 読み取り 6 ツール全て（`search_memories` / `find_related` / `get_memory` / `get_memory_index` / `list_memories_by_type` / `search_by_tag`）が該当時のみ `superseded_by: <name>` を返す（キーが無い＝現行）。**減衰（rerank）は bm25/PPR 両検索経路にのみ適用し**、index/list 系ツールは元から `ORDER BY updated_at DESC` のままで並び替えは変えない — `superseded_by` は順位付けのシグナルではなく「これに基づいて行動するな」という正解性のシグナルなので、ランキングの要否とは独立に全ツールへ揃える（2026-08-13 の最終レビューで決定、§9.5）。

**エラー処理のまとめ**:

| ケース | 挙動 |
|---|---|
| `updated_at` が未来日 | `ageDays` を 0 にクランプ → `decay = 1.0` |
| `updated_at` がパース不能 | `decay = 1.0`（減衰なし、NaN 混入を避ける） |
| 候補が 1 件 / 全件同スコア | `normalize = 1.0` |
| 自己 supersede | 無視 |
| 循環 supersede（A↔B） | 両方に penalty がかかるだけ。無限ループなし |
| 存在しない name を supersede | 無視（`links` と同じ） |

### 8.7 評価（`eval/metrics.ts` + `scripts/eval-recall.ts`）

```ts
export function recallAtK(results: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const topK = new Set(results.slice(0, k));
  return relevant.filter((r) => topK.has(r)).length / relevant.length;
}
export function reciprocalRank(results: string[], relevant: string[]): number {
  const rel = new Set(relevant);
  for (let i = 0; i < results.length; i++) if (rel.has(results[i])) return 1 / (i + 1);
  return 0;
}
```

`scripts/eval-recall.ts` は gold セット（`docs/eval/gold-queries.json`: `{ project_id, queries: [{ id, subset, query, query_entities, relevant }] }`）に対し **bm25（`searchFulltext`）と hybrid（`searchAssociative` + `query_entities`）**の recall@5 / MRR を subset 別に集計して出力する。subset は gold データの出現順から動的に導出する（新しい subset を足してもスクリプトを触らない）。

実行:

```bash
LTM_HOME=~/.long-term-memory npx tsx scripts/eval-recall.ts docs/eval/gold-queries.json
```

**評価の再現手順の注意**: 稼働中ストアの `index.db` を `-wal` / `-shm` ごとコピーすると DB 不整合で計測が壊れる。**markdown だけを空の `LTM_HOME` にコピーして `reconcile` で再構築**してから走らせる。

---

## 9. MCP レイヤ

### 9.1 入力スキーマ（`mcp/schemas.ts`）

共通部品:

```ts
const Name = z.string().refine(isValidSlug, 'expected a slug: lowercase a-z / 0-9, hyphen-separated, 1..64 chars');
const Description = z.string().min(1);
const Body = z.string();
const RequiredEntities = z.array(EntityInput)
  .min(1, 'Provide at least one entity (canonical concept name) extracted from the body.');
```

**設計上の決定**: 作成系（`remember_user_fact` / `remember_feedback` / `remember_project_fact`）では `entities` を**必須・非空**にする。これで KG を担う記憶が必ずグラフノードになり、PPR のシードになる。`triples` は任意（全ての事実が意味のある辺を生むわけではなく、強制すると捏造された自己ループを招く）。`update_memory` では KG フィールドはパッチなので optional（省略＝既存グラフを維持）。

`reference` / `session` は**意図的に KG 非対応**（軽量なポインタ / 要約なので entities/triples を取らない）。

| スキーマ | フィールド |
|---|---|
| `RememberUserFactInput` | `name`, `description`, `body`, `tags?`, `links?`, **`entities`(min 1)**, `triples?`, `supersedes?`, `source_refs?` |
| `RememberFeedbackInput` | 上記 + **`why`(min 1)**, **`how_to_apply`(min 1)** |
| `RememberProjectFactInput` | `= RememberFeedbackInput`（同一シェイプ） |
| `RememberReferenceInput` | `name`, `description`, `body`, `url?`(z.string().url()), `tags?`, `supersedes?`, `source_refs?` |
| `RememberSessionSummaryInput` | `name`, `description`, `body`, `tags?`, `supersedes?`, `source_refs?` |
| `UpdateMemoryInput` | `id_or_name`(min 1), `patch{ description?(min 1), body?, tags?, links?, entities?, triples?, supersedes?, source_refs? }` |
| `ForgetMemoryInput` | `id_or_name`, `reason?` |
| `LinkMemoriesInput` | `src`, `dst` |
| `ListByTypeInput` | `type`(enum), `limit?`(int, positive, max 500), `include_shared?` |
| `SearchByTagInput` | `tags`(min 1), `match?`('any'\|'all'), `include_shared?` |
| `FindRelatedInput` | `id_or_name`, `depth?`(int 1..3), `include_shared?` |
| `SearchMemoriesInput` | `query`(min 1), `type?`, `tags?`, `query_entities?`, `include_shared?` |
| `GetMemoryInput` | `id_or_name`, `include_shared?` |
| `GetMemoryIndexInput` | `include_shared?` |
| `ReindexInput` | `z.object({}).strict()` |

**全フィールドに `.describe()` を付ける（実装必須）**。`inputSchema` は JSON Schema としてクライアントに渡り、呼び出し側モデルが引数を組み立てる前に読む唯一の per-argument ドキュメントになる。`refine` のエラーメッセージ（例: slug 規則）は**失敗した後**にしか出ないので、`.describe()` が無いフィールドは名前から推測させることになる。2026-08-14 に `remember_project_fact` が `why` / `how_to_apply` / `entities` 抜きで呼ばれた事故を受けて全フィールドに付与した。`tests/lib/mcp/tools.descriptions.test.ts` が「全ツール・全入力フィールドが非空の description を持つ」ことを固定する。

**`supersedes?` の厳格さは MCP スキーマと `MemorySchema` で意図的に非対称**。MCP 入力側は `z.array(z.string()).optional()`（空文字列も通す）だが、`MemorySchema`（§5.1）は `z.array(z.string().min(1)).default([])`。`save()` は `MemorySchema.parse` を呼ばないため、境界で弾けるのは `update_memory`（`update()` 経由）だけという部分的な閉じ方を承知の上で採用している。

### 9.2 サーバ生成（`mcp/server.ts`）

```ts
export interface ToolContext {
  projectId: string;
  svc: MemoryService;
  canWriteShared?: boolean;   // 有効な maintenance token が提示されたか
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'long-term-memory', version: '0.1.0' });
  registerWriteTools(server, ctx);
  registerReadTools(server, ctx);
  registerMetaTools(server, ctx);
  return server;
}
```

ツール結果ラッパ（`tools/util.ts`）:

```ts
export function json<T>(value: T) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }; }
export function text(value: string) { return { content: [{ type: 'text' as const, text: value }] }; }
```

**全ツールが text コンテンツで返す**（構造化データは JSON 文字列）。

### 9.3 HTTP ブリッジ（`mcp/session.ts` + `mcp/transport.ts`）

MCP SDK の `Server.connect()` は **1 transport しか受け付けない（2 度目は "Already connected"）**。Next.js の単発リクエストモデルとは噛み合わないので、`project_id`（+ 書き込み権限）単位でサーバ + `InMemoryTransport` ペアをキャッシュする。

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant RH as route.ts / transport.ts
    participant S as session.ts (cache)
    participant SV as McpServer + InMemoryTransport
    participant MS as MemoryService

    CC->>RH: POST /api/mcp?project_id=foo (JSON-RPC)
    RH->>RH: extractProjectId / grantsSharedWrite
    RH->>S: getOrCreateSession("foo", canWriteShared)
    alt 初回
        S->>SV: createLinkedPair() → server.connect(serverTransport)
    else 2 回目以降
        S-->>RH: キャッシュ済み Promise を返す
    end
    RH->>SV: clientTransport.send(message)
    SV->>MS: ツール実行
    MS-->>SV: 結果
    SV-->>RH: onmessage → pendingResponses[id] を resolve
    RH-->>CC: HTTP 200 + JSON-RPC レスポンス
```

**セッションキャッシュの要件**:

```ts
const sessions = new Map<string, Promise<Session>>();   // 解決済みではなく Promise をキャッシュ
const key = `${projectId}#${canWriteShared ? 'rw' : 'ro'}`;
```

- **Promise をキャッシュする**: 解決済みセッションをキャッシュすると、同一プロジェクトの初回リクエストが 2 本同時に来たとき両方が「存在チェック」を通過し、サーバが 2 つ作られて 1 つがリークする。
- **書き込み権限もキーに含める**: 読み取り専用の共有セッションを maintenance（書き込み可）リクエストに再利用してはいけない（逆も同様）。区切り文字 `#` は slug にも `__shared__` にも現れないので衝突しない。
- **rejected な Promise はキャッシュに残さない**（`promise.catch(() => sessions.delete(key))`）。
- `clientTransport.onmessage` は `id` を持つメッセージだけ `pendingResponses` から resolver を取り出して解決する。
- テスト用に `resetSessionState()` を用意（全セッションを close して Map をクリアし、`resetMemoryService()` も呼ぶ）。

**`handleMcpRequest(req, opts?)` の分岐**:

| 条件 | 応答 |
|---|---|
| `req.method !== 'POST'` | `405` text `method not allowed` |
| `project_id` 欠落 / 不正 slug | `400` + エラーメッセージ |
| JSON パース失敗 | `400` text `invalid JSON body` |
| `body.id === undefined`（通知） | 送信して `202`（本文なし） |
| `id` あり | レスポンス待ち。既定 **30,000 ms** でタイムアウト |
| タイムアウト | **HTTP 200** で JSON-RPC エラー `{ code: -32000, message: 'timeout waiting for MCP response' }` |

タイムアウト時はタイマを必ず `clearTimeout` する（レスポンス到着時も）。500 を投げずに JSON-RPC エラーで返すのが要件。

**`app/api/mcp/route.ts`**:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) { return handleMcpRequest(req); }
export async function GET() { return new Response('Method Not Allowed', { status: 405 }); }
export async function DELETE() { return new Response('Method Not Allowed', { status: 405 }); }
```

### 9.4 コンテキスト抽出（`mcp/context.ts`）

```ts
export function extractProjectId(url: URL): string {
  const v = url.searchParams.get('project_id');
  if (!v) throw new Error('project_id is required (provide ?project_id=<slug> in the URL)');
  assertProjectId(v);
  return v;
}
export function extractMaintenanceToken(req: Request): string | null {
  return req.headers.get('x-ltm-maintenance-token');
}
```

**トークンは HTTP ヘッダからのみ読む**（URL クエリからは絶対に読まない）。`.mcp.json` や HTTP アクセスログに秘密が載るのを防ぐため。ヘッダ名は大文字小文字を区別しない（`Headers` の仕様）。`AUTH_REQUIRED=1` の MCP は `requireMcpPrincipal(req)` を先に実行し、Bearer PAT の user id と `assertProjectAccess(..., 'read' | 'write')` を照合する。共有書き込みだけは PAT に加えて curator user と maintenance token の二重ゲートを要求する（§19.1–§19.3）。

### 9.5 読み取り 6 ツール（`mcp/tools/read.ts`）

```ts
const SHARED_SEARCH_CAP = 10;   // search_memories 1 回にマージする共有結果の上限
const SHARED_INDEX_CAP = 50;    // index / list 系に追加する共有エントリの上限
```

返却シェイプ:

| ヘルパ | 返す形 |
|---|---|
| `summarize(m, scope, supersededBy?)` | `{ id, name, type, description, body_chars, tags, links, updated_at, scope, superseded_by? }`（`Memory` から算出。`superseded_by` はキーが無ければ「現行」の意味、値があれば置き換え済み） |
| `tagSummary(m, scope, supersededBy?)` | `MemorySummary`（DB 由来: `id, name, type, description, body_chars, updated_at, tags, links`）+ `scope` + `superseded_by?`（`summarize` と同じく該当時のみ spread。2026-08-13 の最終レビューで全読み取りツールに揃えた。§8.6 参照） |
| `concatByName(caller, shared)` | caller 全件 + caller に無い name の shared 分（**project 優先**） |

| ツール | 挙動 | 共有マージ |
|---|---|---|
| `list_memories_by_type` | `listSummaries(projectId, { type, limit: limit ?? 100 })`、`tagSummary` で `superseded_by` を付与 | `concatByName`、共有側 limit = 50。共有側は `SHARED_PROJECT_ID` の `supersededByMap` を使う（caller 側と混同しない） |
| `search_by_tag` | `searchByTagSummaries(projectId, tags, match ?? 'any')`、`tagSummary` で `superseded_by` を付与 | `concatByName`、共有側は `.slice(0, 50)`。マップはスコープ別 |
| `find_related` | `findRelated(projectId, id_or_name, depth ?? 1)` → `{ nodes: summarize[]（superseded_by 付き）, truncated }` | `MemoryNotFoundError` のときだけ共有側で再試行 |
| `search_memories` | `searchAssociative(projectId, query, { queryEntities, type, tags })`（rerank 済み、§8.6）、各件に `summarize` で `superseded_by` を付与 | **`rrfMerge([caller, shared], m => m.name)`**、共有側 limit = 10 |
| `get_memory` | `{ ...svc.get(projectId, id_or_name), scope: 'project', superseded_by? }` | `MemoryNotFoundError` のときだけ共有側（**project 優先**） |
| `get_memory_index` | 全 5 型を `listSummaries(projectId, { type, limit: 500 })` で連結、`tagSummary` で `superseded_by` を付与 | 共有側は 5 型連結 → `.slice(0, 50)`、`concatByName`。共有側は `SHARED_PROJECT_ID` の `supersededByMap` を使う |

共通ルール:
- `include_shared` の既定は **`true`**。
- **自分自身が `__shared__` のときはマージしない**（`ctx.projectId === SHARED_PROJECT_ID` なら caller 分のみ返す）。
- `superseded_by` は **6 ツール全て**に付与する（2026-08-13 決定）。`superseded_by` は順位付けのシグナルではなく「これに基づいて行動するな」という正解性のシグナルであり、`get_memory_index` のように `updated_at DESC` で新しい順に並ぶツールでも省いてよい理由にはならない。読み取りの入口は `search_memories` に一本化したが（§14.2、2026-08-14）、目次を取る経路が残っている以上そこだけ印が供給されないのは不整合になる。各ハンドラは caller 結果に `supersededByMap(ctx.projectId)`、shared 結果に `supersededByMap(SHARED_PROJECT_ID)` を引く。取り違えると誤ったスコープに印が付く（`tests/lib/mcp/tools.supersedes.test.ts` の scope-crossing テストで固定）。

**ツール description（そのまま実装する。LLM の行動を決めるので文言が仕様）**:

| ツール | description |
|---|---|
| `list_memories_by_type` | `List memories of a given type for the current project. \`type\` is the only required argument. Use it to load the highest-signal context for a task before starting: \`feedback\` for rules the user has already corrected you on, \`project\` for decisions in flight.` |
| `search_by_tag` | `Find memories matching the given tags (\`any\` = union, \`all\` = intersection). Precise and cheap when you already know the topic label — every tag shown by get_memory_index is a valid input, so this is the natural follow-up when several memories share a tag you care about.` |
| `find_related` | `Walk the links graph from a memory you already have in hand (by name or id), up to depth 3. The natural follow-up to a search hit or get_memory: linked memories usually hold the constraints and gotchas the first one takes for granted.` |
| `search_memories` | `Recall memories by topic. \`query\` alone is enough — it keyword-searches name, description and body, with no preparation needed. Optionally add \`query_entities\` (canonical concept names from the query) to also run graph-based associative retrieval. Worth one call before non-trivial work on a topic you lack context on: get_memory_index lists one-line descriptions only, so the reasoning a memory carries is in its body, which only this tool and get_memory reach. A result carrying \`superseded_by\` has been replaced by the named memory — prefer that one.` |
| `get_memory` | `Fetch a memory in full, including the body — the reasoning (\`why\`), the trigger conditions (\`how_to_apply\`) and any commands or paths. The index and search results carry the one-line description only, so read the body here before you act on what a memory says.` |
| `get_memory_index` | `Get a compact index of the current project's memories — names, one-line descriptions, tags, links and \`body_chars\`, but no bodies. Shared-scope entries are appended, labeled scope:'shared'. This is a table of contents, not the memories themselves: \`body_chars\` is how many characters of reasoning each entry is withholding, so fetch any entry relevant to the task with get_memory rather than acting on its description alone.` |

### 9.6 書き込み 8 ツール（`mcp/tools/write.ts`）

全ツールの先頭で共有ゲートを通す:

```ts
function assertSharedWritable(ctx: ToolContext): void {
  if (ctx.projectId === SHARED_PROJECT_ID && !ctx.canWriteShared) {
    throw new Error('shared scope is read-only from a project session; writes require a valid maintenance token');
  }
}
```

| ツール | 型 | 特記 | 戻り文 |
|---|---|---|---|
| `remember_user_fact` | `user` | — | `saved user memory <name> (<id>)` |
| `remember_reference` | `reference` | `url` があれば本文末尾に `\n\nURL: <url>` を追記（本文末尾の連続改行は除去してから） | `saved reference memory <name> (<id>)` |
| `remember_session_summary` | `session` | — | `saved session memory <name> (<id>)` |
| `remember_feedback` | `feedback` | `composeWhyHowBody` で本文を合成 | `saved feedback memory <name> (<id>)` |
| `remember_project_fact` | `project` | 同上 | `saved project memory <name> (<id>)` |
| `update_memory` | — | `updateAsync(projectId, id_or_name, patch)` | `updated <name> (<id>)` |
| `forget_memory` | — | `forgetAsync` | `forgot <id_or_name>` |
| `link_memories` | — | `linkMemoriesAsync` | `linked <src> -> <dst>` |

**`composeWhyHowBody`（`tools/compose.ts`）** — 冪等:

```ts
function alreadyHasSections(body: string) {
  return /\*\*Why:\*\*/.test(body) && /\*\*How to apply:\*\*/.test(body);
}
export function composeWhyHowBody(body: string, why: string, howToApply: string): string {
  if (alreadyHasSections(body)) return body;
  const trimmed = body.replace(/\n+$/, '');
  return `${trimmed}\n\n**Why:** ${why}\n**How to apply:** ${howToApply}`;
}
```

書き込みツールの description（KG を必ず埋めさせるための文言。実装必須）:

**必須引数は description 本文でも名指しする**。JSON Schema の `required` 配列だけでは呼び出し側が落とすことが実際に起きた（2026-08-14、`remember_project_fact` を `why` / `how_to_apply` / `entities` 抜きで呼んで validation error）。旧文言の "Records why and how to apply." は**ツールの振る舞い**の説明としか読めず、「`why` と `how_to_apply` という引数を自分で渡す」ことを指示していなかった。`tests/lib/mcp/tools.descriptions.test.ts` が「非自明な必須引数がバッククォート付きで description に現れる」ことを固定する。

- `remember_user_fact` — `Save a memory about the user (role, preferences, skills). Required arguments: \`name\`, \`description\`, \`body\`, \`entities\`. \`entities\` must be non-empty — extract the canonical concept names (plus aliases) the body is about, or the memory never becomes a graph node and associative recall cannot reach it. Also add \`triples\` [subject, predicate, object] for any relation the body states; subjects/objects must be canonical names listed in \`entities\`. When this memory replaces an earlier one, pass the old name in \`supersedes\` so recall demotes it instead of returning both.`
- `remember_feedback` — `Save corrective feedback or a confirmed judgment call. Required arguments: \`name\`, \`description\`, \`body\`, \`why\`, \`how_to_apply\`, \`entities\` — a call missing any of them is rejected. \`why\` (the rationale) and \`how_to_apply\` (the trigger condition for a future session) are separate arguments, not something to fold into \`body\`: they are appended to it as \`**Why:**\` / \`**How to apply:**\` lines. \`entities\` must be non-empty — the canonical concept names (plus aliases) the body is about — or associative recall cannot reach the memory. Also add \`triples\` ...（同型）When this memory replaces an earlier one, pass the old name in \`supersedes\` so recall demotes it instead of returning both.`
- `remember_project_fact` — `Save a project decision, deadline, or in-flight motivation. Required arguments: ...（remember_feedback と同一シェイプである旨を明記した同型の文言）A record of what got done — an implementation landing, a merged PR, a finished フェーズ — is not a project fact: save it with remember_session_summary so it decays on schedule instead of ranking alongside decisions that are still in force. Keep dates and PR numbers out of a project memory \`name\`; needing one is the signal that it belongs in a session. When this memory replaces an earlier one, pass the old name in \`supersedes\` so recall demotes it instead of returning both.`
- `remember_reference` — `Save a pointer to an external resource (URL, dashboard, channel). Required arguments: \`name\`, \`description\`, \`body\`; put the link in \`url\` so it is appended to the body. Reference memories deliberately carry no \`entities\` / \`triples\` — they are pointers, not knowledge-graph facts, so use remember_project_fact when the substance is the finding rather than the link.`
- `remember_session_summary` — `Save a summary of what was done in a session. Required arguments: \`name\`, \`description\`, \`body\`. Session memories carry no \`entities\` / \`triples\` and decay fastest in ranking (30-day half-life), so anything meant to outlive this work belongs in remember_project_fact or remember_feedback instead.`
- `update_memory` — `Patch an existing memory (description, body, tags, links, entities, triples, supersedes). Every patch field is optional and overwrites wholesale — an omitted field is left untouched, a supplied one replaces the old value rather than merging into it. When you change \`body\`, re-supply \`entities\` (and \`triples\` where relations changed) so the knowledge graph stays in sync with the new text — omitting them leaves the old graph in place. There are no \`why\` / \`how_to_apply\` arguments here (unlike remember_feedback / remember_project_fact): to keep those sections on a patched body, write the \`**Why:**\` and \`**How to apply:**\` lines into \`patch.body\` yourself.`
- `forget_memory` — `Permanently delete a memory — the markdown file and every index row go with it, there is no soft delete, tombstone or undo. Confirm with the user before calling. When the memory is merely out of date, prefer update_memory, or save the replacement with \`supersedes: ["<old-name>"]\` so the history survives.`
- `link_memories` — `Add a related-link from one memory to another (directional: \`src\` → \`dst\`). The edge is walked by find_related and weighted in associative recall. \`src\` is a name or id and must already exist; \`dst\` must be a memory *name* (slug) — an id is rejected — but does not have to exist yet. Use it to connect a memory to prerequisites and gotchas discovered later — for "this replaced that", pass \`supersedes\` on the write instead.`
  - **`src` と `dst` の非対称を description で書き分ける**。`linkMemories()` は `dst` に `assertMemoryName()` を掛けるので ULID を渡すと `SlugError` になる（§7）。「by name or id」を両引数に係る形で書くと誤案内になる（2026-08-14 の Codex レビュー指摘）。

`update_memory` の文言は `composeWhyHowBody` が**作成経路にしか無い**ことの埋め合わせでもある。パッチ経路は `**Why:**` / `**How to apply:**` を自動で付け直さないので、body を丸ごと差し替えると feedback / project 記憶からこのセクションが消える。

### 9.7 メタ 2 ツール（`mcp/tools/meta.ts`）

| ツール | 入力 | 挙動 | description |
|---|---|---|---|
| `list_projects` | **なし**（`inputSchema` を渡さない） | `json(svc.listProjects())` | `List all projects that have memories, with counts and last-update.` |
| `reindex` | `ReindexInput`（`{}` strict） | `svc.reindex()` → `text('reindex complete')` | `Rebuild the SQLite index from markdown files. Useful after external edits.` |

**合計 16 ツール**（write 8 + read 6 + meta 2）。`tests/lib/mcp/server.test.ts` がこの数を検証する。

---

## 10. 共有スコープ `__shared__`

### 10.1 コンセプト

```mermaid
flowchart LR
    subgraph P["project session (?project_id=my-app)"]
        R["読み取りツール"] --> M{"マージ"}
    end
    PM[("projects/my-app/memories")] --> M
    SM[("projects/__shared__/memories")] --> M
    M --> OUT["scope: 'project' | 'shared' でラベル付けして返す"]
    W["書き込みツール"] -->|"projectId が __shared__ かつ<br/>トークン無し → 例外"| X((拒否))
    C["curator (?project_id=__shared__<br/>+ X-LTM-Maintenance-Token)"] --> SM
```

### 10.2 読み取り規則（再掲）

| 項目 | 値 |
|---|---|
| 既定 | `include_shared: true`（全 6 読み取りツール） |
| ラベル | 各件に `scope: 'project' | 'shared'` |
| 同名衝突 | **project 優先** |
| `search_memories` の融合 | RRF（k=60）、共有側は最大 10 件 |
| その他の融合 | project 先頭 + name で dedup、共有側は最大 50 件 |
| `get_memory` / `find_related` | project で `MemoryNotFoundError` のときだけ共有へフォールバック |
| 自身が `__shared__` のとき | マージしない |

### 10.3 書き込みゲート

```ts
export function grantsSharedWrite(token: string | null): boolean {
  const expected = process.env.LTM_MAINTENANCE_TOKEN;
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- **env 未設定なら誰も書けない**（安全側デフォルト）。
- **定数時間比較**（`timingSafeEqual`）。長さが違う場合は先に false（`timingSafeEqual` は長さ不一致で throw するため）。
- Web API（`PUT` / `DELETE /api/memories/[id]`）は `__shared__` を**常に 403**（トークンに関係なく）。
- Web UI は `/p/__shared__` を閲覧専用表示（Edit / Delete を出さない、home に `shared` バッジ）。
- 差分更新の来歴は frontmatter の `source_refs`（由来プロジェクト + メモリ名）に記録する。

---

## 11. REST API と Web UI

### 11.1 HTTP ヘルパ（`lib/http.ts`）

```ts
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
export function errorResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain' } });
}
```

### 11.2 API ルート

すべて `export const runtime = 'nodejs'` / `export const dynamic = 'force-dynamic'`。Vercel の `AUTH_REQUIRED=1` では、各 route が service 呼び出しより先に `getWebPrincipal()` と `assertProjectAccess()` を実行し、未認証は `401`、membership 不足は `403` を返す（詳細は §19.3）。localhost の `AUTH_REQUIRED=0` だけ匿名 principal を許可する。

**`GET /api/projects`** → `listProjects()` の JSON（200）。認証必須環境では Clerk session の read 権限を持つ project だけ返す。

**`POST /api/projects`** → Clerk session のユーザーを owner として slug を登録する。slug 重複は `409`、未認証は `401`。

**`PUT /api/memories/[id]?project_id=<slug>`**

```ts
const PatchSchema = z.object({
  description: z.string().min(1).optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
}).strict();
```

| 条件 | 応答 |
|---|---|
| `project_id` 欠落 | `400` `project_id query param required` |
| `project_id` 不正 | `400` + `SlugError` メッセージ |
| `project_id === '__shared__'` | **`403` `shared scope is read-only`** |
| JSON パース失敗 | `400` `invalid JSON body` |
| スキーマ違反 | `400` + zod エラーメッセージ |
| `MemoryNotFoundError` | `404` |
| その他例外 | `500` |
| 成功 | `200` + 更新後 `Memory` JSON |

**`.strict()` が必須**: 未知キーを弾く（KG フィールドは MCP ツールからのみ編集可）。また `tags: "abc"` のような型違いを弾かないと、DB には 1 文字ずつ入り markdown は生文字列を保つという乖離が起きる。

**`DELETE /api/memories/[id]?project_id=<slug>`** — 同じ `project_id` 検証。成功で `200 { deleted: true }`、`MemoryNotFoundError` で `404`。

> `[id]` セグメントは実際には **name でも id でも動く**（`svc.get`/`update`/`forget` が `id = ? OR name = ?` で引く）。UI は name を渡している。

### 11.3 UI ルート

| ルート | 内容 |
|---|---|
| `/` | プロジェクト一覧テーブル（Project / Memories / Last updated (JST)）。`shared` なプロジェクトにバッジ。空なら案内文 |
| `/search` | GET フォーム（`?q=`）。全プロジェクトを `searchFulltext` で横断し `projectId / name / description / type` を表示 |
| `/p/<slug>` | 型別カウント（`listByType(slug, t, 500).length`）と合計、記憶一覧・グラフへのリンク |
| `/p/<slug>/memories?type=&tag=` | `tag` があれば `searchByTag`（+ 任意で type フィルタ）、`type` のみなら `listByType`、どちらも無ければ全型を連結して `updated_at DESC`。`svc.supersededByMap(slug)` を 1 回呼び、各行の description と tags の間に該当時のみ「置き換え済み」バッジ（`.superseded-badge`、新側 name へのリンク）を挟む（schema v5） |
| `/p/<slug>/memories/<name>` | 詳細。type バッジ / description / tags / links / entities（別名は tooltip と併記）/ triples / 本文（`react-markdown`）/ ID・日時 / Edit ボタン。`svc.supersededByMap(slug).get(memory.name)` があれば description 直後に「置き換え済み」バッジ（`.superseded-badge`、新側 name へのリンク）、`memory.supersedes` が非空なら Supersedes: 行（旧側 name への相互リンク、schema v5） |
| `/p/<slug>/memories/<name>/edit` | `MemoryEditor`。**`__shared__` なら読み取り専用メッセージのみ** |
| `/p/<slug>/graph` | `buildKgGraph(svc.readKgGraph(slug))` を `KgGraph` に渡す。memories / entities / edges 件数を表示 |
| `/dashboard?project=<slug>&days=<n>` | 使用状況ダッシュボード（`src/app/dashboard/page.tsx`）。**MCP 経由のツール呼び出しのみ集計**（Web UI 上の編集は含まない）。`days`（既定 30・上限 365）で期間、`project` で絞り込み。期間プリセット `7/30/90` 日へのリンクと「全プロジェクト」リンク（`period-nav`）。詳細は §6.4 参照 |

全ページ共通: `export const dynamic = 'force-dynamic'`、`params` / `searchParams` は **Promise（Next.js 16）なので `await` する**、不正 slug は `<p>Invalid project slug.</p>`、`isValidSlug(slug) || isReservedProjectId(slug)` で判定。

### 11.4 CSS（`app/globals.css` 全文）

```css
* { box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; color: #111; background: #fafafa; }
main { max-width: 1024px; margin: 0 auto; padding: 24px; }
a { color: #0366d6; text-decoration: none; }
a:hover { text-decoration: underline; }
header.app-header { background: #fff; border-bottom: 1px solid #e1e4e8; padding: 12px 24px; display: flex; gap: 16px; align-items: center; }
header.app-header a { color: #111; font-weight: 500; }
header.app-header .brand { font-size: 18px; font-weight: 600; margin-right: auto; }
.card { background: #fff; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; margin-bottom: 12px; }
.type-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; margin-right: 8px; }
.type-user { background: #e7f3ff; color: #0366d6; }
.type-feedback { background: #fff5b1; color: #735c0f; }
.type-project { background: #e6ffed; color: #22863a; }
.type-reference { background: #f1e9ff; color: #6f42c1; }
.type-session { background: #f6f8fa; color: #586069; }
.tag { display: inline-block; padding: 1px 6px; background: #f1f8ff; border-radius: 4px; font-size: 11px; color: #0366d6; margin-right: 4px; }
.superseded-badge {
  background: #fff4e5;
  border-left: 3px solid #d98324;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
}
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px; text-align: left; border-bottom: 1px solid #e1e4e8; }
th { background: #f6f8fa; font-weight: 600; }
textarea { width: 100%; min-height: 300px; padding: 12px; font-family: ui-monospace, monospace; font-size: 14px; border: 1px solid #d1d5da; border-radius: 6px; }
button { padding: 6px 14px; border-radius: 4px; border: 1px solid #d1d5da; background: #fafbfc; cursor: pointer; font-size: 14px; }
button.primary { background: #2ea44f; color: #fff; border-color: #2ea44f; }
button.danger { background: #d73a49; color: #fff; border-color: #d73a49; }
.muted { color: #586069; font-size: 13px; }
```

### 11.5 クライアントコンポーネント

**`MemoryEditor`**（`'use client'`）: description / tags(カンマ区切り) / links(カンマ区切り) / body(textarea) + 右に `react-markdown` プレビューの 2 カラム。Save は `PUT /api/memories/<name>?project_id=<slug>`、成功で詳細へ `router.push` + `router.refresh()`。Delete は `confirm()` してから `DELETE`、成功で一覧へ。エラーは赤文字表示。

**`DeleteMemoryButton`**: `confirm()` → `DELETE` → `router.refresh()`。共有スコープでは描画しない。

---

## 12. グラフ可視化（KgGraph）

### 12.1 `graph/builder.ts` — 表示用グラフの組み立て

`MemoryService.readKgGraph(projectId)` が返す生データ:

```ts
interface KgGraphData {
  memories: { id, name, type, description, tags }[];
  entities: { id, name }[];
  memberships: { memoryId, entityId }[];
  edges: { srcEntityId, dstEntityId, relation }[];
  links: { srcMemoryId, dstName }[];
}
```

`buildKgGraph(data)` の変換規則:

| 出力 | 規則 |
|---|---|
| memory ノード | `{ id: m.id, kind: 'memory', data: { label: m.name, memoryType, description, tags } }` |
| entity ノード | `{ id: 'ent:'+e.id, kind: 'entity', data: { label: e.name } }` |
| membership 辺 | id `mem:<memoryId>-><entityId>`、weight 1 |
| triple 辺 | id `tri:<src>-><dst>:<relation>`、`label = relation`、weight 1 |
| link 辺 | id `lnk:<srcMemoryId>-><targetId>`、weight 2。**name が解決できない dst は捨てる** |

### 12.2 `graph/kg-view.ts` — 表示フィルタ

```ts
interface KgFilters {
  showMemory: boolean; showEntity: boolean;
  showMembership: boolean; showTriple: boolean; showLink: boolean;
  tags: string[];   // 非空なら「いずれかのタグを持つ memory ノード」だけ残す
}
export const MEMORIES_ONLY_FILTERS: KgFilters = {
  showMemory: true, showEntity: false,
  showMembership: false, showTriple: false, showLink: true, tags: [],
};
```

- `filterKgGraph`: ノードを絞ってから、**両端が残っている辺だけ**残す。
- `kgNeighbors(graph, nodeId)`: 自身 + 直接隣接ノードの `Set`（クリックフォーカスの dimming に使う）。
- タグフィルタは memory ノードにのみ作用（entity は影響を受けない）。

### 12.3 `components/KgGraph.tsx` の描画仕様

寸法・配色（そのまま実装する）:

```ts
const MEM_W = 220, MEM_H = 84, ENT_W = 132, ENT_H = 44;

const TYPE_ACCENT = {
  user:      { accent: '#2563eb', tint: '#eff6ff', ring: '#bfdbfe', label: 'USER' },
  feedback:  { accent: '#d97706', tint: '#fffbeb', ring: '#fde68a', label: 'FEEDBACK' },
  project:   { accent: '#059669', tint: '#ecfdf5', ring: '#a7f3d0', label: 'PROJECT' },
  reference: { accent: '#7c3aed', tint: '#f5f3ff', ring: '#ddd6fe', label: 'REFERENCE' },
  session:   { accent: '#4b5563', tint: '#f9fafb', ring: '#d1d5db', label: 'SESSION' },
};
const EDGE_STYLE = {
  membership: { stroke: '#cbd5e1', width: 1.25, opacity: 0.45 },  // ラベル「所属」
  triple:     { stroke: '#6366f1', width: 1.75, opacity: 0.75 },  // ラベル「トリプル」
  link:       { stroke: '#f97316', width: 2.5,  opacity: 0.85 },  // ラベル「リンク」
};
```

**2 段構えの計算**（これが性能要件）:

1. **重い段 `computePositions(graph)`** — d3-force を**グラフ形状が変わったときだけ**実行。`useMemo([displayed])`。
   ```ts
   forceSimulation(simNodes)
     .force('charge', forceManyBody().strength(-520))
     .force('link', forceLink(simLinks).id(d => d.id)
        .distance(l => l.kind === 'membership' ? 70 : l.kind === 'triple' ? 120 : 165)
        .strength(0.75))
     .force('collide', forceCollide().radius(d => Math.hypot(d.w, d.h) / 2 + 10).iterations(2))
     .force('x', forceX(0).strength(0.045))
     .force('y', forceY(0).strength(0.07))
     .stop();
   for (let i = 0; i < 340; i++) sim.tick();
   ```
2. **軽い段 `decorate(...)`** — 座標を所与として dim / label / style だけ付け直す。hover / focus で再実行されるが配列の map のみ。

UI の既定と操作:

| 項目 | 既定 / 挙動 |
|---|---|
| モード | `kg`（セグメントコントロールで「記憶のみ」/「知識グラフ」） |
| membership レイヤ | **既定 OFF**（最も密なので初期表示が毛玉になる） |
| 孤立 entity | 現在の表示で可視辺が 0 本の entity ノードは隠す。memory ノードは常に残す |
| 単クリック | 近傍にフォーカス（他を dim）。同じノードを再クリックで解除 |
| ダブルクリック | memory なら詳細ページへ遷移 |
| ↗ ボタン | 詳細ページへのリンク（`stopPropagation`） |
| エッジ hover | triple の述語ラベルを表示 |
| タグ絞り込み | ドロップダウンでトグル、クリアボタン付き |
| ReactFlow 設定 | `fitView`, `padding: 0.22`, `nodesDraggable: false`, `hideAttribution: true`, `minZoom: 0.12`, `maxZoom: 2.2`, Dots 背景（gap 22, size 1, `#d3dbe6`）, Controls（`showInteractive: false`） |
| キャンバス | 高さ 680、`radial-gradient` 背景、左下に凡例 |
| 空グラフ | `No memories yet. Save some via the MCP tools, then they will appear here.` |

---

## 13. 配布・運用（Docker / scripts / launchd）

### 13.1 Dockerfile（全文）

```dockerfile
# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm build

FROM deps AS prod_deps
RUN pnpm prune --prod

FROM base AS runner
ENV NODE_ENV=production \
    LTM_HOME=/data \
    PORT=3939
COPY --from=prod_deps /app/node_modules ./node_modules
COPY --from=builder  /app/.next        ./.next
COPY --from=builder  /app/public       ./public
COPY --from=builder  /app/src/lib/db/schema.sql ./src/lib/db/schema.sql
COPY package.json next.config.ts ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3939
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3939"]
```

**`schema.sql` の明示コピーが必須**: `migrate.ts` は `import.meta.url` からの相対で実ファイルを読むので、`.next` のバンドルには含まれない。忘れると起動時に `ENOENT` になる。
ネイティブビルドのため `python3 make g++` が必要。

### 13.2 docker-compose.yml

```yaml
services:
  long-term-memory:
    build: { context: ., dockerfile: Dockerfile }
    image: long-term-memory:latest
    container_name: long-term-memory
    ports: ["3939:3939"]
    environment:
      - LTM_MAINTENANCE_TOKEN=${LTM_MAINTENANCE_TOKEN:-}
    volumes:
      - type: bind
        source: ${LTM_STORE_HOST:-./.long-term-memory}
        target: /data
        bind:
          create_host_path: false
    networks: [local_dev_network]
    restart: unless-stopped

networks:
  local_dev_network:
    external: true
```

- **短縮構文ではなく long syntax + `create_host_path: false`**。短縮構文は source が無いとディレクトリを黙って作るので、`LTM_STORE_HOST` のタイプミスや移行漏れが「空のストアで正常起動」に化けて気付けない。副作用として**初回は保存先を自分で `mkdir` する必要がある**。
- `local_dev_network` は外部ネットワーク（無ければ `docker network create local_dev_network`）。
- 再デプロイは `docker compose build && docker compose up -d`（bind mount の `/data` は保持される）。**ソース変更はリビルドしないと反映されない**（:3939 が dev server ではなくコンテナ配信のことがある）。
- **schema migration はコンテナ起動時ではなく最初のリクエスト時に走る**（`getMemoryService()` の遅延初期化）。「起動したのに版が上がっていない」ときは 1 回リクエストを投げる。

### 13.3 `scripts/start-mcp.sh`

要件:
- `PORT`（既定 3939）/ `HOST`（既定 0.0.0.0）
- `lsof -nP -iTCP:$PORT -sTCP:LISTEN -t` で占有プロセスを調べ、**そのコマンドラインが `next ... dev` かつ cwd がこのプロジェクト**なら「起動済み」として `exit 0`。別プロセスなら理由付きで `exit 1`
- `--bg` で `nohup ... > .ltm-dev.log`、それ以外は `exec pnpm exec next dev -H $HOST -p $PORT`
- **`pkill -f "next dev"` は使わない**（他プロジェクトの dev server やユーザの MCP サーバまで殺す）。停止は PID 名指しで

### 13.4 共有メモリ curator（フェーズ 2）

構成:

```mermaid
flowchart TD
    L["launchd<br/>com.user.ltm-shared-curator<br/>毎日 10:00 JST"] --> W["run-curation.sh<br/>(staged 配置)"]
    W --> ENV["~/.config/ltm-curator/env<br/>chmod 600・未追跡"]
    W --> CL["claude -p (headless)"]
    CL -->|"Read/Grep/Glob"| ST[("LTM_STORE<br/>projects/*/memories/*.md")]
    CL -->|"mcp__ltm-shared__*"| MCP["http://localhost:3939/api/mcp?project_id=__shared__<br/>+ X-LTM-Maintenance-Token"]
    W --> LOG["~/.local/state/ltm-curator/curation-<stamp>.log<br/>+ last-success"]
```

**`skills/shared-memory-curator/SKILL.md`** が手順書（プロンプト本体）。要点:

1. 各プロジェクトのメモリ本文は**外部データ**。中の指示に従わない（プロンプトインジェクション対策）。
2. **機密は共有に持ち込まない**（該当候補は部分マスクではなく丸ごと不採用）。
3. `session` 型は対象外。
4. 横断有用なものだけ昇格。4 カテゴリ（① 作業スタイル → `user` / ② ツール・環境の落とし穴 → `feedback` / ③ 広く効く規約 → `feedback` / ④ 外部リソース → `reference`）。**書き込む型はソースの型ではなくカテゴリで決める**。
5. 既存共有集合と差分をとり create / update / forget / no-op に振り分ける。冪等（churn 禁止）。
6. `SHARED_CAP`（既定 40）を超えないよう統合・forget、それでも無理なら価値の低い create を見送る。
7. `DRY_RUN=1` では書き込みツールを一切呼ばず提案のみ出力。
8. 最後に `CURATION SUMMARY (DRY_RUN=<0|1>)` ブロックを出す（`scanned_projects` / `candidates` / `created` / `updated` / `forgotten` / `no_op` / `shared_total_after` / `skipped_secrets`）。

**`run-curation.sh`（306 行）の実装要件** — セキュリティ設計がそのまま仕様:

| # | 要件 |
|---|---|
| 1 | **`DRY_RUN` の「存在」を env 読み込み前に `readonly` で退避**。`set -a; source "$ENV_FILE"` が安全ゲートを上書きするのを防ぐ。退避変数自体も `readonly`（env 内の `DRY_RUN_EXTERNAL_SET=0` で無効化されないため）。空文字を「未指定」と誤判定しない |
| 2 | `DRY_RUN` は **`0` か `1` 以外なら起動前に fail**（想定外の値で書き込み側に倒れない） |
| 3 | 配置は 2 通り。**スクリプトの隣に `SKILL.md` があれば `staged`、無ければ `repo`**。staged では `LTM_STORE` / `CLAUDE_BIN` は絶対パス必須、`LTM_STORE` が TCC 保護ディレクトリ（`~/Documents` `~/Desktop` `~/Downloads`）配下に解決されたら fail |
| 4 | `cd "$LTM_STORE"` してから `claude -p` を起動する（**cwd は headless agent の暗黙 Read ルート**。REPO_ROOT のままだと `<repo>/.env` の生きたトークンまで読める） |
| 5 | 権限フラグ: `--mcp-config <file>` `--strict-mcp-config` `--add-dir "$LTM_STORE"` **`--tools Read Grep Glob`**（built-in を排他指定。Bash/Write/Edit が集合に存在しない＝主防御）`--setting-sources user`（プロジェクト/ローカル設定の継承を断つ）`--allowedTools ...`（追加式なので単体では絞れない）`--disallowedTools 'Read(**/.env)' 'Read(**/.env.*)'` `--permission-mode dontAsk` `--output-format text` |
| 6 | `DRY_RUN=1` では書き込み系 MCP ツールを `--allowedTools` に入れず、さらに `--disallowedTools` にも明示追加（多層防御） |
| 7 | ログは `chmod 700` のディレクトリへ。**成功スタンプ（`last-success`）はプロセス終了コードでは決めない** — モデルがツールエラーを本文として返しつつ 0 で終わる経路がある |
| 8 | 成功判定は awk の状態機械で「`CURATION SUMMARY (DRY_RUN=<dr>)` の**行全体一致**を開始行とし、その**後**に `scanned_projects` / `no_op` / `shared_total_after` が数値で現れる」ことを要求。値の末尾までは固定しない（モデルが数値の後ろに自由記述を付けるため。厳格にすると成功した実行を誤って落とす） |

**`scripts/curator/ltm-shared-curator.mcp.json`**:

```json
{
  "mcpServers": {
    "ltm-shared": {
      "type": "http",
      "url": "http://localhost:3939/api/mcp?project_id=__shared__",
      "headers": { "X-LTM-Maintenance-Token": "${LTM_MAINTENANCE_TOKEN}" }
    }
  }
}
```

`scripts/curator/install.sh` は wrapper / SKILL.md / MCP 設定を 1 ディレクトリ（`~/.local/libexec/ltm-curator` 等）へステージし、plist をレンダリングする。

### 13.5 launchd plist

```xml
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>__LIBEXEC__/run-curation.sh</string>
</array>
<key>WorkingDirectory</key><string>/tmp</string>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key><string>__HOME__/.local/state/ltm-curator/launchd.out.log</string>
<key>StandardErrorPath</key><string>__HOME__/.local/state/ltm-curator/launchd.err.log</string>
```

- **`ProgramArguments` / `WorkingDirectory` は `~/Documents` 配下を指してはならない**。launchd 由来のプロセスは TCC で `~/Documents` にアクセスできず、`Operation not permitted`（**終了コード 126**）で起動すらしない。手動実行は成功するので導入検証をすり抜ける。
- ログイン shell（`/bin/zsh -lc`）は使わない。必要な PATH は env の `LTM_CURATOR_PATH` で明示。
- **Mac が起きている時刻を選ぶ**（launchd はスリープ中に発火せず、復帰時にまとめて実行する保証もない）。

### 13.6 開発用 devcontainer

`.devcontainer/` は Next.js と MCP の実装作業を同じ環境で再現するための開発専用構成であり、13.1–13.2 の本番配布用 Dockerfile / compose とは分ける。

- `Dockerfile` は `node:22-bookworm-slim` を基にし、pnpm 11.1.3、OpenAI Codex CLI 0.153.4、Turso CLI（公式インストーラー）、Git / Git Flow、GitHub CLI（`gh`）、`jq`、`better-sqlite3` のビルドに必要な Python・make・g++、SQLite CLI を入れる。Turso CLI は `node` ユーザーの `/home/node/.turso` に導入し、認証情報はイメージへ含めない。実行ユーザーは root ではなく `node` とする。
- `compose.yaml` はリポジトリを `/workspace` に bind mount し、名前付き volume `long-term-memory-node_modules` を `/workspace/node_modules` に、`long-term-memory-codex` を `/home/node/.codex` にマウントする。ソース変更を即時反映し、依存関係と Codex 設定だけをコンテナ再作成後も保持する。
- `devcontainer.json` は Compose の `app` サービスへ接続し、ポート 3000（Next.js）/ 3939（MCP）を転送する。`package.json` が存在するときだけ `pnpm install` を実行するため、初期 docs-only 状態でもコンテナを起動できる。
- VS Code 接続時は `customizations.vscode.extensions` で `openai.chatgpt` 拡張機能を導入する。
- ローカル開発では `AUTH_REQUIRED=0` とし、Vercel 本番の `AUTH_REQUIRED=1`（§19）と区別する。

---

## 14. クライアント側資産（Claude Code 側）

サーバだけ作っても「記憶が使われる」状態にはならない。**読み取り経路を能動化する 3 点セット**が必要。

### 14.1 `skills/long-term-memory/SKILL.md`（219 行）

frontmatter の `description` が発火条件そのものなので、そのまま使う:

> When the long-term-memory MCP tools (`mcp__long-term-memory__*`) are available, use them proactively without waiting for the user to ask. Trigger before substantive work to search for relevant prior memories, and whenever the user states a preference, makes a correction, decides project policy, references an external resource, or says anything like "remember", "save this", "recall", or "what do we have on X". Invoke this skill whenever you spot the `mcp__long-term-memory__*` tools in the available tools list — the whole point is for memory to feel ambient, not opt-in.

本文の構成: メンタルモデル（5 型・project_id は URL 由来）→ **3 原則**（作業前に読む / 入口は index ではなく検索 / 非自明なものだけ保存）→ トリガーマップ（表）→ 実作業前 → 保存の規律（save / don't-save 例）→ 命名 → リンク → 想起 → 連想検索（HippoRAG）→ 削除 → subagent への引き渡し → アンチパターン → 例 5 本 → ツール一覧。

特に落とせない記述:

- 「**要約を recall と誤認するな**」— 本文を読まずに動くのは題名だけで動いているのと同じ。
- 「**セッション冒頭に `get_memory_index` を丸ごと読むな**」— タスクではなくストア規模に比例して膨らみ、一定量を超えると応答ごとコンテキスト上限で破棄される。入口は `search_memories`（2026-08-14 変更）。
- 「**要約が十分そうに見えたからといって事前検索を省くな**」— 読んでいない本文と要約を比べる判断なので構造的に信用できない。
- 「**subagent には hook も skill も届かない**」— 調査・実装を任せるなら「作業前に `search_memories` を引け」をプロンプトに明記する。
- 日本語クエリの注意（trigram は 3 文字以上、2 文字語だけのクエリは LIKE フォールバックで本文に当たらない）。

### 14.2 `claude-config/hooks/ltm-init-reminder.sh`（UserPromptSubmit hook）

**発火は 1 段だけ**（81 行、bash + jq）:

| 発火条件 | 注入内容 |
|---|---|
| 実作業らしい最初のターン（1 セッション 1 回、`$TMPDIR/claude-ltm-read-<session_id>.flag`） | `search_memories` を最低 1 回引け + `get_memory` で本文まで読め + subagent への明記 + 「`get_memory_index` の全件読み込みは入口にするな」 |

> **セッション初回に `get_memory_index` を促す段は 2026-08-14 に廃止した。** index は記憶数に比例して肥大し、応答がコンテキスト上限に当たって丸ごと破棄される。読めた場合も一行要約で満足して本文を読まない誘因にしかなっていなかった。再実装時にこの段を復活させないこと。

「実作業らしさ」の判定（jq 内の正規表現、大文字小文字無視）:

```
実装|修正|直し|直す|調査|原因|なぜ|設計|追加|削除|リファクタ|レビュー|バグ|不具合|テスト|移行|対応|作って|変えて|実行|導入|
implement|fix|refactor|investigat|debug|review|design|migrat|add |remove|build|deploy
```

または**プロンプト長 40 文字以上**。該当しなければ何も注入しない（雑談ターンで鳴らさない）。

実装上の注意:
- `set -uo pipefail`（`-e` は付けない）。**失敗しても静かに `exit 0`**（hook の失敗は画面に出ないので、ユーザの作業を止めない）。
- リマインド本文は `emit() { local ctx; ctx=$(cat); jq -n --arg ctx "$ctx" '...' }` に **stdin (heredoc) で渡す**。`emit "$(cat <<'CTX' ... )"` の形だと、本文中のアポストロフィが奇数個あるだけで bash が未終端クォートと解釈し**スクリプト全体が構文エラー**になる（＝リマインドが二度と飛ばなくなり、しかも気付けない）。
- 出力形式:
  ```json
  { "continue": true,
    "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<...>" } }
  ```

### 14.3 `claude-config/claude-md-block.md`

`~/.claude/CLAUDE.md`（ユーザレベル）に差し込む MUST ブロック。`<!-- ltm:begin -->` / `<!-- ltm:end -->` マーカーで囲む。内容は 6 項目:

1. **作業前に `search_memories` を引く**（非自明な作業の着手前に最低 1 回、拠り所にする記憶は `get_memory` で本文まで）
2. **セッション開始時に `get_memory_index` を全件読む運用はしない**（入口は `search_memories` / `search_by_tag` / `list_memories_by_type`）
3. 機密情報は保存しない
4. 長期保存先は MCP 側を優先（auto memory との二重保存を避ける）
5. 書き込みは確認不要・能動的に（`AskUserQuestion` を挟まない）
6. subagent には記憶検索を明示的に持たせる

> **なぜ hook と CLAUDE.md と skill の 3 点が必要か**: 実測（Claude Code の transcript 336 本を `tool_use` 単位で集計）で、書き込み 28 回に対し `search_memories` は通算 1 回、`find_related` / `search_by_tag` / `list_memories_by_type` は 0 回だった。「初回 index だけ MUST、以降の読み取りは任意」という非対称な指示にすると、一行要約で満足して本文を一度も読まないまま作業に入る。**1（読み取り MUST）と 6（subagent）を落とすと読み取りは動かない。**

### 14.4 設置手順（`docs/post-mcp-setup.md` のコピペプロンプト）

設置経路は **1 本だけ**。ドキュメント内のプロンプトを Claude Code のメッセージ欄に貼ると、Claude が以下を実行する。**実行主体が LLM でもシェルスクリプトでも、満たすべき要件は同じ**なので、再実装時はこの表を契約として使う。

| # | 要件 |
|---|---|
| 1 | 前提チェック: **`jq` が必須**（hook が使う）。無ければ案内して中断する |
| 2 | 設置: SKILL.md → `<config>/skills/long-term-memory/SKILL.md`、hook → `<config>/hooks/ltm-init-reminder.sh`（`chmod +x`）。`<config>` は `CLAUDE_CONFIG_DIR` があればそこ、無ければ `~/.claude` |
| 3 | **内容が同一なら触らず "unchanged"**、違えば `*.bak-<timestamp>` を残して上書き |
| 4 | `settings.json` の `hooks.UserPromptSubmit` に `$HOME/.claude/hooks/ltm-init-reminder.sh` を登録。**既に同じ command があれば何もしない**。他の hook 設定は保持する。壊れた JSON なら勝手に直さず中断 |
| 5 | `CLAUDE.md` の差し替えは 3 モード: マーカーがあれば **replace-markers**、旧形式の見出し `## long-term-memory MCP` があれば **replace-legacy**（次の `## ` まで置換）、どちらも無ければ **append**。他の節は絶対に消さない |
| 6 | バージョンスタンプ `<config>/.ltm-config-version`（`installed_at` / `source` / `config_version` / 各 sha256）。既存があれば `旧 → 新` を報告する |
| 7 | **自己検証**: hook の `bash -n` / 実行権限 / `settings.json` の妥当性と登録が 1 個 / CLAUDE.md のマーカーが各 1 個 / **hook を 3 ターン実際に走らせて発火条件を確認**（雑談で無反応、作業ターンで `search_memories`、リマインドは 1 セッション 1 回だけ） |
| 8 | 最後に「**Claude Code を再起動せよ**」と表示（skill / hook / MCP ツール定義はセッション開始時に読まれるため、起動中のセッションには反映されない）。あわせてロールバック用の `.bak-*` 名を列挙する |

> **かつて `claude-config/install.sh`（bash 実装、264 行）を同梱していたが 2026-08-14 に廃止した。** 同じ設置ロジックをシェルスクリプトとコピペプロンプトで二重管理することになり、`~/.claude` を書き換える処理が 2 経路ある状態は片方だけ更新されるリスクが高かった。再実装時に**インストーラを復活させないこと**。設置ロジックの正本はプロンプト 1 本にする。
>
> 副作用として、冪等性・旧形式移行・`settings.json` 非破壊を実際に走らせて確かめていた 6 本のテストは失われた。現在の担保は「プロンプトが上記要件を書き漏らしていないこと」を検査する `tests/docs/post-mcp-setup.test.ts` の記述アサーションのみで、**実行時の振る舞いは検証されていない**。

### 14.5 埋め込み同期（`scripts/sync-embedded-docs.mjs`）

`docs/post-mcp-setup.md`（リポジトリが手元に無い環境向けのコピペ 1 発手順）が SKILL.md / hook / CLAUDE.md ブロックの全文を抱えている。手で二重管理すると必ずズレる（実際に、かつて README に手で写していた hook が稼働中のものと乖離し、コピペすると `syntax error: unexpected end of file` になる状態を踏んだ）。2026-08-21 に README（日英）は全文埋め込みをやめて docs/ へのリンクに簡素化したため、埋め込み先は `docs/post-mcp-setup.md` の 1 ファイルのみになった。

センチネル形式:

```
<!-- ltm:embed src="claude-config/hooks/ltm-init-reminder.sh" fence="3" lang="bash" -->
```bash
...(生成される内容)...
```
<!-- /ltm:embed -->
```

- 対象ドキュメントは配列で明示列挙（`docs/post-mcp-setup.md` のみ）。センチネルが 0 件なら**エラーで落とす**。
- `fence` はバッククォートの本数。**埋め込む中身自体が ``` を含む場合（SKILL.md）は 4 以上**にする。
- `--check` でズレていたら `exit 1`（テストが使う）。

---

## 15. テスト仕様（受け入れ条件）

`tests/**/*.test.ts` 69 ファイル。**これが実装契約の実行可能版**。各ケース名は「何を保証するか」を述べているので、そのまま Codex への指示に使える。`(§n)` / `(Codex Fn)` はレビュー由来の回帰テスト。

### 15.1 コア

<details>
<summary><b>tests/lib/</b> — paths / slug / markdown / db / datetime / eval</summary>

| ファイル | ケース |
|---|---|
| `paths.test.ts` | `LTM_HOME` から解決 / 未設定なら `~/.long-term-memory` |
| `slug.test.ts` | 不正 project_id / 不正 memory name で throw / 予約 slug 定数の存在 / 予約 slug は通常 slug ではない / `assertProjectId` は予約 slug を通すがゴミは弾く |
| `markdown/frontmatter.test.ts` | ラウンドトリップ / 出力が `---` 始まりで全フィールドを含む / 空 tags・links / 必須欠落で throw |
| `markdown/frontmatter.kg.test.ts` | 空なら entities/triples キーを出さない / ラウンドトリップ / arity 違いの triple を捨てる / 配列でない entities は空扱い |
| `markdown/frontmatter.source-refs.test.ts` | ラウンドトリップ / 空なら省略・読み込み時は `[]` |
| `markdown/frontmatter.supersedes.test.ts` | `supersedes` のラウンドトリップ / 空なら省略・読み込み時は `[]` / 配列でない・非文字列・空文字要素は捨てる / **空文字要素を schema で拒否（strictness）** |
| `markdown/file-io.test.ts` | 親ディレクトリ作成 / 成功時に tmp を残さない / 書いたものを読み戻せる / ハッシュ安定 |
| `db/connection.test.ts` | WAL と foreign_keys が ON / 親ディレクトリ作成 |
| `db/migrate.test.ts` | 全テーブル作成＆冪等 / **stored version 不一致で DROP + 再作成（§22）** / **`REBUILDABLE_TABLES` が `schema.sql` の全テーブル・仮想テーブルを網羅している（schema v5、§6.2）** |
| `db/schema.kg.test.ts` | KG 4 テーブル作成 / `schema_version` が現行版 |
| `datetime.test.ts` | UTC ISO を JST 表示 / `+09:00` 明示オフセット / 深夜の日付繰り上がり / parse 不能なら原文 |
| `eval/metrics.test.ts` | `recallAtK` の計数 / 空 relevant で 0 / `reciprocalRank` は 1/rank |
| `deps.test.ts` | better-sqlite3 in-memory / gray-matter / ulid 26 文字 / zod |

</details>

### 15.2 MemoryService

<details>
<summary><b>tests/lib/memory/</b> — 29 ファイル</summary>

| ファイル | ケース |
|---|---|
| `service.save.test.ts` | markdown 書き込み + DB 行挿入 / 同一プロジェクト内の名前重複を拒否 / 別プロジェクトでは同名可 / 不正 project_id / 不正 memory name |
| `service.read.test.ts` | name で取得 / ULID でも取得 / 無ければ throw / `listByType` の順序 / `searchByTag` any / all / **all は重複タグを dedup（§7）** / `searchFulltext` が本文に当たる / type フィルタ |
| `service.update.test.ts` | description パッチと `updated_at` 更新 / tags を原子的に置換 / links 置換と markdown 反映 / **記憶を読めなくする空 description を拒否（Codex F1）** |
| `service.forget.test.ts` | ファイルと DB 行を削除 / 無ければ throw / **markdown を DB tx より先に消す（失敗時に復活ではなく自己修復）（§4）** |
| `service.rename.test.ts` | ファイル改名 + name 列更新 + 被リンク掃引 / 既存名への rename を拒否 / 元が無ければ throw / **他プロジェクトの同名 inbound link を書き換えない（§1）** / **掃引したファイルの content_hash を更新し reconcile を no-op に（§5）** |
| `service.links.test.ts` | `linkMemories` は追記かつ冪等 / `findRelated` depth 1 / depth 2 / depth 3 上限 / 解決できない dst_name を黙って無視 |
| `service.mutex.test.ts` | 同一プロジェクトの並行 save を直列化 / 別プロジェクトは並行 |
| `service.projects.test.ts` | 記憶を持つ project_id を返す / 空なら `[]` / 予約プロジェクトに `shared: true` |
| `service.reconcile.test.ts` | 外部作成 markdown を取り込む / 編集を検出して更新 / 消えた markdown の行を落とす / `reindex` で完全再構築 / **UNIQUE 違反ファイルをスキップして索引全体を中断しない（§3）** / **1 ファイルの制約違反はそのファイルだけロールバックし既存行を保つ（Codex F2）** / `openDefault` が起動時に自動 reconcile |
| `service.summaries.test.ts` | `listSummaries` が markdown を読まない（§15）/ limit と新しい順 / `searchByTagSummaries` が `searchByTag` と一致 / **tag フィルタを SQL でかける（§16）** |
| `service.body-chars.test.ts` | UTF-16 単位ではなくコードポイントで数える / save で記録し `listSummaries` で返す / 空本文は 0（null ではない）/ body 変更で再計算 / body を含まないパッチでは変えない / rename では変えない / `searchByTagSummaries` でも返す / **reconcile が markdown から backfill する** |
| `service.bm25.test.ts` | ヒット数が多い本文が上位 / **description マッチが本文のみより上位（§10）** / **implicit-AND が 0 件なら OR にフォールバック（§11）** |
| `service.trigram.test.ts` | unicode61 が取りこぼす ASCII 部分文字列に当たる（`sqlite ⊂ better-sqlite3`）/ 日本語の部分文字列に当たる（`パターン ⊂ 削除のパターン`）/ **2 文字 CJK クエリは LIKE にフォールバック** |
| `service.fts-special-chars.test.ts` | ハイフン語 / ドット語で throw しない / 使えるトークンが無ければ空 |
| `service.assoc.test.ts` | キーワード重複ゼロでも同一エンティティ経由で想起 / `query_entities` 無しなら PPR せず素の bm25 / 別名で解決 / **正規名を大文字小文字無視で解決（§13）** / 別名も同様（§13）/ limit を尊重 |
| `service.decay.test.ts` | bm25 経路: 同関連度なら新しい方が上位 / 関連度差が大きければ古い方が上位のまま / `user` は減衰しない / supersede された記憶が近い関連度の隣より降格する（§8.6） |
| `service.decay.ppr.test.ts` | PPR 経路でも同じ順序性が成立 / 使えるシードが無くてもフォールバックで結果を返す / **フィルタ後の集合で正規化しないと type の有無で新旧順が反転する（Codex 指摘の回帰テスト、§8.2）** |
| `service.kg-save.test.ts` | entities/triples を frontmatter と KG に永続化 / **未宣言エンティティを参照する triple で save 全体をロールバック（ファイルも行も残さない）** |
| `service.kg-update.test.ts` | entities/triples を置換し孤立 entity を prune / パッチが省略したら維持 / **KG 型で entities を空にするのを拒否（§6）** / 非 KG 型（reference）では空を許す（§6） |
| `service.kg-forget.test.ts` | その記憶のエッジを落とし専有 entity だけ prune / `kgStats` の memberships |
| `service.kg-graph.test.ts` | `readKgGraph` が memories/entities/memberships/edges/links を返す / 他プロジェクトのノードを漏らさない |
| `service.source-refs.test.ts` | `source_refs` の永続化と読み戻し |
| `service.supersedes.test.ts` | save/update で永続化・逆引きできる / 自己 supersede を無視 / 存在しない name を寛容に無視 / プロジェクトを跨いで漏れない / update で集合を置換 / 循環 supersede でハングしない（推移閉包なし） / superseder を forget すると行が落ちる / reconcile で markdown から再構築 / **rename が index と markdown の両方で追従（§7.7）** / **他プロジェクトの同名 supersede を書き換えない** / **rename が links と supersedes を二重書き込みせず一括で掃く** |
| `kg.test.ts` | entities/aliases/memberships/provenance エッジ作成 / 未宣言 entity 参照で `UnknownEntityError` / 2 記憶で entity を共有し正規名でマージ / `removeMemoryKg` は孤立 entity を prune し共有分は残す / 再適用で置換 / 再適用で落ちた別名を撤回 / 他記憶が主張する別名は残す |
| `reconcile.kg.test.ts` | `reindex` が frontmatter から entities/edges を再構築 / ファイル削除で KG も落ちる |
| `rrf.test.ts` | ランク融合と dedup（最初のリストの要素を残す）/ キー衝突時も前のリストのオブジェクト |
| `rerank.test.ts` | `decayFactor`: 半減期 null は常に 1 / 半減期＝age で 0.5、2倍で 0.25 / 未来日は age 0 にクランプ / parse 不能は 1 / `normalizeRelevance`: 空はそのまま・単一件と全件同スコアは 1 / `rerank`: 同関連度は新しい方が先 / **関連度差が `RECENCY_WEIGHT` を超えるペアは順序不変（上限保証の固定）** / `user` は 1 年後も減衰しない / supersede は近い peer より降格しつつ結果に残る / 境界値（`RECENCY_WEIGHT` / `SUPERSEDED_PENALTY` ちょうど）での順序 / spec が定めた定数値そのものの固定 |
| `types.kg.test.ts` | entities/triples の既定 `[]` / aliases 付き entity と triple tuple の parse / 空 name の entity を拒否 / 空文字 alias を拒否 / 空要素 triple を拒否 |
| `singleton.test.ts` | 同一インスタンスを返す / `resetMemoryService` が close して clear |

</details>

### 15.3 グラフ

<details>
<summary><b>tests/lib/graph/</b></summary>

| ファイル | ケース |
|---|---|
| `ppr.test.ts` | シード側ノードが遠いノードより上位 / シードの非対称性 / スコア合計 ≈ 1 / シード無しで空 Map / 孤立シード / グラフに無いシードを無視 |
| `assoc.test.ts` | memories + entities + 手動リンクの対称グラフ / 手動リンクの重みが triple より大 / membership=1 / triple=1 / manualLink=2 かつ自己ループを除外 / シード無しで `rankMemoriesByPpr` は `[]` |
| `build-kg-graph.test.ts` | memory / entity ノードに kind と `ent:` プレフィックス / membership・triple・link 辺に kind/weight/label / 解決できない link を捨てる |
| `kg-view.test.ts` | 全 ON かつタグ無しで全件 / memories-only プリセット / entity を隠すと入射辺も落ちる / タグフィルタは memory のみに作用 / `kgNeighbors` |

</details>

### 15.4 MCP

<details>
<summary><b>tests/lib/mcp/</b> — 17 ファイル</summary>

| ファイル | ケース |
|---|---|
| `sdk-import.test.ts` | `McpServer` が export されている |
| `server.test.ts` | **connect 後にツールが 16 個** |
| `schemas.test.ts` | 14 スキーマの必須フィールド検証（一覧は §9.1 と対応） |
| `schemas.kg.test.ts` | entities/triples 受理 / `query_entities` 受理 / `aliases` の既定 `[]` / **entities 欠落を拒否** / **空配列を拒否** / triples 無しは可 |
| `context.test.ts` | URL クエリから project_id / 欠落を拒否 / 不正 slug を拒否 |
| `context.maintenance-token.test.ts` | ヘッダから読む / 無ければ null / **URL の `?maintenance_token=` を無視** / ヘッダ名は大文字小文字無視 |
| `auth.test.ts` | env 未設定なら false（安全側）/ 欠落・不一致で false / 完全一致のみ true |
| `session.test.ts` | **並行初回リクエストが 1 セッションを共有（二重生成なし）（§8）** / 2 回目以降はキャッシュ |
| `transport.test.ts` | project_id 欠落で 400 / 不正 slug で 400 / 非 POST で 405 / `initialize` に応答 / `tools/list` に応答 / **タイムアウトで throw せず JSON-RPC エラー（HTTP 200）（§8）** |
| `compose.test.ts` | why/how_to_apply セクションを出す / 既に構造化済みなら冪等 |
| `tools.write.test.ts` | 各 `remember_*` の型と本文合成 / `url` を本文末尾に追記 / `update_memory` / `forget_memory` / `link_memories` |
| `tools.write.kg.test.ts` | `saveAsync` が entities/triples を保存 / `updateAsync` がパッチから引き回す |
| `tools.read.test.ts` | 各読み取りツールの基本 / **limit 省略時は 100 件上限（Codex F5）** / index が `body_chars` を返す / 検索ヒットも `body_chars` を持つ / `find_related` のノードも持つ |
| `tools.read.kg.test.ts` | `query_entities` 指定時に連想想起される |
| `tools.meta.test.ts` | `list_projects` / `reindex` |
| `tools.descriptions.test.ts` | **全 16 ツールが非空 description を持つ** / **入れ子を含む全ての名前付き入力フィールドが非空 description を持つ**（JSON Schema を再帰走査。`patch.*` と `entities[].name` / `source_refs[].project_id` のような配列要素の named field まで見る。無名の位置（array items / tuple スロット / union の各枝）自体は通過するだけで要求しない）/ **配信スキーマが走査可能な構文だけで出来ていること**（スキーマを内包し得るのに辿っていないキーワード — 参照系 `$ref` / `$recursiveRef` / `$dynamicRef`、分岐系 `if` / `then` / `else` / `not`、キー系 `patternProperties` / `propertyNames`、要素・依存系 `additionalItems` / `dependencies` / `contains` / `dependentSchemas` / `unevaluatedProperties` / `unevaluatedItems` — が現れたら、その時点で検査範囲が黙って狭まるので落とす）/ 走査関数 `fieldDescriptions` と `unwalkableKeywords` 自体の synthetic JSON Schema 単体テスト（`items` / `prefixItems` / draft-07 tuple / `anyOf`・`oneOf`・`allOf` / record 値の `additionalProperties` の各経路）/ 非自明な必須引数（`why` / `how_to_apply` / `entities`）が JSON Schema の `required` と description 本文の両方に現れる / `forget_memory` が「永続削除・要確認」を告げる / `update_memory` が `**Why:**` / `**How to apply:**` の手書きを指示する / `remember_project_fact` の description が完了報告を `remember_session_summary` へ誘導する / `remember_user_fact` / `remember_feedback` / `remember_project_fact` の description が `` `supersedes` `` に触れる |
| `tools.supersedes.test.ts` | 5 つの `remember_*` 全てと `update_memory` の patch で `supersedes` を受理・永続化 / `search_memories` / `get_memory` / `list_memories_by_type` / `search_by_tag` / `get_memory_index` の全 5 ツールで置き換えられた側だけに `superseded_by` が付く / caller と shared のスコープを取り違えると同名衝突で誤ったスコープに印が付くことを固定するテスト |

</details>

### 15.5 共有スコープ

<details>
<summary><b>shared 関連</b></summary>

| ファイル | ケース |
|---|---|
| `tools.read.shared.test.ts` | 既定で共有をマージし scope ラベル付き / `include_shared:false` でプロジェクトのみ / `list_memories_by_type` が共有を追記 / `get_memory_index` に共有が入る / `search_by_tag` の opt-out / **共有結果が `SHARED_INDEX_CAP` で打ち切られる** / `get_memory` が共有へフォールバックし scope を付ける / **同名衝突では project を優先** / `find_related` が共有の開始ノードを解決 |
| `tools.write.shared.test.ts` | トークン無しで `__shared__` への `remember_feedback` を拒否 / `canWriteShared` なら許可 / 通常プロジェクトは常に許可 / `source_refs` を透過 |
| `app/api.memories.shared.test.ts` | `PUT` / `DELETE` が `__shared__` で 403 |

</details>

### 15.6 REST API / docs

<details>
<summary><b>tests/app/ と tests/docs/</b></summary>

| ファイル | ケース |
|---|---|
| `api.memories.test.ts` | PUT で更新 / **不正パッチで 400 かつ記憶を壊さない（§2）** / project_id 欠落で 400 / DELETE で削除 / 無ければ 404 |
| `api.projects.test.ts` | 空リスト / カウント付きリスト |
| `docs/post-mcp-setup.test.ts` | 埋め込みが正本と同期 / 新環境に必要な 3 資産を埋め込んでいる / フェンスがネストしてコピペが壊れない / Claude Code の再起動を促している / 埋め込み先が `docs/post-mcp-setup.md` のみになっている（README 簡素化後、2026-08-21） / **`install.sh` の 6 ケース**（空 config への設置＋自己検証 / 冪等・二重登録しない / ドリフト置換＋バックアップ / 旧 CLAUDE.md 節の移行で隣接節を壊さない / DRY_RUN で何も書かない / 無関係な既存 hook 登録を残す） |

</details>

---

## 16. 実装順序とフェーズゲート

```mermaid
flowchart TD
    P0["フェーズ 0: 足場<br/>Next.js + TS + Vitest + deps"] --> P1["フェーズ 1: コア<br/>paths/slug/markdown/db/mutex/service"]
    P1 --> P2["フェーズ 2: MCP<br/>schemas/server/session/transport/tools"]
    P2 --> P3["フェーズ 3: REST + UI"]
    P3 --> P4["フェーズ 4: グラフ可視化"]
    P1 --> P5["フェーズ 5: KG + 連想検索<br/>kg.ts/assoc/ppr"]
    P5 --> P2
    P2 --> P6["フェーズ 6: 共有スコープ<br/>auth/マージ/RRF"]
    P6 --> P7["フェーズ 7: 検索精度<br/>trigram/bm25 重み/LIKE fallback"]
    P7 --> P8["フェーズ 8: 読み取り経路の能動化<br/>body_chars/skill/hook/CLAUDE.md"]
    P8 --> P9["フェーズ 9: 配布<br/>Docker/compose/start-mcp"]
    P9 --> P10["フェーズ 10: curator<br/>SKILL/wrapper/launchd"]
    P10 --> P11["フェーズ 11: 時間減衰 + supersession<br/>rerank.ts / supersedes テーブル（schema v5）"]
    P2 --> PA["Vercel 公開オーバーレイ<br/>Clerk / PAT / membership / CSRF"]
    PA --> P3
    PA --> P6
```

| フェーズ | 作るもの | ゲート（これが通ったら次へ） |
|---|---|---|
| 0 | `create-next-app` 相当 + §2.3 の設定ファイル + `tests/smoke.test.ts` / `deps.test.ts` | `pnpm test` が緑、`pnpm build` が通る（`serverExternalPackages` 未設定だとここで落ちる） |
| 1 | §5–§7（KG 抜き） | `tests/lib/{paths,slug,markdown,db,datetime}` と `service.{save,read,update,forget,rename,links,mutex,projects,reconcile,summaries}` |
| 2 | §9（KG 抜きでも可） | `tests/lib/mcp/*`（`server.test.ts` のツール数は KG 込みで 16） |
| 3 | §11 | `tests/app/api.*` |
| 4 | §12 | `tests/lib/graph/{build-kg-graph,kg-view}` |
| 5 | §7.5 + §8.2–8.4 | `kg.test.ts` / `reconcile.kg.test.ts` / `service.kg-*` / `graph/{ppr,assoc}` / `service.assoc` |
| 6 | §10 | `tools.{read,write}.shared` / `auth` / `rrf` / `api.memories.shared` |
| 7 | §8.1 の trigram / bm25 重み / フォールバック（`CURRENT_VERSION` を上げる） | `service.{bm25,trigram,fts-special-chars}` / `migrate.test.ts` の再構築ケース |
| 8 | `body_chars`（`CURRENT_VERSION` を上げる）+ §14 | `service.body-chars` / `tools.read`（body_chars 系）/ `docs/post-mcp-setup.test.ts` |
| 9 | §13.1–13.3 | `docker compose up -d` 後に `curl -X POST 'localhost:3939/api/mcp?project_id=x' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` が 16 ツールを返す |
| 10 | §13.4–13.5 | `DRY_RUN=1 scripts/curator/run-curation.sh` が `CURATION SUMMARY (DRY_RUN=1)` を出して成功スタンプを更新**しない**こと、launchd 登録後に手動 `launchctl kickstart` で完走 |
| 11 | §5.1（`supersedes` フィールド）+ §6（`supersedes` テーブル、`CURRENT_VERSION = 5`）+ §8.2/§8.6（`rerank.ts` を両検索経路に配線） | `rerank.test.ts` / `service.decay.test.ts` / `service.decay.ppr.test.ts` / `service.supersedes.test.ts` / `frontmatter.supersedes.test.ts` / `tools.supersedes.test.ts` / `migrate.test.ts` の `REBUILDABLE_TABLES` 突き合わせ |
| Vercel | §19 の Clerk / PAT / project membership / CSRF / CORS / rate limit | `tests/lib/auth/*` / `tests/app/auth.routes.test.ts` / preview E2E の認証付き MCP smoke |

> フェーズ 7 / 8 / 11 で `CURRENT_VERSION` を上げる理由: trigram 化・`contentless_delete`・`body_chars` 列・`supersedes` テーブルはいずれも `CREATE ... IF NOT EXISTS` では既存 DB に反映されない。**再構築 migration（§6.2）が入っていることが前提**なので、フェーズ 1 の時点で `migrate.ts` はこの形にしておく。

---

## 17. 再現時に必ず踏む落とし穴チェックリスト

| # | 罠 | 対処 |
|---|---|---|
| 1 | **Next.js + better-sqlite3 で build 失敗** | `next.config.ts` に `serverExternalPackages: ['better-sqlite3']`（Next 15 以前は `experimental.serverComponentsExternalPackages`） |
| 2 | **FTS5 contentless の削除** | schema v3 以降は `contentless_delete=1` なので `DELETE FROM memories_fts WHERE rowid = ?`。旧値を渡す `INSERT ... VALUES('delete', ...)` パターンは使わない。全消しは `INSERT INTO memories_fts(memories_fts) VALUES('delete-all')` |
| 3 | **FTS5 に生クエリを渡すとクラッシュ** | ハイフン / ドット / コロンが演算子扱いされる。トークン分割して各トークンを `"..."` で囲む |
| 4 | **gray-matter が ISO 文字列を Date にする** | parse 時に `toISOString()` で戻す |
| 5 | **YAML 1.1 の boolean alias** | `y` / `n` / `yes` / `no` / `on` / `off` は boolean 扱いで gray-matter がクォートする。テストの正規表現は quoted 形も許容する |
| 6 | **unicode61 は日本語をトークン化できない** | 漢字・かなの連なりを 1 トークンにするので部分一致しない。`tokenize='trigram'` にする。代償として **MATCH は 3 文字以上のトークンのみ**有効 → 3 文字未満は LIKE フォールバック |
| 7 | **MCP SDK は 1 transport のみ** | `Server.connect()` の 2 度目は "Already connected"。project_id（+ 権限）単位で**Promise を**キャッシュ |
| 8 | **MCP クライアントは tools/list をキャッシュする** | サーバを再デプロイしてもツールスキーマ・description は稼働中セッションに届かない。**Claude Code の再接続（再起動）が必要**。「直したのに直らない」の第一容疑者 |
| 9 | **schema migration は起動時ではなく最初のリクエスト時** | `getMemoryService()` が遅延初期化。コンテナ起動直後に版が上がっていなくても異常ではない |
| 10 | **`pkill -f "next dev"` 禁止** | 他プロジェクトの dev server やユーザの MCP サーバまで落ちる。kill は PID 名指し。同一プロジェクトから `pnpm dev` を二重起動しない |
| 11 | **`:3939` は dev server ではなく Docker コンテナのことがある** | その場合ソース変更は `docker compose build && up -d` しないと反映されない |
| 12 | **macOS TCC: launchd は `~/Documents` を読めない** | 終了コード 126 / `Operation not permitted`。手動実行は成功するので導入検証をすり抜ける。実行資産とストアを `~/Documents` 外（例 `~/.local/share/ltm-store`）へ出す |
| 13 | **`claude -p` の `--allowedTools` は追加式（排他でない）** | 書き込み権限を確実に絞るには `--tools`（排他的 built-in 集合）+ `--setting-sources` + `--disallowedTools` + `--strict-mcp-config` + cwd 限定を併用 |
| 14 | **headless agent の cwd は暗黙の Read ルート** | そこに置かれた `CLAUDE.md` / `AGENTS.md` が処理対象データより強い制御コンテキストとして読まれる（`--setting-sources` では防げない）。cwd は入力ディレクトリではなくストアに限定する |
| 15 | **`compose` 短縮構文の bind mount は source を黙って作る** | long syntax + `create_host_path: false`。代わりに初回は自分で `mkdir` |
| 16 | **`schema.sql` は `.next` に入らない** | Docker runner へ明示コピー |
| 17 | **hook の失敗は画面に出ない** | heredoc をコマンド置換に入れない（アポストロフィ 1 個で構文エラー）。`bash -n` を install 時に必ず走らせる |
| 18 | **バイリンガル README は片方だけ更新しない** | `README.md`（JA・主）と `README.en.md`（EN・従）を相互リンクして同時に更新する |
| 19 | **`normalizeRelevance` の母集団は type/tags フィルタ後で揃える（§8.2, §8.6）** | フィルタ前の母集団で正規化してから絞ると、同じ絞り込みクエリが bm25/PPR のどちらの経路を通ったかで違う順序を返す。両経路とも「SQL で先に絞る → 残った集合で正規化 → rerank → `limit` で slice」の順に統一する |
| 20 | **`rename()` の markdown 掃除はトランザクション外（§8.6 のスコープ外の既知の限界）** | DB トランザクションで `memories`/`links`/`supersedes`/FTS を更新した後、参照元 markdown を 1 件ずつトランザクション外で書き換える。掃除ループが途中で失敗すると markdown が正本のため次の `reconcile()` が古い名前を DB に書き戻し、rename 後の supersede 降格が失われる。発生条件は掃除ループ中の I/O 失敗で実運用での確率は低く、再設計（全書き換えのステージング + ロールバック）はスコープ外 |

---

## 18. 既知のドリフトと非目標

### 18.1 既存ドキュメントとの差（本書が正）

[docs/architecture.md](architecture.md) には schema v2 相当の古い記述が残っていたが、**2026-08-07 に解消済み**。下表は当時のドリフト内容の記録（同種のズレが再発したときの照合用）。

| かつての architecture.md の記述 | 現行（本書 / 修正後の architecture.md） |
|---|---|
| 「`schema_version` は現行 = 2」「`migrate.ts` は `CREATE TABLE IF NOT EXISTS` の前方互換方式」 | **`CURRENT_VERSION = 5`、再構築 migration**（§6.2） |
| 「contentless FTS5 は DELETE 不可で `INSERT … VALUES('delete', …)` パターン」 | **`contentless_delete=1` により `DELETE ... WHERE rowid = ?`**（§17-2） |
| 「`toFtsMatchQuery` でクエリを正規化」 | 関数名は現行 `ftsTokens` / `ftsPhrases`。**trigram の 3 文字閾値と LIKE フォールバックが追加**（§8.1） |
| `memories` テーブルの列挙に `body_chars` が無い | **`body_chars` 列あり**（schema v4、§5.1） |
| 「16 ツール定義（`tools.ts`）」 | ツールは `tools/{read,write,meta,compose,util}.ts` に分割 |
| 共有スコープ（`__shared__`）の記述が無い | 読み取りマージ・RRF・cap・書き込みトークンを記載（§10） |
| 検索ランキングに時間軸が無い（`updated_at` は `likeFallback` にしか現れない） | schema v5 で `rerank.ts` の時間減衰 + supersede 降格が bm25/PPR 両経路に配線済み（§8.2, §8.6） |

役割分担は変わらない。**architecture.md は「なぜそうなっているか」の地図、本書は実装契約の正本**で、差異があれば本書を採る。

`docs/mcp-setup.md` のポート説明は現行と一致している。ツール一覧は 2026-08-21 の README 簡素化で `docs/overview.md` 側に移設した（mcp-setup.md はセットアップ手順のみに専念する）。

### 18.2 非目標（作らないもの）

- localhost での匿名アクセスは開発用途として許可する。Vercel 公開時の認証・認可は非目標ではなく、§19 の Clerk / PAT / project membership 契約に従って実装する。`0.0.0.0` で待受するローカル運用では LAN 内から到達できるため、本番公開と同じ認証境界として扱わない。
- soft delete / ゴミ箱 / 履歴。削除は完全削除。
- 埋め込みベクトル検索・LLM 呼び出し。**サーバは LLM も埋め込みも持たない**（エンティティ抽出はクライアント側の責務）。
- 同一 memory の意味的な同時編集の競合解決（ロックは書き込みの同時実行を防ぐが、2 人の本文差分を自動マージしない。local は `KeyedMutex`、Vercel は §7.4 の lease lock を使う）。
- Inbox ingest（Slack / MTG 生ログの取り込み）は設計のみ存在し**未実装**（`docs/superpowers/specs/2026-07-25-inbox-ingest-design.md`）。
- 時間減衰・supersession（§8.6）のスコープ外: Ebbinghaus 忘却曲線 / bi-temporal validity / `as_of=t` の時点指定クエリ / 推移的 supersede の閉包 / `__shared__` 跨ぎの supersede / 自動 supersede 検出（重複検知） / KgGraph への supersede エッジ追加 / PPR・KG 経路そのものの改善（実運用で `query_entities` 付き呼び出しは 1 割程度しかなく、先に踏ませる設計が要るため別 spec 送り）。

### 18.3 参考リンク（元リポジトリ内）

| 目的 | ファイル |
|---|---|
| 設計仕様の原文 | `docs/superpowers/specs/2026-05-20-long-term-memory-mcp-design.md` |
| フェーズ別作業ログ | `docs/superpowers/plans/2026-05-20-phase{1..4}-*.md` |
| 連想検索の設計と評価 | `docs/superpowers/plans/2026-06-01-hipporag-associative-recall.md` / `docs/eval/` |
| 共有スコープ設計 | `docs/superpowers/specs/2026-07-24-shared-memory-scope-design.md` |
| 読み取り経路の能動化（実測と対策） | `docs/superpowers/specs/2026-07-28-memory-read-path-activation.md` |
| フルソースレビュー結果（§n 番号の出典） | `docs/reviews/2026-07-23-full-source-review.md` |
| curator 運用 | `docs/shared-memory-curator.md` |
| クライアント資産の一括設置 | `docs/post-mcp-setup.md` |
| 時間減衰 + supersession の設計と検討過程（§8.6） | `docs/superpowers/specs/2026-08-13-memory-time-decay-supersession-design.md` |

## 19. Vercel 公開時の認証・認可

Vercel ではアプリがインターネット上に公開されるため、§1.2 の localhost 前提をそのまま適用してはならない。本節は Vercel 実行時の追加契約であり、既存の 16 ツール、Markdown 正本、共有スコープ、検索仕様を変更しない。

### 19.1 認証方式

- **ブラウザ**: Vercel Marketplace で Clerk を接続し、`@clerk/nextjs` v7 の `clerkMiddleware()`、`ClerkProvider`、`/sign-in`、`/sign-up` を使う。`src/proxy.ts` で UI と `/api/**` を保護し、`auth()` は必ず `await` する。
- **MCP / CLI**: Clerk の短命なセッション cookie を MCP の長寿命設定へ流用しない。ログイン済みユーザーが `/settings/tokens` で PAT を発行し、Claude Code は `Authorization: Bearer ltm_<random>` を送る。PAT の平文は発行レスポンスで一度だけ表示し、サーバは SHA-256 ハッシュ、prefix、owner user id、作成日時、最終利用日時、期限、失効日時だけを `mcp_tokens` に保存する。
- `requireMcpPrincipal(req)` は `Bearer` scheme、prefix、期限、失効状態を検証し、無効 token は常に `401` を返す。token 値をエラーメッセージ、URL、アクセスログ、テレメトリの引数へ書かない。
- ローカルの `AUTH_REQUIRED=0` では従来どおり匿名を許可する。ただし `AUTH_REQUIRED=1` または `VERCEL=1` では、環境変数が未設定なら起動後の全リクエストを安全側で `503` とし、認証無しで公開しない。

### 19.2 認証データと project membership

memory の `index.db` は Markdown から再構築できる索引であり、認証情報を入れてはならない。local では `auth.db`、Vercel では `TURSO_AUTH_DATABASE_URL` / `TURSO_AUTH_DATABASE_TOKEN` の別 DB に次のテーブルを作る。

- `auth_schema_version`
- `projects(project_id PRIMARY KEY, owner_user_id, created_at, updated_at)`
- `project_members(project_id, user_id, role CHECK(role IN ('owner','member')), PRIMARY KEY(project_id,user_id))`
- `mcp_tokens(id PRIMARY KEY, user_id, token_hash UNIQUE, token_prefix, label, created_at, last_used_at, expires_at, revoked_at)`

`project_id` は引き続き URL query の値で、認証 token の引数や memory 本文へ複製しない。`POST /api/projects` が slug を作成したユーザーを owner として登録し、owner だけが member の追加・削除を行う。`list_projects`、横断検索、UI の project 一覧は principal が member である project だけを返す。既存の未所有 project は `LTM_BOOTSTRAP_OWNER_USER_ID` を一度だけ指定した移行処理で owner を割り当て、割り当てがない project は誰にも公開しない。

認可判定は MCP/REST/UI の各入口で service 呼び出しより先に行う。

```ts
export type ProjectAction = 'read' | 'write' | 'maintain';
export async function assertProjectAccess(
  principal: { userId: string },
  projectId: string,
  action: ProjectAction,
): Promise<void>;
```

`read` は owner/member、`write` は owner/member（`__shared__` を除く）、`maintain` は `projectId === '__shared__'` かつ user id が `LTM_CURATOR_USER_ID` である場合だけを候補とする。存在しない project を読み取りで自動作成してはならない。

### 19.3 エンドポイント別の認証契約

| 経路 | 未認証 | 認証済みだが権限不足 | 成功条件 |
|---|---:|---:|---|
| UI `/`, `/search`, `/p/*`, `/dashboard` | `/sign-in` へリダイレクト | `403` ページ | Clerk session + membership |
| `GET /api/projects` | `401` | — | Clerk session、アクセス可能 project だけ返す |
| `POST /api/projects` | `401` | slug owner 競合は `409` | Clerk session |
| `PUT/DELETE /api/memories/*` | `401` | `403` | Clerk session + project member、`__shared__` は常に `403` |
| `POST /api/mcp?project_id=<slug>` | `401` | `403` | Bearer PAT + project membership |
| `POST /api/mcp?project_id=__shared__` 読み取り | `401` | — | Bearer PAT + 有効な user |
| 同 shared の書き込み | `401` | `403` | Bearer PAT + `LTM_CURATOR_USER_ID` 一致 + `X-LTM-Maintenance-Token` 完全一致 |

MCP の `OPTIONS` は `MCP_ALLOWED_ORIGINS` に含まれる origin のみ `204` を返し、`Access-Control-Allow-Headers` は `Authorization, Content-Type, X-LTM-Maintenance-Token, Mcp-Session-Id` に限定する。allowlist 外や wildcard `*` は `401/403` とし、認証必須環境で無制限 CORS を設定しない。

### 19.4 Web セキュリティ

- `PUT`、`DELETE`、`POST /api/projects`、PAT の発行・失効は `Origin` と `Host` の same-origin を検証し、失敗は `403`。Clerk の SameSite cookie と合わせて CSRF を防ぐ。
- Upstash Redis の user/token/IP 単位 rate limit を MCP/API の失敗系へ適用する。rate limit key に token 平文を使わず、token id または hash prefix を使う。
- `next.config.ts` で HSTS（production）、`Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`frame-ancestors 'none'` を設定する。UI に PAT 平文を server log や client telemetry へ送らない。
- `mcp_tokens` の PAT は UI から明示的に revoke でき、期限を過ぎた token は直ちに拒否する。漏洩時は Clerk session の revoke とは別に PAT revoke と `LTM_MAINTENANCE_TOKEN` のローテーションを行う。

### 19.5 curator と運用

本番 curator は GitHub Actions または管理端末で動かし、短命 runner secret に PAT と maintenance token を渡す。Vercel Function に Claude CLI、`.env`、ローカル Markdown ストアを配置しない。`docs/mcp-config.vercel.json` の token は環境変数参照だけにし、設定ファイルへ平文を書き込まない。curator の PAT は専用 user に発行し、`LTM_CURATOR_USER_ID` と一致させる。`DRY_RUN=1` では書き込み PAT を渡さず、共有へ変更を送信しない。

### 19.6 受け入れテスト

`tests/lib/auth/*` と `tests/app/auth.routes.test.ts` で次を固定する: Clerk 未認証の redirect/401、member 外 project の 403、PAT の一度だけ表示・hash-only 保存・期限切れ・失効、同一 token の再利用、CSRF/CORS、rate limit、shared read/write の二重ゲート、token がログ・テレメトリ・URL に現れないこと。preview の E2E ではサインイン → PAT 発行 → MCP initialize/tools/list → save/search/get → revoke → 401 を通す。
