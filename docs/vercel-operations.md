# Vercel 運用手順

## 前提

本番は Node.js runtime の Next.js アプリとして動かし、memory index、auth DB、telemetry DBを分離する。Markdown objectはVercel Blobのprivate access、索引はTurso、プロジェクトロックはUpstash Redisを使う。Clerkのブラウザsessionと、Claude Codeから送るPATを混同しない。

## Marketplaceと環境変数

Vercel MarketplaceでClerk、Turso、Blob、Upstashを同じプロジェクトへ接続する。次の値をProductionとPreviewへ設定し、実在する値はGitへ保存しない。
Vercelの実行リージョンはTursoのprimaryリージョンに近い値を選び、Preview/Productionで同じ方針を維持する。

- <code>LTM_STORAGE_DRIVER=vercel</code>、<code>AUTH_REQUIRED=1</code>
- <code>TURSO_DATABASE_URL</code> / <code>TURSO_AUTH_TOKEN</code>
- <code>TURSO_AUTH_DATABASE_URL</code> / <code>TURSO_AUTH_DATABASE_TOKEN</code>
- <code>TURSO_TELEMETRY_DATABASE_URL</code> / <code>TURSO_TELEMETRY_AUTH_TOKEN</code>
- <code>BLOB_READ_WRITE_TOKEN</code>
- <code>UPSTASH_REDIS_REST_URL</code> / <code>UPSTASH_REDIS_REST_TOKEN</code>
- <code>CLERK_SECRET_KEY</code> / <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code>
- <code>NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in</code> / <code>NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up</code>
- <code>LTM_MAINTENANCE_TOKEN</code> / <code>LTM_CURATOR_USER_ID</code>
- <code>LTM_BLOB_PREFIX</code> / <code>MCP_PUBLIC_URL</code> / <code>MCP_ALLOWED_ORIGINS</code>

<code>LTM_BOOTSTRAP_OWNER_USER_ID</code>は既存projectの初回移行時だけ設定し、owner割り当て後に削除する。<code>LTM_MCP_TOKEN</code>はVercelへ設定せず、PAT発行レスポンスまたはGitHub Actions secretでのみ扱う。

## migrationとdeploy

1. 先にTursoの使い捨てDBで <code>pnpm tsx scripts/probe-turso.ts</code> を実行し、FTS5 trigram、weighted bm25、contentless deleteを確認する。
2. <code>pnpm tsx scripts/preflight-migration.ts</code> で空のSQLiteへ現行schemaを適用する。
3. <code>pnpm test</code>、<code>pnpm lint</code>、<code>NODE_ENV=production pnpm build</code>を通す。
4. GitHub Actionsのpreviewで <code>vercel pull --yes</code> → <code>vercel build</code> → <code>vercel deploy --prebuilt</code>を実行する。
5. preview URLへ <code>pnpm tsx scripts/vercel-smoke.ts</code>を実行する。保存したsmoke memoryはfinallyで削除される。
6. smoke成功後に候補deploymentを <code>vercel promote</code>し、production aliasを切り替える。promote前に古いBlob世代を削除しない。

migrationをproductionへ直接適用せず、先にprobeとdry-runを通す。失敗時はpromoteせず、DBの状態を保存して原因を切り分ける。

## smoke

次の環境変数を一時的に設定して実行する。

- <code>VERCEL_SMOKE_URL</code>: preview URL
- <code>LTM_MCP_TOKEN</code>: smoke projectへread/writeできるPAT
- <code>LTM_SMOKE_PROJECT_ID</code>: 既存の専用smoke project（既定 <code>smoke</code>）

<code>pnpm tsx scripts/vercel-smoke.ts</code>はinitialize、tools/list（16 tool）、KG付きproject memoryのsave、3文字以上の日本語検索、entity付き検索、get、dashboard到達性、deleteを確認する。PATやmemory本文をログへ出さない。

## rollback

デプロイ履歴とaliasを確認する。

~~~sh
pnpm dlx vercel@41.7.3 inspect <deployment-url> --token="$VERCEL_TOKEN"
pnpm dlx vercel@41.7.3 logs <deployment-url> --token="$VERCEL_TOKEN"
~~~

異常なcandidateをproductionへpromoteしていなければ、promoteせずに修正する。既にpromote済みなら直前の正常deploymentを指定する。

~~~sh
pnpm dlx vercel@41.7.3 promote <known-good-deployment-url> --token="$VERCEL_TOKEN"
pnpm dlx vercel@41.7.3 rollback <project-or-deployment> --token="$VERCEL_TOKEN"
~~~

rollback後もDB schemaを前のアプリが読める状態に保つ。migrationを下げる操作は自動で行わず、互換性を確認してから別手順で実施する。

## Dockerのローカル配布

DockerはVercel本番の代替ではなく、localhost用のoffline配布である。初回はbind mount元を作成し、外部networkを用意する。

~~~sh
mkdir -p .long-term-memory
docker network create local_dev_network
docker compose build
docker compose up -d
curl -X POST 'http://localhost:3939/api/mcp?project_id=smoke' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
~~~

<code>docker network create</code>が既に存在する場合はエラーになるが、networkを削除してはいけない。schema migrationは最初のrequestで走る。ソース変更時は <code>docker compose build && docker compose up -d</code>を実行する。

## Blob orphanとクライアント更新

Blobはimmutable content hash objectを使う。DB pointerが参照する世代を先に保ち、旧世代や失敗したuploadのorphanは一覧とDBを突き合わせてから、保持期間を置いて管理者が削除する。promote前のGCで旧世代を削除しない。

MCP clientはtools/listをキャッシュすることがある。tool schemaやdescriptionを変更したdeploy後はClaude Codeを再接続／再起動する。
