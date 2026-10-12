# 出典記録・自動棚卸し・復元 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 出典と見直し日を自動記録し、ownerが有効化したprojectで復元可能な日次棚卸しを実行する。

**Architecture:** 保存serviceに共通の変更契約を追加し、GCS旧版・Firestore操作記録とCASで変更を保護する。制限付きfetcherとClaudeをrunnerで動かし、専用MCP registryからサーバー検証済み操作だけを反映する。

**Tech Stack:** TypeScript、Zod、Vitest、Next.js、Firebase Admin SDK、GCS、SQLite、Node.js HTTPS、Claude CLI。

**Spec:** `docs/superpowers/specs/2026-10-12-automated-memory-review-and-provenance-design.md`

## 全体制約

総合計画`2026-10-12-automated-memory-operations.md`の全体制約を全タスクへ適用する。周期90/180/365日、session archive90日、再試行7日、未解決link30日。旧schemaはactiveとして読めること。本文やgraphを変更せずに日付だけ更新しても操作監査を記録する。

## レビュー重点

- hash変更・opt-in取消後の操作は409相当のtool errorで拒否する（タスク2・5）。
- retention対象objectをrename/reconcile/forgetが誤処理しない（タスク2）。
- 全redirectを含めた10秒と展開後1 MiBを強制する（タスク3）。
- LLMの理由文字列に含まれる本文や秘密が監査へ混入しない（タスク4・7）。
- UIのrole表示とは別に各APIでownerを再確認する（タスク6）。

## ファイル構成と共通契約

新設`src/lib/maintenance/`の`types.ts`は操作・metadata型、`policy.ts`は日時・重複規則、`store.ts`は共通保存port、`firestore-store.ts`/`local-store.ts`はmetadata保存、`mutations.ts`は変更調整、`service.ts`は認可後の業務処理を担当する。source fetcherは`source-fetcher.ts`と`public-address.ts`に分ける。既存の大きなMemoryServiceを一般的なrefactorの対象にせず、必要な保存hookだけを追加する。

- `MaintenanceSettings = { enabled: boolean; review_days: Record<'project'|'reference'|'user'|'feedback', number>; session_archive_days: number; version: number }`。日数は1〜3650の整数、初期enabled=false。
- `MemoryRevision = { id: string; memory_id: string; content_key: string; content_hash: string; created_at: string; operation_id: string; reason_code: string }`。本文は持たない。
- `MutationRequest = { operation_id: string; project_id: string; expected_hashes: Record<string,string>; expected_settings_version?:number; action: MutationAction; reason_code: ReasonCode; now: string }`。maintenance適用ではexpected_settings_versionを必須にする。
- `MutationAction`は`review`（日時とsource取得metadata）、`patch`（本文とgraphを含む明示patch）、`archive`、`merge`（target/source IDsと統合結果）、`prune_links`（対象name配列）、`restore`（memory ID/revision ID）の判別union。`reason_code`はenum。生のLLM理由・URLを永続保存しない。
- `MutationResult = { operation_id: string; outcome: 'applied'|'already_applied'|'conflict'; memory_ids: string[]; revision_ids: string[] }`。
- `MemoryMutationPort.applyMutationAsync(request: MutationRequest): Promise<MutationResult>`、`listRevisionsAsync(projectId: string, memoryId: string): Promise<MemoryRevision[]>`。local/cloud両serviceが同じportを実装する。
- `MaintenancePage = { memories:Array<{memory:Memory;content_hash:string;due:boolean}>; settings_version:number; next_page:string|null }`。`MaintenanceProposal = Omit<MutationRequest,'project_id'|'now'> & { settings_version:number; evidence:Array<{memory_id:string;content_hash:string;start:number;end:number}> }`。時計はサーバーから注入し、tool inputで現在時刻を指定させない。
- `MaintenanceEvent = { operation_id:string; project_id:string; memory_ids:string[]; revision_ids:string[]; action:string; reason_code:ReasonCode; created_at:string }`。ReasonCodeは`confirmed`、`ambiguous`、`fetch_failed`、`exact_duplicate`、`semantic_duplicate`、`expired`、`completed`、`superseded`、`session_aged`、`missing_link`、`restored`、`shared_promoted`のenumとする。
- MutationActionのpayloadはreview/patch/archive/restoreに`memory_id`、patchに`patch:UpdateInput`、mergeに`target_id`/`source_id`/`patch:UpdateInput`、prune_linksに`memory_id`/`names:string[]`を持つ。reviewは`review_state:'confirmed'|'ambiguous'|'fetch_failed'`と検証済みsource metadata、restoreは`revision_id`を持つ。共有新規用に`create`（`input:SaveInput`）もportで扱うが、maintenance toolの提案schemaではcreate/restoreを許可しない。

### タスク1: 後方互換の出典・周期・active状態を保存する

**Files:** Modify `src/lib/memory/types.ts`, `src/lib/markdown/frontmatter.ts`, `src/lib/memory/service.ts`, `src/lib/memory/cloud-service.ts`, `src/lib/mcp/schemas.ts`, `src/lib/mcp/tools/write.ts`, `src/lib/storage/firestore-metadata.ts`; Create `src/lib/maintenance/types.ts`, `src/lib/maintenance/policy.ts`; Test `tests/lib/maintenance/policy.test.ts`, `tests/lib/markdown/frontmatter.test.ts`, `tests/lib/mcp/schemas.test.ts`。

**Interfaces:** `reviewSchedule(type: MemoryType, anchor: string, settings: MaintenanceSettings): { last_reviewed_at: string; next_review_at: string }`、`deriveLegacyReview(memory: Memory, settings: MaintenanceSettings): string`。Memoryにsources/status/review/archive metadataを追加。sourceは`{ kind:'url'|'conversation'; url?:string; captured_at:string; last_checked_at?:string; content_hash?:string }`で判別検証する。

- [ ] 失敗テスト`sets_type_defaults_and_preserves_legacy`を追加する。以下の期待値と、session初回期限がcreated_at由来、legacy URL行とsource_refsを混同しないことを固定する。

```ts
expect(reviewSchedule('project', '2026-01-01T00:00:00.000Z', defaults).next_review_at)
  .toBe('2026-04-01T00:00:00.000Z');
expect(parseMemoryString(legacyMarkdown).status).toBe('active');
expect(roundTrip.source_refs).toEqual(original.source_refs);
```

- [ ] `pnpm exec vitest run tests/lib/maintenance/policy.test.ts tests/lib/markdown/frontmatter.test.ts tests/lib/mcp/schemas.test.ts`を実行し、新規契約に対するFAILを確認する。
- [ ] 型とfrontmatterを実装し、全save入口で出典なしならconversation、reference.urlは構造化出典＋現行URL行を保存する。利用者の本文変更時だけ周期をリセットし、tagだけの変更で確認済み扱いにしない。sessionのarchive期限は本文更新後もcreated_at由来とする。通常のwrite schemaから内部status/revision/operation_idを設定させない。
- [ ] 同じコマンドでPASSを確認し、`feat: 出典と見直し日の保存契約を追加`をcommitする。

### タスク2: 原子的な変更・revision・archive検索を実装する

**Files:** Create `src/lib/maintenance/store.ts`, `src/lib/maintenance/firestore-store.ts`, `src/lib/maintenance/local-store.ts`, `src/lib/maintenance/mutations.ts`; Modify `src/lib/memory/service.ts`, `src/lib/memory/cloud-service.ts`, `src/lib/memory/singleton.ts`, `src/lib/memory/reconcile.ts`, `src/lib/memory/kg.ts`, `src/lib/db/schema.sql`, `src/lib/db/connection.ts`, `src/lib/storage/firestore-metadata.ts`, `src/lib/storage/reconcile-objects.ts`; Test `tests/lib/maintenance/mutations.test.ts`, `tests/lib/memory/cloud-service.test.ts`, `tests/lib/memory/service.reconcile.test.ts`, `tests/storage/atomic-failure.test.ts`。

**Interfaces:** 上記MemoryMutationPort。`MaintenanceStore.getSettings(projectId): Promise<MaintenanceSettings>`、`saveSettings(projectId, settings, expectedVersion): Promise<MaintenanceSettings>`、`listEvents(projectId, after?, limit?): Promise<MaintenanceEvent[]>`。metadata commitはoperation、revision pointer、current memory/name indexを同一Firestore transactionで更新する。mergeは最大2 memoryの変更を一単位とする。

- [ ] 失敗テスト`preserves_revision_and_rejects_stale_hash`、`retry_does_not_duplicate_revision`、`reindex_keeps_archive_hidden`を追加。hash競合で本文不変、GCS旧key存続、同じoperation_id二度適用でrevision数不変、archive後のFTS/KG/listに戻らないことをassertする。
  テストの期待値は`expect(replayed.outcome).toBe('already_applied')`、`expect(currentHash).toBe(manualEditHash)`、`expect(searchResults.map(m=>m.id)).not.toContain(archivedId)`。
- [ ] `pnpm exec vitest run tests/lib/maintenance/mutations.test.ts tests/lib/memory/cloud-service.test.ts tests/lib/memory/service.reconcile.test.ts tests/storage/atomic-failure.test.ts`を実行してFAILを確認する。
- [ ] GCS新objectを先にimmutable writeし、transactionで現在hashとoperation payload hashを検証してcommitする。maintenance操作では同じtransactionでenabledとsettings_versionを再確認する。失敗時は未参照の新objectだけをcleanupし、旧revision objectを削除しない。SQLite更新失敗時はcache再構築扱いにし、正本commit済み操作を再適用しない。localはproject lock、atomic fileとoperation journalで同じ契約にする。
- [ ] statusと見直し日時をSQLiteへ追加し、通常search/list/tag/related/KGはactiveに限定する。明示getはstatusを返せる。reindexはcurrent metadata pointerだけを使い、retained revisionを現行memoryとして取り込まない。rename後もrevision参照keyを保護する。restoreは過去本文を新しい現行name/IDで保存する。
- [ ] 手動forgetはrevision本文も削除し、全対象keyへtombstoneを記録する。forget後のrestoreは404とし、復活を防ぐ。正常updateやrenameでもrevision参照objectをcleanupしない。
- [ ] 故障注入テストを加え、GCS失敗、Firestore失敗、cache失敗、rename後restore、欠損revision、同一ID別payload拒否をPASSにし、`feat: 記憶変更履歴と復元可能なアーカイブを追加`をcommitする。

### タスク3: 公開HTTPS出典を制限付きで取得する

**Files:** Create `src/lib/maintenance/public-address.ts`, `src/lib/maintenance/source-fetcher.ts`; Test `tests/lib/maintenance/source-fetcher.test.ts`。

**Interfaces:** `fetchPublicSource(url: string, deps?: SourceFetchDependencies): Promise<SourceFetchResult>`。成功は`{ status:'ok'; text:string; content_hash:string; checked_at:string }`、失敗は`{ status:'failed'; reason_code: FetchFailureCode; checked_at:string }`。depsにclock、DNS resolver、HTTPS connection factoryを注入できるようにする。

FetchFailureCodeは`unsupported_url|blocked_address|redirect_limit|timeout|size_limit|content_type|http_error|network_error|parse_error`。SourceFetchDependenciesは`now:()=>number`、`resolve:(host:string)=>Promise<Array<{address:string;family:4|6}>>`、`request:(options:https.RequestOptions)=>https.ClientRequest`を持つ。factoryでNode.js clock/resolver/requestを既定にし、テストはfakeを注入する。

- [ ] 失敗テスト`blocks_redirect_and_rebinding`、`limits_total_time_and_decoded_bytes`を追加する。private/mixed A+AAAA、IPv4 mapped IPv6、IP literal、userinfo、443以外、HTTPS→HTTP、4回目redirectを拒否する。10,000msの総期限と1,048,577byteの展開後本文を拒否することをassertする。
  期待値は`expect(redirectToPrivate).toMatchObject({status:'failed',reason_code:'blocked_address'})`、`expect(tooLarge.reason_code).toBe('size_limit')`、`expect(expired.reason_code).toBe('timeout')`。
- [ ] `pnpm exec vitest run tests/lib/maintenance/source-fetcher.test.ts`でFAILを確認する。
- [ ] Node.jsのDNS/HTTPS/zlibを使い、全解決先がpublicなことを確認して接続IPを固定する。TLSのhostname検証とSNIはURLのhostを使う。全redirectを同じdeadlineで追跡し、stream展開後にsizeを制限する。content-typeはtext/htmlとtext/plain（charset parameter可）、HTMLはscriptを実行せずtextへ変換する。本文・URLを例外やlogへ埋め込まない。
- [ ] HTML中の命令が実行されないfixtureとtimeout/stream中断回帰をPASSにし、`feat: 出典の安全なHTTPS取得を追加`をcommitする。

### タスク4: 棚卸し判断を検証して操作へ変換する

**Files:** Create `src/lib/maintenance/service.ts`, `proposal.ts`; Modify `src/lib/maintenance/policy.ts`; Test `tests/lib/maintenance/service.test.ts`, `tests/lib/maintenance/proposal.test.ts`。

**Interfaces:** `MaintenanceService.snapshot(projectId: string, now: string, after?: string): Promise<MaintenancePage>`、`apply(projectId: string, proposal: MaintenanceProposal): Promise<MutationResult>`。pageはactive memoryとhash、settings_version、due状態、next_pageを持つ。proposalはoperation、expected_hashes、action、enum理由、根拠memory ID/hashと本文引用範囲を持つ。

- [ ] 失敗テスト`merges_only_compatible_memories`、`archives_sessions_after_configured_age`、`removes_links_after_30_days_missing`を追加する。最古created_at/IDでtarget選択、metadata union、同種別の無矛盾統合、矛盾・架空根拠・無関係引用の拒否、30日未満の未来link維持をassertする。
  期待値は`expect(before30.links).toContain('future-memory')`、`expect(after30.links).not.toContain('future-memory')`、`expect(conflictingMerge.outcome).toBe('conflict')`。
- [ ] `pnpm exec vitest run tests/lib/maintenance/service.test.ts tests/lib/maintenance/proposal.test.ts`でFAILを確認する。
- [ ] 完全重複と日時条件はcodeで判定する。意味的統合・出典置換はClaudeの構造化提案を受け、引用の実在、hash一致、対象scope、graph整合、理由enum、許可actionを検証する。意味の含意をhashだけで保証できるとは扱わず、矛盾/低確信/根拠なしは本文を変えず7日retryにする。
- [ ] fetch失敗はlast_reviewed_atを進めず7日retry、曖昧判断はlast_reviewed_at更新＋7日retry、有効なら種別周期を更新する。link未解決first_seenはmetadataに置き、解決時に解除する。archive対象にも変更前revisionを保持する。
- [ ] settings変更、injection本文、監査reasonに生の本文を渡す提案の拒否をPASSにし、`feat: 自動棚卸しの適用規則を追加`をcommitする。

### タスク5: 専用MCP registryと毎回のopt-in認可を追加する

**Files:** Create `src/lib/maintenance/auth.ts`, `src/lib/mcp/tools/maintenance.ts`; Modify `src/lib/mcp/transport.ts`, `src/lib/mcp/context.ts`, `src/lib/mcp/server.ts`, `src/lib/mcp/session.ts`; Test `tests/lib/mcp/maintenance.test.ts`, `tests/lib/mcp/server.test.ts`, `tests/lib/mcp/stateless.test.ts`。

**Interfaces:** `requireAutomationCredential(req: Request): Promise<AutomationCredential>`は専用Bearerをconstant-timeで検証する。`AutomationCredential = { kind:'maintenance' }`を通常McpPrincipalと区別する。registryは`maintenance_list_projects({})`、`maintenance_snapshot({project_id,after?})`、`maintenance_apply({project_id,proposal})`だけを登録する。

- [ ] 失敗テスト`normal_registry_stays_17`、`automation_cannot_call_generic_write`、`opt_out_revokes_inflight_apply`を追加する。

```ts
expect(normalTools).toHaveLength(17);
expect(automationTools.map(t => t.name)).not.toContain('forget_memory');
expect((await applyAfterOwnerDisabled()).result.isError).toBe(true);
```

- [ ] `pnpm exec vitest run tests/lib/mcp/maintenance.test.ts tests/lib/mcp/server.test.ts tests/lib/mcp/stateless.test.ts`でFAILを確認する。
- [ ] 自動tokenは通常PAT/OAuthとして受理しない。snapshot/applyの各callでproject存在、enabled、settings_versionを再検証する。`__shared__`と任意projectへの汎用書き込みは拒否する。HTTP401と認証済みtool error HTTP200の区別を維持する。local-sessionもmode/credential間でregistryやcontextを再利用しない。
- [ ] 通常PAT/OAuth、curator token、無効/取消token、project query拒否、前request principal混入なしをPASSにし、`feat: 自動メンテナンス専用MCP操作を追加`をcommitする。

### タスク6: owner設定・履歴・復元をDashboardへ追加する

**Files:** Create `src/app/api/projects/[id]/maintenance/route.ts`, `src/app/api/projects/[id]/maintenance/history/route.ts`, `src/app/api/projects/[id]/maintenance/restore/route.ts`, `src/components/project-management/MaintenancePanel.tsx`; Modify `src/components/project-management/ProjectManagementPanel.tsx`, `src/app/dashboard/page.tsx`; Test `tests/app/maintenance.routes.test.ts`, `tests/components/maintenance-panel.test.ts`。

**Interfaces:** settings GET/PATCHはMaintenanceSettings、history GETはpage付きevents/revisions、restore POSTは`{ memory_id, revision_id, expected_hash, operation_id }`。通常projectの設定/復元はowner-only、CSRFを既存same-origin guardで検証する。shared履歴GETはcurator UID限定、shared復元requestは第2段階で追加する。

- [ ] 失敗テスト`member_cannot_change_or_restore`と`owner_can_restore_archived_memory`を追加。非owner403、無認証401、不正日数400、hash競合409、historyに本文なし、disabled初期値をassertする。
  期待値は`expect(memberResponse.status).toBe(403)`、`expect(restored.status).toBe('active')`、`expect(history.revisions[0]).not.toHaveProperty('body')`。historyには復元用current_hashを返し、content_keyを返さない。
- [ ] `pnpm exec vitest run tests/app/maintenance.routes.test.ts tests/components/maintenance-panel.test.ts`でFAILを確認する。
- [ ] 設定・実行状況・archive一覧・revision選択を実装する。POST/PATCH直前にFirestore membershipを再確認し、localは合成UIDを使う。UIの待機/成功/エラーを表示し、tokenや内部GCS keyをブラウザへ返さない。日数変更は次のsnapshotで期限を再計算し、未処理提案はsettings_version競合で破棄する。
- [ ] 対象テストPASSを確認し、`feat: Dashboardの自動棚卸し設定と復元を追加`をcommitする。

### タスク7: runner・workflow・運用と受入を接続する

**Files:** Create `scripts/curator/run-maintenance.ts`, `scripts/curator/mcp-client.ts`, `docs/memory-automation.md`; Modify `.github/workflows/curator.yml`, `scripts/curator/env.example`, `.env.example`, `skills/shared-memory-curator/SKILL.md`, `docs/reproduction-spec.md`, `docs/cloud-run-production-deployment.md`, `AGENTS.md`, `scripts/cloud-run-smoke.ts`; Test `tests/curator/maintenance-runner.test.ts`, `tests/deploy/memory-maintenance.test.ts`, `tests/curator/curator-skill.test.ts`。

**Interfaces:** `runMaintenance(options: RunnerOptions): Promise<RunSummary>`はsnapshot全ページを処理し、fetcher結果＋memory必要部分をClaudeへ渡し、構造化proposalを専用MCPで反映する。共通`callMcpTool<T>(options, name, args): Promise<T>`はerror/size/timeoutを検証し、本文をlogしない。

`McpClientOptions = { baseUrl:string; bearerToken:string; headers?:Record<string,string>; fetcher?:typeof fetch }`、`RunnerOptions = { client:McpClientOptions; dry_run:boolean; now:()=>string; fetchSource:typeof fetchPublicSource; propose:(page:MaintenancePage,sourceResults:Record<string,SourceFetchResult>)=>Promise<MaintenanceProposal[]> }`。sourceResultsのkeyはmemory IDとsource配列index。RunSummaryはscanned_projects/applied/skipped/failedの数値のみ。fetch結果をproposalへ付加するのはrunner codeであり、Claudeが返したURL取得結果やhashを信頼しない。

- [ ] 失敗テスト`dry_run_has_no_mutations`、`workflow_serializes_jobs`、`stdout_contains_only_summary`を追加。Claudeが本文/secretをstdoutへ出してもGitHub logへ転送されないこと、project単位の失敗をまとめることをassertする。
  期待値は`expect(applySpy).not.toHaveBeenCalled()`、`expect(publicStdout).not.toContain(secretFixture)`、`expect(summary.failed).toBe(1)`。
- [ ] `pnpm exec vitest run tests/curator/maintenance-runner.test.ts tests/deploy/memory-maintenance.test.ts tests/curator/curator-skill.test.ts`でFAILを確認する。
- [ ] runnerにはRead以外の汎用shell/write/toolを与えず、snapshot/temp/stdoutはmode600、終了時cleanupとする。生Claude出力をcatせず、codeでschema検証した件数とreason_codeだけを出力する。scheduleは自動反映、dispatchはdry_run=true。workflow concurrencyでrunを排他し、job依存で通常棚卸し→共有curationを順に実行する。shared jobは`always() && !cancelled()`で先行jobの部分失敗後にも実行できるようにする。
- [ ] Claudeは構造化proposalの出力だけを担当し、MCP writeはtrusted Node runnerが検証後に呼ぶ。外部出典を根拠にするpatchはrunner保有の取得text/hashに引用を照合してから適用し、modelが返す取得済みという自己申告は受け入れない。
- [ ] `LTM_AUTO_MAINTENANCE_TOKEN`をCloud Run Secret ManagerとGitHub secretへ設定する手順を文書化する。稼働前に旧curatorのforget allowlistと上限時forget指示を取り除く。deploy設定のsecret参照を追加しても実secretは作成しない。
- [ ] 対象テストと総合計画のローカル受入を実行して記録する。Cloud smokeにopt-in→save→review→archive→reindex→restore→opt-outを追加し、資格情報がなければ実環境を未実行として残す。
- [ ] `docs: 自動棚卸しの運用と受入手順を追加`をcommitし、第1段階をレビュー可能な状態にする。
