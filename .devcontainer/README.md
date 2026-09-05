# 開発コンテナの Codex 環境

この開発コンテナには、Node.js 開発に加えて OpenAI Codex CLI、GitHub CLI（`gh`）、`jq` を導入しています。

## 初回利用

1. VS Code で「コンテナーで再度開く」を実行する。
2. ターミナルで `codex --version` と `gh --version` を確認する。
3. `codex` を起動し、表示された案内から ChatGPT または利用可能な方法でサインインする。
4. GitHub 操作が必要な場合は `gh auth login` を実行する。

Codex の設定・認証状態は `CODEX_HOME=/home/node/.codex` に保存され、Compose の `long-term-memory-codex` volume でコンテナ再作成後も保持されます。API キーや認証情報は Dockerfile に記述しません。

## バージョン

Codex CLI は Dockerfile の `CODEX_VERSION`（現在 `0.153.4`）で固定しています。更新時は Dockerfile と compose.yaml の両方を変更してイメージを再ビルドしてください。
