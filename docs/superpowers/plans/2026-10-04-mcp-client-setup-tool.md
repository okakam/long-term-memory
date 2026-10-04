# MCP Client Setup Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Keep the tasks sequential because each task establishes interfaces used by the next. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated, project-independent MCP tool that gives Claude Code or Codex the canonical post-connection setup guide and assets for local application.

**Architecture:** Generate a static setup manifest from `docs/post-mcp-setup.md` and its three canonical assets so the Cloud Run runtime does not need repository docs. Register `setup_client_environment` as a meta tool with a required client enum and no `project_id`; the calling agent applies the returned data to its own client environment.

**Tech Stack:** TypeScript, Zod, MCP SDK, Node.js `crypto`, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-04-mcp-client-setup-tool-design.md`

## Global Constraints

- Use Node.js 22 and pnpm 11.1.3.
- The MCP endpoint remains queryless `POST /api/mcp`; do not add `project_id` to its URL.
- `list_projects` and `setup_client_environment` do not take `project_id`; the other 15 tools keep required top-level `project_id`.
- The Cloud Run handler returns setup data only and never writes to the caller's filesystem.
- Use only the repository's `docs/post-mcp-setup.md` and canonical skill, hook, and instruction-block sources; do not place secrets or PAT values in output.
- Dashboard project/member management stays in the Dashboard; machine-only curator/CI PAT setup stays out of ordinary client configuration.
- Keep repository documentation in Japanese and update `AGENTS.md` with the changed MCP contract.

## Review Focus

- **Generated payload integrity:** Unicode, backticks, and newlines must survive TypeScript generation; compare content and SHA-256 values against sources in Task 1.
- **Wrong or missing client:** reject missing/unknown `client` values and extra `project_id` input in Task 2.
- **Wrong target scope:** assert Claude uses its config directory and Codex uses the current repository in Task 2.
- **Oversized tool output:** assert the serialized setup payload stays below 64 KiB in Task 2.
- **Accidental project/auth coupling:** call the tool without `project_id`, and verify the deployed smoke uses normal Bearer authentication in Task 3.

## Worktree and delegation

Before implementation, use `superpowers:using-git-worktrees` to create a clean worktree from the current `origin/develop` commit on `feature/mcp-client-setup-tool`. The approved spec and plan currently exist only as untracked files in the current worktree; copy both into the feature worktree and commit them before Task 1. Preserve all existing changes in the current worktree, including `.codex/.ltm-config-version` and the staged hook mode change. The feature worktree was first created at `/workspace/long-term-memory-client-setup`, then relocated to `/tmp/long-term-memory-client-setup` after Vitest worker I/O stalled on the 9p mount; keep commits and the SDD ledger in that local-overlay worktree. Use `superpowers:subagent-driven-development`; every delegated agent must search long-term-memory and read full relevant results before acting.

### Task 1: Generate the runtime setup manifest

**Files:**
- Modify: `scripts/sync-embedded-docs.mjs`
- Create: `src/lib/mcp/setup-manifest.generated.ts`
- Test: `tests/lib/mcp/setup-manifest.test.ts`

**Interfaces:**
- Produces `SETUP_MANIFEST` with `schema_version: 1`, `config_version`, `guide_markdown`, and three `{ path, sha256, content }` assets.
- `config_version` is `sha256:<hex>` over JSON containing the rendered guide plus each asset path and asset SHA-256. Asset hashes are SHA-256 of exact UTF-8 source content.

- [ ] **Step 1: Write the failing manifest tests.** First assert that `src/lib/mcp/setup-manifest.generated.ts` exists; only after that assertion, parse the JSON literal assigned to `SETUP_MANIFEST`. Assert the three asset paths, exact source content, per-asset SHA-256, deterministic `config_version`, and that the rendered guide includes the generated embeds.
- [ ] **Step 2: Run `pnpm exec vitest run tests/lib/mcp/setup-manifest.test.ts`.** Confirm an assertion failure because the generated module does not exist, rather than a test-import or module-resolution error.
- [ ] **Step 3: Extend `scripts/sync-embedded-docs.mjs`.** Generate the TypeScript module from the rendered `docs/post-mcp-setup.md` plus `skills/long-term-memory/SKILL.md`, `claude-config/hooks/ltm-init-reminder.sh`, and `claude-config/claude-md-block.md`. Make normal mode write both docs and module; make `--check` fail if either is stale. Serialize string values with `JSON.stringify`.
- [ ] **Step 4: Run the manifest test and `node scripts/sync-embedded-docs.mjs --check`.** Confirm both pass and a second normal sync leaves the generated files unchanged.
- [ ] **Step 5: Commit the generator, manifest, and test** with `feat: generate MCP client setup manifest`.

### Task 2: Add the client setup MCP tool

**Files:**
- Modify: `src/lib/mcp/schemas.ts`
- Modify: `src/lib/mcp/tools/meta.ts`
- Create: `src/lib/mcp/tools/setup.ts`
- Modify: `tests/lib/mcp/server.test.ts`
- Test: `tests/lib/mcp/tools.setup.test.ts`

**Interfaces:**
- `SetupClientEnvironmentInput = z.object({ client: z.enum(['claude-code', 'codex']) }).strict()`.
- `registerClientSetupTool(server: McpServer): void` registers `setup_client_environment` and returns JSON text with `schema_version`, `config_version`, `client`, `target_scope`, `setup_instructions`, `guide_markdown`, `assets`, and `post_setup_actions`.
- `target_scope` is `claude-user-config` or `codex-current-repository`. Claude uses `CLAUDE_CONFIG_DIR` or `$HOME/.claude`; Codex uses `git rev-parse --show-toplevel`.

- [ ] **Step 1: Write failing tool tests.** Exercise both clients through `handleMcpRequest`; assert no `project_id` is needed, the client-specific scope/actions are returned, all asset hashes match, and payload size is below 64 KiB. Assert missing, unknown, and extra fields are rejected.
- [ ] **Step 2: Run `pnpm exec vitest run tests/lib/mcp/tools.setup.test.ts tests/lib/mcp/server.test.ts`.** Confirm failures identify the missing tool and 17-tool catalog.
- [ ] **Step 3: Implement the schema and `src/lib/mcp/tools/setup.ts`.** Return the generated manifest and explicit client-specific local-application instructions. State that MCP add/login are already complete, the agent must apply files locally, Dashboard gaps require manual action, and curator PAT instructions must not be applied. Do not read project data or call `requireProjectAccess`.
- [ ] **Step 4: Register the tool from `registerMetaTools`, update the server test from 16 to 17 tools, and rerun the focused tests.** Verify `tools/list` exposes only `client` as the required setup argument.
- [ ] **Step 5: Commit the tool and tests** with `feat: add MCP client setup tool`.

### Task 3: Update client guidance and Cloud Run smoke

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/reproduction-spec.md`
- Modify: `docs/post-mcp-setup.md`
- Modify: `skills/long-term-memory/SKILL.md`
- Modify: `.agents/skills/long-term-memory/SKILL.md`
- Modify: `scripts/cloud-run-smoke.ts`
- Modify: `tests/docs/post-mcp-setup.test.ts`
- Modify: `tests/deploy/task8.test.ts`

**Interfaces:**
- The setup tool appears in the canonical skill tool list and in the guide's post-connection instructions.
- Cloud Run smoke calls `setup_client_environment` with `{ client: 'codex' }` and no `project_id`, then checks the returned client, schema version, asset hashes, and guide content.

- [ ] **Step 1: Extend the documentation and smoke tests.** Assert the 17-tool inventory, unscoped setup call, client-specific behavior, and updated setup tool description in their owning tests.
- [ ] **Step 2: Run `pnpm exec vitest run tests/docs/post-mcp-setup.test.ts tests/deploy/task8.test.ts`.** Confirm failures identify stale tool counts and missing smoke coverage.
- [ ] **Step 3: Update the docs and skills.** Document that a connected client invokes the tool and its agent applies returned data locally; retain manual Dashboard and machine-only PAT boundaries. Update the reproduction spec and `AGENTS.md` so only `list_projects` and setup omit `project_id`; add the tool to both canonical and repository-local skill inventories. Run `node scripts/sync-embedded-docs.mjs` to refresh the guide and manifest.
- [ ] **Step 4: Extend `scripts/cloud-run-smoke.ts`.** Add `setup_client_environment` to `EXPECTED_TOOLS`; make an unscoped, Bearer-authenticated call and validate its manifest response without writing local files. Run the documentation/smoke tests and `node scripts/sync-embedded-docs.mjs --check`.
- [ ] **Step 5: Commit docs, smoke, and generated outputs** with `docs: document MCP client setup tool`.

### Task 4: Run repository gates and open the PR

**Files:**
- Verify the files changed in Tasks 1–3.

- [ ] **Step 1: Run focused tests** for the setup manifest, setup tool, MCP server catalog, post-MCP documentation, and deployment smoke contract.
- [ ] **Step 2: Run repository gates:** `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`, `NODE_ENV=production pnpm build`, `node scripts/sync-embedded-docs.mjs --check`, and `git diff --check`.
- [ ] **Step 3: Inspect the final diff.** Confirm there are no runtime reads of `docs/`, client secrets, PATs, unintended `project_id` changes, or changes copied from the pre-existing dirty worktree.
- [ ] **Step 4: Push `feature/mcp-client-setup-tool` and open a PR to `develop`.** Include focused behavior, validation results, and the Cloud Run smoke as a post-deployment acceptance check; do not deploy directly.

## Verification boundaries

The authenticated production Cloud Run smoke runs only after the PR is merged and deployed through the existing main/deploy workflow. Local tests and build do not claim that the production MCP endpoint has received the new tool.
