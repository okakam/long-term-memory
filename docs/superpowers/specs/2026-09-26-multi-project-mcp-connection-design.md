# 複数 Project 対応 MCP 接続設計

## 目的

利用者が `long-term-memory` を一度だけ MCP client へ登録し、その接続から権限を持つ複数の project を安全に操作できるようにする。`mcp add` 時に project slug を固定する必要をなくす。

## 背景と完了条件

変更前の MCP endpoint は `POST /api/mcp?project_id=<slug>` であり、connection ごとに一つの project を `ToolContext` へ固定していた。このため、複数 project を扱うには MCP 設定を重複して作る必要があった。

完了時には、次を満たす。

- Codex は `https://ltm.okakam.net/api/mcp` を一度だけ登録して OAuth login できる。
- `list_projects` は認証主体が member 又は owner である project を、memory が未作成の project も含めて返す。
- project を扱う各 tool は top-level の必須 `project_id` で対象を指定し、毎回その project の membership と tool 別権限を検証する。
- project を省略して memory を read/write する操作、未所属 project の操作、member による `reindex`、通常 credential による `__shared__` 書込みを拒否する。
- Dashboard の project 作成・member 管理を唯一の権限設定画面として維持する。MCP connection 単位の allowlist や既定 project は作らない。

## 接続と tool 契約

MCP endpoint を `POST /api/mcp` へ統一し、project 境界を URL query から tool input へ移す。`initialize`、`tools/list`、`list_projects` は project を必要としない。残りの15 tools はすべて操作対象として top-level `project_id` を必須とする。

```json
{
  "name": "search_memories",
  "arguments": { "project_id": "product-a", "query": "OAuth 設計" }
}
```

`source_refs[].project_id` は、保存する memory が参照した別 project の識別子であり、操作対象を表す新しい top-level `project_id` とは別のまま維持する。

暗黙の現在 project、`set_project` tool、connection URL の query、token に埋め込む project role は採用しない。明示的な input は誤った project への書込みを避け、request ごとの membership 検証は権限変更を直ちに反映するためである。

## 認証・認可

transport は request ごとに OAuth access token 又は PAT から principal を復元するが、`tools/list`、`initialize`、`list_projects` のために project access を先行判定しない。tool handler が schema で検証済みの `project_id` を受け取り、対象と action を `ToolContext` の認可関数へ渡す。

| 操作 | 必要な権限 |
| --- | --- |
| `list_projects` | 有効な MCP principal。返すのは本人の membership だけ |
| read tools | 対象 project の owner 又は member |
| write tools | 対象 project の owner 又は member |
| `reindex` | 対象 project の owner |
| `__shared__` read | 通常 principal でも可 |
| `__shared__` write / `reindex` | curator UID の PAT、maintenance token、既存 shared maintenance 条件 |

`AUTH_REQUIRED=0` の local mode では既存の合成 local user と service を使う。production では Bearer principal 不在・無効を従来どおり HTTP 401 とし、membership 又は tool role 不足は JSON-RPC tool error (`isError: true`) として返す。Streamable HTTP の有効な `tools/call` request自体はHTTP 200で応答する。membership削除、owner降格、grant/PAT失効は次のtool invocationから反映される。

MCP session を使用する mode でも principal、maintenance token、project を session state へ固定しない。各 HTTP request で principal と maintenance token を読み、各 tool invocation で project を認可する。

## 一覧・telemetry・Dashboard

`list_projects` は認証済み利用者では Firestore の `listAccessibleProjects(userId)` を正本として返す。返却する認証済みproject viewは `project_id`、`role`、`created_at`、`updated_at` のみとし、`owner_user_id`などの内部UIDは公開しない。memory count は一覧条件に使わず、空 project も返す。local mode は既存の service summary を維持する。

`project_id` は `assertProjectId` と同じ slug 及び `__shared__` の検証規則を使う。read tool の `include_shared`、shared read の上限、名前衝突時に project 側を優先する挙動は維持する。tool description には `list_projects` の後に対象 `project_id` を渡すことを明記する。

各成功・失敗の tool telemetry は input や本文を記録せず、scope tool では対象 `project_id` を記録する。`list_projects` と protocol 操作は global/meta として扱う。

利用者は Dashboard で project を作成し、owner が登録済み利用者を member/owner として管理する。この membership が Web API と MCP 双方の認可正本である。MCP 設定に project を追加する操作はない。

```bash
codex mcp add long-term-memory --url 'https://ltm.okakam.net/api/mcp'
codex mcp login long-term-memory
```

Claude Code curator、CI、Cloud Run smoke も同じ endpoint を使用し、必要な `project_id` は tool input に渡す。PAT と maintenance token の用途は変えない。

## 変更対象と検証

MCP schema、context、read/write/meta tool、transport、session key、telemetry instrumentation、unit testsを変更する。OAuth resource metadata、CORS、GET/DELETE method guardは URL query に依存しない形へ更新する。OAuth issuer と resource は引き続き `https://ltm.okakam.net/api/mcp` である。

`README.md`、`docs/post-mcp-setup.md`、`docs/mcp-config.cloud-run.json`、`docs/reproduction-spec.md`、既存 OAuth・project management 設計書と計画書、long-term-memory skill の埋込元を更新する。

unit/integration test は、query なしで tools/list できること、list_projects が空 project を含むこと、同一 principal が二 project を連続操作できること、未所属 project の read/write 拒否、member の reindex 拒否、shared 書込みの三条件、session mode で project が固定されないこと、対象 project telemetry を確認する。

既存の全 test、lint、型検査、`NODE_ENV=production pnpm build`、`git diff --check`を実行する。本番では Dashboard で二 project を作成して同一 user へ membership を与え、URL query なしの一接続で両 project に save/search/get を行い、member 削除直後の拒否を確認する。OAuth browser consent/callback smoke も既存どおり別途行う。

## 非対象

- project 間を横断して一つの検索結果へ統合する検索。
- project ごとの OAuth client、OAuth scope、token、MCP server 名。
- Dashboard 以外からの project membership 管理。
- 既存 MCP URL の query 付き接続を恒久的に互換維持すること。`project_id` query は明確な更新エラーとして400で拒否する。

## 正本との関係

本設計は `docs/reproduction-spec.md` の MCP endpoint・認可契約、`docs/superpowers/specs/2026-09-21-mcp-oauth-codex-login-design.md` の resource/membership 契約、`docs/superpowers/specs/2026-09-24-project-management-and-ui-design.md` の Dashboard 案内を更新する。Firebase identity、Firestore membership、GCS project 別 object key、shared curator 条件は変更しない。
