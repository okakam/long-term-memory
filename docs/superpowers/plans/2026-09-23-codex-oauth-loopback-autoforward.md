# Codex OAuth loopback callback port転送 計画

> **実行手順:** `superpowers:executing-plans`に従い、タスクを順番に実施する。

**目的:** `codex mcp login long-term-memory`が使う動的loopback portをVS Code Dev Containerから自動転送し、ブラウザー承認後にCodexのcallback listenerへ到達できるようにする。

**方針:** VS Codeのport自動転送を有効にし、検出元を`process`にする。callback portは動的なままとし、検出されない場合の一時的な手動転送を文書化する。

**関連仕様:** `docs/reproduction-spec.md`、`docs/superpowers/specs/2026-09-21-mcp-oauth-codex-login-design.md`

## 制約

- Codex Native Appのcallbackは`http://127.0.0.1[:port]/<path>`を使う。portを固定したり、port rangeを公開したりしない。
- authorization code、state、cookie、tokenを文書・ログ・commitへ記録しない。
- この変更は開発用Dev ContainerのVS Code設定だけを対象とし、本番OAuth endpointやCloud Run設定は変更しない。
- VS Codeのport転送動作はリポジトリのテストランナーで実行できない。ユーザー承認のもと、設定/構文検証を行い、実環境callback到達を手動受け入れ項目として残す。

## タスク: Codexの動的OAuth callback portを自動転送する

変更対象:

- `.devcontainer/devcontainer.json`
- `.devcontainer/README.md`
- `AGENTS.md`
- `docs/reproduction-spec.md`
- `docs/superpowers/plans/2026-09-21-mcp-oauth-codex-login.md`
- `docs/superpowers/plans/2026-09-23-codex-oauth-loopback-autoforward.md`

1. `customizations.vscode.settings`に`remote.autoForwardPorts: true`、`remote.autoForwardPortsSource: "process"`を設定する。固定callback portを`forwardPorts`へ加えない。
2. Dev Container再ビルド、実行中のcallback port確認、検出されない場合の現在のportだけの一時転送、許可ボタンを一度だけ押す手順をREADMEに記載する。
3. `AGENTS.md`、再現仕様、OAuth計画書を同じ運用方針に更新する。認証プロトコルや本番デプロイ設定は変更しない。
4. JSONをparseして設定値をassertし、`git diff --check`を実行する。Docker Compose CLIがある場合は`docker compose -f .devcontainer/compose.yaml config --quiet`を実行する。CLIがない場合はYAML parserでComposeファイルの構文を検証し、Compose解決検証が未実行であることを明記する。
5. 差分を確認して`fix: auto-forward Codex OAuth callback ports`でcommitし、`develop`向けPRを作成する。

## 受け入れ条件

- 動的callback portのprocessベース自動転送がDev ContainerのVS Code既定値になっている。
- 固定callback port、port range、認証secretやOAuth取引値が追加されていない。
- 自動転送されない場合に、実行中のportを手動で一時転送してからブラウザーで一度だけ許可する手順がある。
- 設定/構文チェック結果と、未実施の実ブラウザーcallback確認を区別して報告する。
