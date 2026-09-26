# long-term-memory

Markdownを正本にする長期記憶アプリケーションです。Cloud Run上のMCPサーバーをCodexから利用できます。

## Codexから接続する

次のURLを一度だけ登録してOAuthログインします。利用可能なプロジェクトは`list_projects`で確認し、各tool callのtop-level `project_id`で対象を選びます。projectの作成とmember管理はDashboardで行います。

```bash
codex mcp add long-term-memory \
  --url 'https://ltm.okakam.net/api/mcp'
codex mcp login long-term-memory
```

ブラウザーでFirebaseログインと接続の同意を完了します。登録状態は`codex mcp list`で確認できます。詳しい運用手順は[Codex / Claude Code向けMCP設定](docs/post-mcp-setup.md)を参照してください。

## ローカル開発

Node.js 22とpnpmを使います。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

## ドキュメント

- [現行再現仕様書](docs/reproduction-spec.md)
- [Google Cloud / Firebase初期設定](docs/google-cloud-cli-setup.md)
- [Cloud Run本番デプロイ](docs/cloud-run-production-deployment.md)
