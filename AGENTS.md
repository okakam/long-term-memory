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

- タスク 0 の Next.js 足場、storage 契約、FTS5 probe を実装した。2026-09-05 に Turso リモート互換性ゲート（FTS5 trigram、weighted bm25、contentless delete）へ合格した。
- タスク 1 の Markdown 正本データモデル、frontmatter の serialize/parse、ローカル filesystem / Vercel Blob adapter を実装し、対象 45 テストを通過した。
- タスク 2 の schema v5、再構築 migration、WAL/FK 付きローカル SQLite adapter、遅延初期化 Turso/libSQL adapter を実装し、全 57 テスト・lint・型検査・production build を通過した。リモート probe の合格記録はタスク 0 に基づく。
- pnpm は `packageManager` の 11.1.3 を使用する。仕様の依存範囲を維持し、解決済みバージョンは `pnpm-lock.yaml` に固定する。
- ホストが `NODE_ENV=development` を設定している場合、本番ビルド検証は `NODE_ENV=production pnpm build` で実行する。
- `pnpm tsx scripts/probe-turso.ts` はリモート Turso URL を必須とする。ローカル libSQL のテスト成功をリモートゲート合格として扱わない。
