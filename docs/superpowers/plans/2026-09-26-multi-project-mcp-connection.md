# 複数 Project 対応 MCP 接続 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一つの URL query なし MCP 接続から、membership を持つ複数 project を tool ごとに選択して安全に操作できるようにする。

**Architecture:** `ToolContext`から固定`projectId`を取り除き、tool input の top-level `project_id`を対象 scope にする。transport は credential だけを復元し、各 tool handler が schema 検証済み project を action 別に認可する。Dashboard membership を唯一の allowlist として、OAuth/PAT token へ project 権限を保存しない。

**Tech Stack:** Next.js App Router、TypeScript、Zod、MCP SDK、Vitest、Firestore/SQLite auth store。

**Spec:** `docs/superpowers/specs/2026-09-26-multi-project-mcp-connection-design.md`

## Global Constraints

- 公開 endpoint は `POST /api/mcp` とし、`project_id` query を受け付けない。
- `list_projects` 以外の15 MCP tools は top-level 必須 `project_id` を使用する。
- OAuth/PAT token に project role を埋め込まず、tool invocation ごとに Firestore membership を再評価する。
- `__shared__` の read-only と curator PAT＋maintenance token の write 条件を維持する。
- `source_refs[].project_id` は provenance であり、操作対象 top-level `project_id` と混同しない。
- telemetry は本文・tool input を記録せず、scope tool では対象 project だけを記録する。
- Node.js 22、pnpm 11.1.3、既存の16 tool名、OAuth resource URL、GCS project別 key を維持する。

## Review Focus

- query付き旧URLが黙って別scopeを選ばず、明確に400で更新を要求すること（Task 2）。
- memoryが無いprojectも`list_projects`に出て、owner/member以外は出ないこと（Task 3）。
- 同一credentialが二つのprojectを連続操作しても、各service呼出し・telemetryが指定scopeを使うこと（Task 4）。
- `project_id`を省略、slug規則違反、未所属projectを指定した場合にread/writeともserviceへ届かず、MCP tool errorを返すこと（Task 1, 4）。
- session mode、shared write、owner-only reindexで固定projectや以前のrequestのmaintenance stateを再利用しないこと（Task 2, 4）。

---

### Task 1: 動的 project scope の schema と context 契約を固定する

**Files:**

- Modify: `src/lib/mcp/schemas.ts`
- Modify: `src/lib/mcp/context.ts`
- Modify: `tests/lib/mcp/context.test.ts`
- Modify: `tests/lib/mcp/tools.test.ts`

**Interfaces:**

- Consumes: `assertProjectId`, `McpPrincipal`, `assertProjectAccess`。
- Produces: `ProjectScopedInput`を含む全15 tool input、`ToolContext.requireProjectAccess(projectId: string, action: ProjectAction): Promise<void>`。

- [ ] **Step 1: top-level `project_id`必須入力の失敗testを書く**

`search_memories`と`remember_project_fact`が`project_id`なしではschema errorとなり、`source_refs[].project_id`だけでは対象scopeを満たさないことを追加する。`extractProjectId`が廃止されることも固定する。

- [ ] **Step 2: testが失敗することを確認する**

Run: `pnpm exec vitest run tests/lib/mcp/context.test.ts tests/lib/mcp/tools.test.ts`

Expected: top-level `project_id`を要求しないためFAIL。

- [ ] **Step 3: schemaとdynamic authorization contextを実装する**

`schemas.ts`に`assertProjectId`相当の検証を持つ`ProjectId`と`ProjectScopedInput`を追加し、全read/write/reindex schemaへspreadする。`ToolContext`はservice、requestごとのprincipal/maintenance情報、`requireProjectAccess`を持つ。local modeでは認可を通し、auth required時はactionごとに`assertProjectAccess`とshared curator条件を検査する。

- [ ] **Step 4: focused testを通す**

Run: `pnpm exec vitest run tests/lib/mcp/context.test.ts tests/lib/mcp/tools.test.ts`

Expected: PASS。

- [ ] **Step 5: commitする**

```bash
git add src/lib/mcp/schemas.ts src/lib/mcp/context.ts tests/lib/mcp/context.test.ts tests/lib/mcp/tools.test.ts
git commit -m "feat: add project-scoped MCP tool inputs"
```

### Task 2: queryなし transport と session を principal 単位へ移行する

**Files:**

- Modify: `src/lib/mcp/transport.ts`
- Modify: `src/lib/mcp/session.ts`
- Modify: `src/lib/mcp/server.ts`
- Modify: `tests/lib/mcp/stateless.test.ts`
- Modify: `tests/lib/mcp/auth-required.test.ts`
- Modify: `tests/lib/mcp/oauth-auth-required.test.ts`

**Interfaces:**

- Consumes: Task 1の`ToolContext`。
- Produces: queryなし`handleMcpRequest`、principal/maintenance情報だけを持つsession key、project非依存のinitialize/tools-list/list-projects。

- [ ] **Step 1: transportの失敗testを書く**

queryなし`/api/mcp`のinitialize/tools/list/list_projectsが通ること、`?project_id=legacy`が400になること、missing credentialはtools/listでも401になることを追加する。OAuth/PAT testのrequest helperをqueryなしURLへ変更し、tool call argumentsにtarget `project_id`を渡す。

- [ ] **Step 2: testが失敗することを確認する**

Run: `pnpm exec vitest run tests/lib/mcp/stateless.test.ts tests/lib/mcp/auth-required.test.ts tests/lib/mcp/oauth-auth-required.test.ts`

Expected: 現行transportがqueryを必須とするためFAIL。

- [ ] **Step 3: transportとsessionを実装する**

`extractProjectId`とtransportのtool名先読み認可を削除する。queryに`project_id`があれば400を返し、credential解決だけをrequestごとに行う。session keyとconnect telemetryから固定projectを除外し、`createMcpServer`へdynamic contextを渡す。method guard、OAuth 401/403形式、timeout、CORS headerは維持する。

- [ ] **Step 4: focused testを通す**

Run: `pnpm exec vitest run tests/lib/mcp/stateless.test.ts tests/lib/mcp/auth-required.test.ts tests/lib/mcp/oauth-auth-required.test.ts`

Expected: PASS。

- [ ] **Step 5: commitする**

```bash
git add src/lib/mcp/transport.ts src/lib/mcp/session.ts src/lib/mcp/server.ts tests/lib/mcp/stateless.test.ts tests/lib/mcp/auth-required.test.ts tests/lib/mcp/oauth-auth-required.test.ts
git commit -m "feat: make MCP transport project-neutral"
```

### Task 3: project一覧を membership の正本から返す

**Files:**

- Modify: `src/lib/mcp/tools/meta.ts`
- Modify: `tests/lib/mcp/auth-required.test.ts`
- Modify: `tests/lib/mcp/stateless.test.ts`

**Interfaces:**

- Consumes: `AuthStoreLike.listAccessibleProjects(userId)`。
- Produces: authenticated `list_projects()`が`project_id`、`role`、`created_at`、`updated_at`だけを返す契約（内部`owner_user_id`は公開しない）。local modeはserviceのproject summaryを返す既存挙動を維持する。

- [ ] **Step 1: list_projectsの失敗testを書く**

ownerとmemberが所属するmemory未作成projectを返し、未所属projectを返さないことを追加する。principalなしlocal modeの既存summaryも確認する。

- [ ] **Step 2: testが失敗することを確認する**

Run: `pnpm exec vitest run tests/lib/mcp/auth-required.test.ts tests/lib/mcp/stateless.test.ts`

Expected: 現在はmemory serviceの一覧でfilterするため空projectがないことでFAIL。

- [ ] **Step 3: meta toolを実装する**

認証済みの場合は`getAuthStore().listAccessibleProjects(ctx.principal.userId)`を読み、結果を`project_id`、`role`、`created_at`、`updated_at`へ明示的にmapする。`owner_user_id`をMCP応答へ含めず、memory countを認可判断又は一覧条件に使わない。tool descriptionを「最初に実行して対象`project_id`を選ぶ」案内へ変更する。

- [ ] **Step 4: focused testを通す**

Run: `pnpm exec vitest run tests/lib/mcp/auth-required.test.ts tests/lib/mcp/stateless.test.ts`

Expected: PASS。

- [ ] **Step 5: commitする**

```bash
git add src/lib/mcp/tools/meta.ts tests/lib/mcp/auth-required.test.ts tests/lib/mcp/stateless.test.ts
git commit -m "feat: list accessible MCP projects"
```

### Task 4: tool handler、shared gate、telemetryを対象 project ごとにする

**Files:**

- Modify: `src/lib/mcp/tools/read.ts`
- Modify: `src/lib/mcp/tools/write.ts`
- Modify: `src/lib/mcp/tools/meta.ts`
- Modify: `src/lib/telemetry/instrument.ts`
- Modify: `src/lib/mcp/server.ts`
- Modify: `tests/lib/mcp/tools.test.ts`
- Modify: `tests/lib/mcp/schemas.test.ts`
- Modify: `tests/lib/mcp/descriptions.test.ts`
- Modify: `tests/lib/mcp/tools.read.shared.test.ts`
- Modify: `tests/lib/mcp/tools.write.shared.test.ts`
- Modify: `tests/lib/telemetry/instrument.test.ts`

**Interfaces:**

- Consumes: Task 1の`project_id`付きtool argsと`requireProjectAccess`。
- Produces: 各handlerが`project_id`をauthorization/service/telemetryへ一貫して渡す。`instrumentRegistrar`はhandler inputからscopeを安全に取り出す。

- [ ] **Step 1: tool scopeとtelemetryの失敗testを書く**

一つのprincipalが`alpha`と`beta`へ連続save/searchでき、各mock service callが指定projectを受けることを確認する。未所属project、member reindex、shared writeの不足条件ではserviceを呼ばず、JSON-RPC `isError: true` のtool errorを返すことを追加する。HTTPは有効な`tools/call` requestへのprotocol応答として200のままにする。`schemas.test.ts`では全scope toolのrequired top-level idと`ReindexInput`を固定し、`descriptions.test.ts`と既存tool testsのquery/argumentsを新contractへ移行する。instrument testではsuccess/failureともtop-level `project_id`を記録し、`list_projects`がglobal/metaとして扱われることを確認する。

- [ ] **Step 2: testが失敗することを確認する**

Run: `pnpm exec vitest run tests/lib/mcp/tools.test.ts tests/lib/mcp/schemas.test.ts tests/lib/mcp/descriptions.test.ts tests/lib/mcp/tools.read.shared.test.ts tests/lib/mcp/tools.write.shared.test.ts tests/lib/telemetry/instrument.test.ts`

Expected: handlerが固定`ctx.projectId`を使うためFAIL。

- [ ] **Step 3: read/write/meta handlersを移行する**

各handlerでinputから`project_id`を分離し、read/write/maintain actionを先に`requireProjectAccess`へ渡す。service、shared fallback、scopeラベル、`assertSharedWritable`、`reindex`へ同じ対象を渡す。`include_shared`の既存上限・名前衝突規則を保つ。

- [ ] **Step 4: telemetry wrapperを移行する**

`instrumentRegistrar`のcontextを固定projectではなく安全な`projectIdForInput(input)` callbackに変更する。top-level `project_id`がないprotocol/meta toolはglobal projectとして計測し、input/本文をrecorderへ渡さない。

- [ ] **Step 5: focused testを通す**

Run: `pnpm exec vitest run tests/lib/mcp/tools.test.ts tests/lib/mcp/schemas.test.ts tests/lib/mcp/descriptions.test.ts tests/lib/mcp/tools.read.shared.test.ts tests/lib/mcp/tools.write.shared.test.ts tests/lib/telemetry/instrument.test.ts`

Expected: PASS。

- [ ] **Step 6: commitする**

```bash
git add src/lib/mcp/tools src/lib/mcp/server.ts src/lib/telemetry/instrument.ts tests/lib/mcp tests/lib/telemetry/instrument.test.ts
git commit -m "feat: scope MCP tools by project input"
```

### Task 5: 利用手順・正本仕様・埋込 skill を更新し全体を検証する

**Files:**

- Modify: `README.md`
- Modify: `docs/reproduction-spec.md`
- Modify: `docs/post-mcp-setup.md`
- Modify: `docs/mcp-config.cloud-run.json`
- Modify: `docs/superpowers/specs/2026-09-21-mcp-oauth-codex-login-design.md`
- Modify: `docs/superpowers/specs/2026-09-24-project-management-and-ui-design.md`
- Modify: `docs/superpowers/plans/2026-09-21-mcp-oauth-codex-login.md`
- Modify: `docs/superpowers/plans/2026-09-24-project-management-and-ui.md`
- Modify: `.agents/skills/long-term-memory/SKILL.md`
- Modify: `tests/docs/post-mcp-setup.test.ts`

**Interfaces:**

- Consumes: Tasks 1–4と本設計書。
- Produces: URL queryなしの公開手順、tool argumentによるscope選択、Dashboard membershipを唯一のproject許可設定とする運用文書。

- [ ] **Step 1: documentation regression testを更新して失敗させる**

`codex mcp add` URLが`/api/mcp`であること、`list_projects`後にtool argumentの`project_id`を使うこと、URL queryの`project_id`例がないことを追加する。

- [ ] **Step 2: documentation testが失敗することを確認する**

Run: `pnpm exec vitest run tests/docs/post-mcp-setup.test.ts`

Expected: 現在の手順がURL queryを案内するためFAIL。

- [ ] **Step 3: 全ての正本と例を更新する**

READMEとsetup guideの`mcp add`を`/api/mcp`へ変更する。Dashboardでmembershipを設定する手順は維持し、MCP toolが`list_projects`で選んだtop-level `project_id`を使うと記載する。curator JSONからURL queryを削除し、shared targetはtool argumentとして示す。OAuth/project managementの既存設計・計画の旧前提を本設計へ参照更新する。skill sourceの「project_idはMCP URL」及びcross-project endpoint記述を更新し、`node scripts/sync-embedded-docs.mjs`で埋込先を同期する。

- [ ] **Step 4: documentation testを通す**

Run: `pnpm exec vitest run tests/docs/post-mcp-setup.test.ts`

Expected: PASS。

- [ ] **Step 5: repository quality gatesを実行する**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit && NODE_ENV=production pnpm build && git diff --check && docker compose -f .devcontainer/compose.yaml config --quiet`

Expected: 全commandが成功する。Cloud Run/Firebase/GCS実環境smokeは資格情報が必要な未完了ゲートとして別記録する。

- [ ] **Step 6: commitする**

```bash
git add README.md docs .agents/skills/long-term-memory/SKILL.md tests/docs/post-mcp-setup.test.ts
git commit -m "docs: document multi-project MCP connection"
```

## Plan Self-Review

- Spec coverage: endpoint、tool schema、dynamic authorization、Dashboard membership、shared gate、telemetry、documentation、local/production verificationをTask 1–5へ割り当てた。
- Type consistency: 全taskで操作対象はtop-level `project_id`、authorization入口は`ToolContext.requireProjectAccess`、一覧の正本は`listAccessibleProjects`で統一した。
- Review Focus: legacy URL、empty project、scope混在、invalid/unauthorized target、session/shared/owner境界を対応するtest taskに割り当てた。
- Proportion: schema/context、transport、tool/telemetry、documentationを独立したレビュー可能単位に分け、実装本文を計画へ複製していない。
