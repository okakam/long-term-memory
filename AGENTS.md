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
- コンテナには Node.js 22、pnpm、OpenAI Codex CLI、Git、Git Flow、GitHub CLI（`gh`）、`jq`、`xz-utils` を用意する。Turso CLIは使用しない。
- VS Code 拡張機能 `openai.chatgpt` は `.devcontainer/devcontainer.json` の `customizations.vscode.extensions` で導入する。
- Codex の設定・認証状態は `CODEX_HOME=/home/node/.codex` に保存し、`long-term-memory-codex` volume で永続化する。
- `/workspace/.codex/config.toml` で Codex CLI の TUI フッターにコンテキスト残量、5時間制限、長期使用制限を表示する。
- 依存関係は `long-term-memory-node_modules` volume に保存する。ローカル開発では `AUTH_REQUIRED=0` を使い、本番の認証設定と混同しない。
- Codex と GitHub CLI の認証はコンテナ内で対話的に行い、Dockerfile や Compose ファイルには秘密情報を記載しない。

## 変更時の確認

- YAML/JSON の構文を検証し、`docker compose -f .devcontainer/compose.yaml config --quiet` を実行する。
- 開発コンテナをビルドし、`node`、`pnpm`、`codex`、`turso`、`gh`、`jq` のバージョンと volume の書き込み可否を確認する。
- 変更前後に `git diff --check` を実行する。
- 完了を報告する前に、変更内容に応じたテストまたはビルドを実行し、結果を記録する。

- Cloud Run/Firebase/GCS/Firestore構成の設計・実装計画は `docs/superpowers/specs/2026-09-19-cloud-run-firebase-gcs-firestore-design.md` と `docs/superpowers/plans/2026-09-20-cloud-run-gcs-storage.md` を正本とする。
- Cloud Run用GCS Markdown adapter、Firestore metadata/auth store、`/tmp` SQLite cache、Firebase ID token/session cookie、API認可、Invoker公開・アプリ層認証のCloud Run workflow/smoke、認証必須のimage既定値、Firestore memory/name indexを実装する。旧データのexport/import/verifyはfresh start方針のため対象外とする。
- production runtimeからClerk、Redis、Vercel Blob adapter、Vercel remote service、永続telemetry DBを削除した。旧Vercel Blob/Tursoのmigration専用スクリプト、テスト、devDependenciesも、旧データを移行せず空スタートする方針により削除済みである。
- ローカル検証時点で全テスト、lint、型検査、`NODE_ENV=production pnpm build`を実行する。Cloud Run smoke scriptはinitialize、tools/list、save、get、update、link、reindex、search、deleteを実行し、renameは`CloudMemoryService`の回帰テストで検証する。Cloud Run/Firebase/GCSの実環境smokeは外部資格情報が必要な未完了ゲートであり、旧データのexport/import/verifyは対象外、旧Vercel Project削除はユーザー報告で完了している。
- `main`へのPRマージ後は、`push`イベントでGitHub Actionsのverify完了後に`production` Environmentを使ってCloud Runへ自動deployする。手動dispatchもmainブランチだけを許可し、Production deployは同時実行しない。Environmentの設定値は`docs/cloud-run-production-deployment.md`に記録する。
- pnpm は `packageManager` の 11.1.3 を使用する。仕様の依存範囲を維持し、解決済みバージョンは `pnpm-lock.yaml` に固定する。
- ホストが `NODE_ENV=development` を設定している場合、本番ビルド検証は `NODE_ENV=production pnpm build` で実行する。
