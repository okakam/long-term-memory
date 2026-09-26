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
- コンテナには Node.js 22、pnpm、OpenAI Codex CLI、Git、Git Flow、GitHub CLI（`gh`）、Google Cloud CLI（`gcloud`）、Firebase CLI、OpenSSH Server（`sshd`）、`nc`（`netcat-openbsd`）、`jq`、`xz-utils` を用意する。Turso CLIは使用しない。
- VS Code 拡張機能 `openai.chatgpt` は `.devcontainer/devcontainer.json` の `customizations.vscode.extensions` で導入する。
- VS Code Dev Containerでは`remote.autoForwardPorts=true`と`remote.autoForwardPortsSource="process"`を既定にし、Codex OAuthの動的loopback callback portを転送する。callback用の固定port/rangeを`forwardPorts`へ追加せず、自動検出されない場合は`.devcontainer/README.md`の手順で現在のportだけを一時転送する。
- `.devcontainer/devcontainer.json` の `shutdownAction` は `none` とし、VS Codeを閉じても開発コンテナを停止しない。不要時は明示的に停止する。
- 開発用 `sshd` は Compose の root PID 1 で foreground 起動し、ホストの `127.0.0.1:2222` からコンテナの22番ポートへ接続できるようにする。VS Codeの通常操作は `remoteUser: node` とし、パスワード・秘密鍵をリポジトリへ記載しない。
- Codex の設定・認証状態は `CODEX_HOME=/home/node/.codex` に保存し、`long-term-memory-codex` volume で永続化する。
- `/workspace/.codex/config.toml` で Codex CLI の TUI フッターにコンテキスト残量、5時間制限、長期使用制限を表示する。
- 依存関係は `long-term-memory-node_modules` volume に保存する。ローカル開発では `AUTH_REQUIRED=0` を使い、本番の認証設定と混同しない。
- Codex と GitHub CLI の認証はコンテナ内で対話的に行い、Dockerfile や Compose ファイルには秘密情報を記載しない。

## 変更時の確認

- OAuthからFirebaseログインへ戻すredirectは設定済みの公開issuer (`MCP_PUBLIC_URL`) を基準にする。Cloud Runの内部`Request.url`、`Host`、forwarded-hostを使って内部アドレスを外部へ返さない。
- OAuth同意画面(`/oauth/authorize`)のresponse CSPはtransactionから再検証したCodex loopback callbackのoriginだけを`form-action`へ追加する。静的CSPはこのrouteだけを除外し、他routeの`form-action 'self'`と共通security headersを維持する。callback path/queryや任意originを許可しない。本番受入はdeploy後のCodex browser consent/callback smokeで確認し、ローカル成功と混同しない。
- Dashboardのproject作成者はFirestore membershipのownerとし、ownerだけが登録済み許可ドメインのemailでmemberを管理する。認可の正本はUID membershipであり、email directory lookupは表示・追加時だけに使う。最後のownerを削除又はmemberへ変更してはならない。
- Cloud Run runner imageには、起動時に読み込まれる`next.config.ts`とそのproject module依存を含める。Docker imageの`/api/health`起動確認をdeploy前の回帰ゲートとする。

- YAML/JSON の構文を検証し、`docker compose -f .devcontainer/compose.yaml config --quiet` を実行する。
- 開発コンテナをビルドし、`node`、`pnpm`、`codex`、`gh`、`gcloud`、`firebase`、`sshd`、`nc`、`jq` の導入とvolumeの書き込み可否を確認する。GCP/Firebaseの認証はコンテナ内でCLIを使って行い、認証情報はnamed volumeに保存する。
- 変更前後に `git diff --check` を実行する。
- 完了を報告する前に、変更内容に応じたテストまたはビルドを実行し、結果を記録する。

- Cloud Run/Firebase/GCS/Firestore構成の設計・実装計画は `docs/superpowers/specs/2026-09-19-cloud-run-firebase-gcs-firestore-design.md` と `docs/superpowers/plans/2026-09-20-cloud-run-gcs-storage.md` を正本とする。
- Firebase Authentication with Identity PlatformではEmail/Password・Googleを`@okakam.net`だけに限定する。`functions/`の`beforeUserCreated`・`beforeUserSignedIn`とCloud RunのFirebase Admin SDK principal検証を正本とし、Functions deployはCloud Run deployとは別のFirebase CLI操作で行う。詳細は `docs/superpowers/specs/2026-09-21-auth-email-domain-restriction-design.md`、`docs/superpowers/plans/2026-09-21-auth-email-domain-restriction.md`、`docs/google-cloud-cli-setup.md` に記録する。
- FirebaseはWeb本人確認のIdentity Provider、Cloud RunのOAuth authorization serverはMCP credential発行者として分離する。`MCP_OAUTH_ENABLED=1`ではHTTPSの`MCP_PUBLIC_URL`と`AUTH_REQUIRED=1`を必須にし、Codexの通常利用は`codex mcp login long-term-memory`のDCR/PKCE OAuthを使う。DCRでは`scope`を省略可能とし、指定時は`mcp:access`だけを許可してresponseには常に`mcp:access`を返す。`application_type`も省略可能とし、指定時は`native`だけを許可してresponseへ返す。それ以外のscope/application typeは拒否する。Native Appのloopback callbackは`http://127.0.0.1[:port]/<path>`とし、port差を許可してpathは一致させる。OAuth grantはSettingsから失効でき、PATはClaude Code curator・CI・Cloud Run smokeなどmachine互換用途に維持する。
- Cloud Run用GCS Markdown adapter、Firestore metadata/auth store、`/tmp` SQLite cache、Firebase ID token/session cookie、OAuth/PAT Bearer principal、API認可、Invoker公開・アプリ層認証のCloud Run workflow/smoke、認証必須のimage既定値、Firestore memory/name indexを実装する。旧データのexport/import/verifyはfresh start方針のため対象外とする。
- MCPサーバー名は `long-term-memory` に統一し、Claude Codeのツール名も `mcp__long-term-memory__*` を使用する。curatorのファイル名・launchdラベルは運用サービス識別子として既存の `ltm-shared-curator` を維持する。
- production runtimeからClerk、Redis、Vercel Blob adapter、Vercel remote service、永続telemetry DBを削除した。旧Vercel Blob/Tursoのmigration専用スクリプト、テスト、devDependenciesも、旧データを移行せず空スタートする方針により削除済みである。
- ローカル検証時点で全テスト、lint、型検査、`NODE_ENV=production pnpm build`を実行する。Cloud Run smoke scriptはinitialize、tools/list、save、get、update、link、reindex、search、deleteを実行し、renameは`CloudMemoryService`の回帰テストで検証する。Cloud Run/Firebase/GCSの実環境smokeは外部資格情報が必要な未完了ゲートであり、旧データのexport/import/verifyは対象外、旧Vercel Project削除はユーザー報告で完了している。
- `main`へのPRマージ後は、`push`イベントでGitHub Actionsのverify完了後に`production` Environmentを使ってCloud Runへ自動deployする。手動dispatchもmainブランチだけを許可し、Production deployは同時実行しない。Environmentの設定値は`docs/cloud-run-production-deployment.md`に記録する。
- Cloud Runの公開MCP URLは`https://ltm.okakam.net`へ統一する。DNS・Google-managed certificateの有効化後、Production Environmentの`MCP_PUBLIC_URL`、`MCP_ALLOWED_ORIGINS`、`CLOUD_RUN_URL`を揃えてから再デプロイする。
- GCPリソース、IAM、Workload Identity Federation、Secret Manager、Firestore Rules/Indexes、Identity Platform/Blocking FunctionsのCLI手順は `docs/google-cloud-cli-setup.md` に記録する。Firebase Storageは使用せず、Markdown本文はCloud RunからGCS APIで扱う。
- pnpm は `packageManager` の 11.1.3 を使用する。仕様の依存範囲を維持し、解決済みバージョンは `pnpm-lock.yaml` に固定する。
- ホストが `NODE_ENV=development` を設定している場合、本番ビルド検証は `NODE_ENV=production pnpm build` で実行する。

<!-- ltm:begin -->
# long-term-memory MCP MUST rules

1. Before every non-trivial task, call search_memories at least once. Fetch the full body of relevant results with get_memory before acting.
2. Do not load the complete get_memory_index at session start. Use search_memories, search_by_tag, or list_memories_by_type as the entry point.
3. 機密情報は保存しない。Credentials, tokens, private data, and raw environment values never belong in memory.
4. 長期保存先は MCP側を優先し、クライアント固有の auto memory との二重保存を避ける。
5. Durable preferences, corrections, decisions, and reusable gotchas are written actively without確認不要の質問を挟まない。
6. subagent には、作業前に search_memories を呼び、関連結果を get_memory で読むことを明示する。
<!-- ltm:end -->
