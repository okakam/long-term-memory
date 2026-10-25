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

Claude CodeもCodexと同じくOAuthで接続します。PAT本文を入力する必要はありません。

```bash
claude mcp add --transport http --scope user long-term-memory \
  'https://ltm.okakam.net/api/mcp'
```

Claude Codeを起動して`/mcp`を開き、`long-term-memory`を選んで`Authenticate`を実行します。ブラウザでFirebaseログインと接続の同意を完了すると、Claude Codeがtokenを管理します。登録状態は`claude mcp list`又は`/mcp`で確認でき、接続は`/settings/tokens`の`OAuth 接続（Claude Code / Codex）`から失効できます。以前PAT付きで登録していた場合は、`claude mcp remove --scope user long-term-memory`で削除してから再登録してください。

接続後、Claude Codeで`setup_client_environment`を`{"client": "claude-code"}`で呼ぶと、skill・hook・`CLAUDE.md`ルールをユーザー設定へ配置する手順を取得できます。projectの選び方はCodexと同じで、`list_projects`で確認して各tool callの`project_id`で指定します。PATはcurator・CI・Cloud Run smokeなどの機械接続用です。

## ローカル開発

Node.js 24 (LTS)とpnpmを使います。nvmを使う場合は`.nvmrc`のバージョンへ切り替えます。

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
