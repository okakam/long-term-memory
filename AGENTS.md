# 開発エージェント向けガイド

## 基本方針

- このリポジトリの仕様書・計画書・運用ドキュメントは日本語で記述する。
- 実装前に `docs/reproduction-spec.md` と、対象タスクに対応する `docs/superpowers/plans/` の計画を確認する。
- 仕様、構成、開発手順、運用ルールに変更があった場合は、関連するドキュメントとこの `AGENTS.md` を随時更新する。特に、このファイル自体も開発の進行に合わせて随時更新すること。
- 認証情報、API キー、実在する `.env` ファイルはコミットしない。
- `.gitignore` で依存関係、生成物、ローカル記憶データ、認証を含むローカル設定を除外する。`.env.example` と `pnpm-lock.yaml` はバージョン管理する。

## ブランチ運用

- Git Flow を使用する。
- `main` は本番、`develop` は開発の統合ブランチとする。
- 機能開発は `feature/*`、バグ修正は `bugfix/*`、リリース準備は `release/*`、緊急修正は `hotfix/*` を使う。
- `main` と `develop` への変更は Pull Request 経由で行い、直接 push しない。
- コミットは変更の目的が分かる日本語または Conventional Commits 形式で、小さく分ける。

## 開発環境

- 開発コンテナは `.devcontainer/` の `Dockerfile` と `compose.yaml` を正本とする。
- コンテナには Node.js 22、pnpm、OpenAI Codex CLI、Turso CLI、Git、Git Flow、GitHub CLI（`gh`）、`jq`、`xz-utils` を用意する。
- VS Code 拡張機能 `openai.chatgpt` は `.devcontainer/devcontainer.json` の `customizations.vscode.extensions` で導入する。
- Codex の設定・認証状態は `CODEX_HOME=/home/node/.codex` に保存し、`long-term-memory-codex` volume で永続化する。
- 依存関係は `long-term-memory-node_modules` volume に保存する。ローカル開発では `AUTH_REQUIRED=0` を使い、本番の認証設定と混同しない。
- Codex と GitHub CLI の認証はコンテナ内で対話的に行い、Dockerfile や Compose ファイルには秘密情報を記載しない。

## 変更時の確認

- YAML/JSON の構文を検証し、`docker compose -f .devcontainer/compose.yaml config --quiet` を実行する。
- 開発コンテナをビルドし、`node`、`pnpm`、`codex`、`turso`、`gh`、`jq` のバージョンと volume の書き込み可否を確認する。
- 変更前後に `git diff --check` を実行する。
- 完了を報告する前に、変更内容に応じたテストまたはビルドを実行し、結果を記録する。

## 現在の実装と検証

- タスク 0 の Next.js 足場、storage 契約、FTS5 probe を実装した。
- タスク 8 の Vercel/Clerk env、security headers、固定CLI CI、migration preflight、Vercel smoke、Docker配布、start-mcp安全起動、Blob prefix分離を実装し、Vercel Upstash連携の `KV_REST_API_*` env 名にも対応した。62 suite・153 tests、lint・型検査・production build を通過した。Docker CLIとMCP認証付き実Vercel preview smokeは未実行。2026-09-06 に Vercel CLI preview deploy/inspect が Ready まで成功した。
- Vercel 実行時の memory service 配線を追加し、`LTM_STORAGE_DRIVER=vercel` では Turso/libSQL index と private Blob Markdown を使うようにした。MCP/UI の読み取りを非同期経路へ切り替え、Blob→Turso transaction の save/update/delete、Blob からの project scoped remote reindex、remote PPR、削除 tombstone、prefix/hash検証、remote rename、Vercel Redis lock、owner/curator maintenance認可を実装した。65 suite・170 tests、lint・型検査・production build・`git diff --check` を通過。2026-09-06 の Preview deployment `dpl_BGxZ5tEeoqG7rV1jG6rAfGcbCtoT` は Ready、固定 alias を更新し、公開 sign-in は 200、未認証 MCP は想定どおり 401。PAT 付き E2E smoke と Clerk セッション付き UI smoke は未実行。
- タスク 9 の Claude Code skill/hook/CLAUDE.md、curator local/remote wrapper、remote snapshot、Vercel外部スケジュール、launchd、埋め込み同期を実装し、64 suite・160 tests、lint・型検査・production build、hook 3-turn check を通過した。2026-09-06 に Vercel preview deploy/inspect が Ready まで成功した。MCP認証付きremote curator実行はsecret未提供のため未実行。2026-09-05 に Turso リモート互換性ゲート（FTS5 trigram、weighted bm25、contentless delete）へ合格した。
- タスク 1 の Markdown 正本データモデル、frontmatter の serialize/parse、ローカル filesystem / Vercel Blob adapter を実装し、対象 45 テストを通過した。
- タスク 2 の schema v6、再構築 migration、WAL/FK 付きローカル SQLite adapter、遅延初期化 Turso/libSQL adapter を実装し、全 57 テスト・lint・型検査・production build を通過した。リモート probe の合格記録はタスク 0 に基づく。
- タスク 3 の MemoryService、KG、reconcile、project lock、atomic failure 復旧を実装し、非同期書き込みを local mutex / Redis lease に接続した。
- タスク 4 の FTS5/LIKE 検索、PPR 連想検索、RRF、時間減衰、supersession、評価メトリクスを実装し、34 suite・91 tests、lint、型検査、production build を通過した。
- タスク 5 の MCP 16 ツール、入力 schema/description、local-session、Vercel stateless transport、route guard を実装し、42 suite・109 tests、lint、型検査、production build を通過した。
- タスク 5-A の分離 auth DB、Clerk middleware、hash-only PAT、membership 認可、CSRF/CORS、MCP auth gate を実装し、関連 auth/MCP/API テスト、lint、型検査、production build を通過した。
- タスク 6 の共有スコープ回帰テスト、local telemetry.db / Vercel 用分離 Turso adapter、initialize/tool-call 計測、JST 集計、R1/R4/R6 ダッシュボードを実装し、56 suite・133 tests、lint、型検査、production build を通過した。
- タスク 7 の REST memory API、プロジェクト横断検索・一覧・詳細・編集UI、shared read-only表示、React Flow/d3-force KGグラフを実装し、対象テスト・全テスト・lint・型検査・production build を通過した。
- pnpm は `packageManager` の 11.1.3 を使用する。仕様の依存範囲を維持し、解決済みバージョンは `pnpm-lock.yaml` に固定する。
- ホストが `NODE_ENV=development` を設定している場合、本番ビルド検証は `NODE_ENV=production pnpm build` で実行する。
- `pnpm tsx scripts/probe-turso.ts` はリモート Turso URL を必須とする。ローカル libSQL のテスト成功をリモートゲート合格として扱わない。
