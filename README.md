# long-term-memory

Markdownを正本にする長期記憶アプリケーションです。Cloud Run上のMCPサーバーをCodexから利用できます。

## Codexから接続する

`https://ltm.okakam.net`でログインして利用可能なプロジェクトのslugを確認し、次を実行します。

```bash
codex mcp add long-term-memory \
  --url 'https://ltm.okakam.net/api/mcp?project_id=<project-slug>'
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
