# MCP クライアント setup tool 実装計画

> **実装エージェント向け:** この計画は `superpowers:subagent-driven-development` を使い、Task 1 から順に実行する。各 task が次の task の interface を作るため、並行実装しない。各手順の完了状態はチェックボックスで記録する。

**目的:** Claude Code または Codex CLI に、接続後の設定手順と資産を返す認証済み・project 非依存の MCP tool を追加する。

**構成:** `docs/post-mcp-setup.md` と3つの正本資産から静的 setup manifest を生成し、Cloud Run runtime がrepository docsを読む必要をなくす。必須の client enum を受け取る meta tool `setup_client_environment` を登録し、返却データは呼び出し側の client agent が適用する。

**技術:** TypeScript、Zod、MCP SDK、Node.js `crypto`、Vitest、pnpm。

**正本設計:** `docs/superpowers/specs/2026-10-04-mcp-client-setup-tool-design.md`

## 共通制約

- Node.js 22 と pnpm 11.1.3 を使う。
- MCP endpoint は引き続き query なしの `POST /api/mcp` とし、URLへ `project_id` を追加しない。
- `list_projects` と `setup_client_environment` は `project_id` を受け取らない。それ以外の15 toolsは、top-level 必須 `project_id` を受け取る。
- Cloud Run handler は setup data を返すだけとし、呼び出し側の filesystem へ書き込まない。
- `docs/post-mcp-setup.md` と canonical な skill、hook、instruction block のみを使う。出力へsecretやPAT値を含めない。
- Dashboardでのproject/member管理は維持し、curator/CI専用PATの手順を通常client設定へ含めない。
- repositoryの仕様書・計画書・運用文書は日本語で記述し、MCP契約変更に合わせて `AGENTS.md` を更新する。

## レビューで確認する点

- **生成payloadの完全性:** Unicode、backtick、改行をTypeScript生成後も保持し、Task 1でsource内容とSHA-256を比較する。
- **client入力の拒否:** `client` の欠落・未知値と、余分な `project_id` をTask 2で拒否する。
- **対象scope:** Claude Codeはconfig directory、Codexは現在のrepositoryを使うことをTask 2で確認する。
- **出力サイズ:** serialized setup payloadが64 KiB未満であることをTask 2で確認する。
- **project/authとの誤結合:** `project_id` なしのtool callと通常のBearer認証を使うsmokeをTask 3で確認する。

## worktree と委譲

実装前に `superpowers:using-git-worktrees` を使い、`origin/develop` の現在のcommitから `feature/mcp-client-setup-tool` のclean worktreeを作る。承認済みの設計書と計画書は元worktreeで未追跡だったため、feature worktreeへコピーしてTask 1前にcommitする。元worktreeの既存変更 `.codex/.ltm-config-version` とhookのstaged mode変更を保全し、feature worktreeへコピーしない。当初のfeature worktree `/workspace/long-term-memory-client-setup` ではVitest workerの9p I/Oが停滞したため、`/tmp/long-term-memory-client-setup` へ移動済み。以後のcommitとSDD ledgerはこのlocal-overlay worktreeに保存する。`superpowers:subagent-driven-development` を使い、各委譲先へ作業前に long-term-memory を検索し関連memory本文を取得するよう明示する。

### Task 1: runtime setup manifestを生成する

**対象ファイル:**

- 変更: `scripts/sync-embedded-docs.mjs`
- 作成: `src/lib/mcp/setup-manifest.generated.ts`
- テスト: `tests/lib/mcp/setup-manifest.test.ts`

**interface:**

- `schema_version: 1`、`config_version`、`guide_markdown`、3つの `{ path, sha256, content }` assetを持つ `SETUP_MANIFEST` を出力する。
- `config_version` は、render後guideと各assetのpath・SHA-256を含むJSONに対する `sha256:<hex>`。各asset hashはUTF-8 source内容そのものから計算する。

- [x] **手順1: manifest testを先に追加する。** `src/lib/mcp/setup-manifest.generated.ts` の存在を最初にassertし、その後で `SETUP_MANIFEST` に代入されたJSON literalをparseする。3 assetのpath、sourceとの完全一致、assetごとのSHA-256、決定的な `config_version`、render後guide内のembedを確認する。
- [x] **手順2: `corepack pnpm exec vitest run tests/lib/mcp/setup-manifest.test.ts` を実行する。** module解決エラーではなく、生成moduleがないことを示すassertion failureを確認する。
- [x] **手順3: `scripts/sync-embedded-docs.mjs` を拡張する。** render済みの `docs/post-mcp-setup.md` と `skills/long-term-memory/SKILL.md`、`claude-config/hooks/ltm-init-reminder.sh`、`claude-config/claude-md-block.md` からTypeScript moduleを生成する。通常実行ではdocsとmoduleの両方を書き込み、`--check` はどちらかがstaleなら失敗させる。文字列のserializationには `JSON.stringify` を使う。
- [x] **手順4: manifest testと `node scripts/sync-embedded-docs.mjs --check` を実行する。** 両方の成功を確認し、通常syncを続けて2回実行しても生成ファイルが変わらないことを確認する。
- [x] **手順5: generator、manifest、testを `feat: generate MCP client setup manifest` でcommitする。**

### Task 2: client setup MCP toolを追加する

**対象ファイル:**

- 変更: `src/lib/mcp/schemas.ts`
- 変更: `src/lib/mcp/tools/meta.ts`
- 作成: `src/lib/mcp/tools/setup.ts`
- 変更: `tests/lib/mcp/server.test.ts`
- テスト: `tests/lib/mcp/tools.setup.test.ts`
- 追加の契約test保守: `tests/lib/mcp/stateless.test.ts`、`tests/lib/mcp/descriptions.test.ts`

**interface:**

- `SetupClientEnvironmentInput = z.object({ client: z.enum(['claude-code', 'codex']) }).strict()`。
- `registerClientSetupTool(server: McpServer): void` は `setup_client_environment` を登録し、`schema_version`、`config_version`、`client`、`target_scope`、`setup_instructions`、`guide_markdown`、`assets`、`post_setup_actions` を含むJSON textを返す。
- `target_scope` は `claude-user-config` または `codex-current-repository`。Claude Codeは `CLAUDE_CONFIG_DIR` または `$HOME/.claude` を使う。Codexのrepository rootはcaller側で `git rev-parse --show-toplevel` を実行して解決する。

- [x] **手順1: tool testを先に追加する。** `handleMcpRequest` 経由で両clientを実行し、`project_id` なしの呼び出し、client別scope/action、asset hashを確認する。payload sizeを64 KiB未満とし、`client` 欠落・未知値・余分なfieldを拒否する。
- [x] **手順2: `corepack pnpm exec vitest run tests/lib/mcp/tools.setup.test.ts tests/lib/mcp/server.test.ts` を実行する。** tool欠落とcatalog 17件への更新不足を示すfailureを確認する。
- [x] **手順3: schemaと `src/lib/mcp/tools/setup.ts` を実装する。** generated manifestとclient別の明確なローカル適用手順を返す。MCP add/loginは完了済み、呼び出し側agentがローカル適用、Dashboard上の不足設定は手動、curator PAT手順は適用禁止と案内する。project dataを読まず、`requireProjectAccess` を呼ばない。
- [x] **手順4: `registerMetaTools` からtoolを登録し、server testを16から17 toolsに更新してfocused testsを再実行する。** `tools/list` でsetupの必須引数が `client` のみであることを確認する。statelessとdescription testの既存catalog契約も17 toolsのscopeに合わせて更新する。
- [x] **手順5: toolとtestsを `feat: add MCP client setup tool` でcommitする。**

### Task 3: client guidanceとCloud Run smokeを更新する

**対象ファイル:**

- 変更: `AGENTS.md`
- 変更: `docs/reproduction-spec.md`
- 変更: `docs/post-mcp-setup.md`
- 変更: `skills/long-term-memory/SKILL.md`
- 変更: `.agents/skills/long-term-memory/SKILL.md`
- 変更: `scripts/cloud-run-smoke.ts`
- 変更: `tests/docs/post-mcp-setup.test.ts`
- 変更: `tests/deploy/task8.test.ts`

**interface:**

- canonical skillのtool一覧とguideの接続後手順にsetup toolを掲載する。
- Cloud Run smokeは `{ client: 'codex' }` で `setup_client_environment` を呼び、`project_id` なしでclient、schema version、asset hash、guide内容を検証する。

- [x] **手順1: docsとsmokeの契約testを拡張する。** 17 toolsの一覧、scopeなしsetup call、client別動作、新setup tool descriptionを各testで確認する。
- [x] **手順2: `corepack pnpm exec vitest run tests/docs/post-mcp-setup.test.ts tests/deploy/task8.test.ts` を実行する。** 古いtool数とsmoke coverage不足を示すfailureを確認する。
- [x] **手順3: docsとskillsを更新する。** 接続済みclientからsetup toolを呼び、返却データをclient agentがローカル適用することを説明する。Dashboardの手動操作とmachine-only PATの境界を維持する。`AGENTS.md` と `docs/reproduction-spec.md` では `list_projects` とsetupだけが `project_id` を省略し、他の15 toolsは必須とする。canonical skillとrepository-local skillの両方へtoolを追加する。`node scripts/sync-embedded-docs.mjs` でguideとmanifestを同期する。
- [x] **手順4: `scripts/cloud-run-smoke.ts` を拡張する。** `EXPECTED_TOOLS` にsetupを加え、通常のBearer認証で `project_id` なしのcallを実行する。local fileを書き込まずにmanifest応答を検証し、docs/smoke testsと `node scripts/sync-embedded-docs.mjs --check` を実行する。
- [x] **手順5: docs、smoke、generated outputsを `docs: document MCP client setup tool` でcommitする。**

### Task 4: repository gatesを実行してPRを作成する

**対象:** Task 1–3で変更したファイル。

- [x] **手順1: focused testsを実行する。** setup manifest、setup tool、MCP server catalog、post-MCP docs、deployment smoke contractを確認する。
- [x] **手順2: repository gatesを実行する。** `corepack pnpm test`、`corepack pnpm lint`、`corepack pnpm exec tsc --noEmit`、`NODE_ENV=production corepack pnpm build`、`node scripts/sync-embedded-docs.mjs --check`、`git diff --check`。
- [x] **手順3: 最終diffを確認する。** runtimeの `docs/` 読み込み、client secrets/PAT、意図しない `project_id` 契約変更、元worktreeからの既存変更混入がないことを確認する。独立したwhole-branch reviewを実施する。
- [ ] **手順4: `feature/mcp-client-setup-tool` をpushし、`develop` 向けPRを作成する。** 主な動作、検証結果、deploy後に行うCloud Run smokeを記載し、直接deployしない。

## 検証範囲

認証済みproduction Cloud Run smokeは、PRがmergeされ既存のmain/deploy workflowでdeployされた後にのみ実施する。ローカルtests/buildの成功をproduction MCP endpointへの反映とみなさない。
