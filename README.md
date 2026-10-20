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

## Claude Codeから接続する

Claude CodeはPATで接続します。OAuth認可サーバーは`http://127.0.0.1`のcallbackだけを受け付けるため、Claude Codeの`/mcp`からのOAuthログインは使いません。

1. Dashboardの`/settings/tokens`でPATを発行します。本文は発行直後に一度だけ表示されます。
2. PATを環境変数`LTM_MCP_TOKEN`へ設定し、user scopeでHTTP MCPサーバーを登録します。

```bash
read -rs LTM_MCP_TOKEN && export LTM_MCP_TOKEN

claude mcp add --transport http --scope user long-term-memory \
  'https://ltm.okakam.net/api/mcp' \
  --header "Authorization: Bearer ${LTM_MCP_TOKEN}"
```

登録したPATは`~/.claude.json`に保存されます。このファイルをrepositoryへコミットしたり共有したりしないでください。登録状態は`claude mcp list`、または起動後のClaude Codeで`/mcp`を実行して確認できます。PATを失効・再発行した場合は`claude mcp remove --scope user long-term-memory`で削除してから再登録します。

接続後、Claude Codeで`setup_client_environment`を`{"client": "claude-code"}`で呼ぶと、skill・hook・`CLAUDE.md`ルールをユーザー設定へ配置する手順を取得できます。projectの選び方はCodexと同じで、`list_projects`で確認して各tool callの`project_id`で指定します。

## ローカル開発

Node.js 22とpnpmを使います。nvmを使う場合は`.nvmrc`のバージョンへ切り替えます。

```bash
nvm install
nvm use
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

## ドキュメント

- [現行再現仕様書](docs/reproduction-spec.md)
- [Google Cloud / Firebase初期設定](docs/google-cloud-cli-setup.md)
- [Cloud Run本番デプロイ](docs/cloud-run-production-deployment.md)
