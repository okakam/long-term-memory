# 日時指定の共通情報集約 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** active記憶を作成日時で選択し、日次差分と手動期間指定で汎用知識を`__shared__`へ集約する。

**Architecture:** 既存remote-curationを拡張し、サーバーで入力manifest・page完了・source状態を検証する。cursorは`__shared__`配下に保持し、共有更新は既存curator gateと第1段階のrevision基盤を使う。

**Tech Stack:** TypeScript、Zod、Vitest、Firestore、GCS、MCP、Claude CLI、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-12-automated-memory-review-and-provenance-design.md`

## 全体制約

総合計画`2026-10-12-automated-memory-operations.md`を適用する。第1段階タスク1・2のMemory/MemoryMutationPort/MutationResultを先に実装する。curatorが読める全project・全type（sessionを含む）のactive記憶を入力にする。1件由来でも汎用性と長期価値があれば昇格可能。元memoryへ書き込まない。cap40、forget禁止。

## レビュー重点

- 500件超でsnapshotを打ち切ったまま成功cursorを進めない（タスク1・3）。
- 日付境界・同時刻の複数ID・初回履歴を落とさない（タスク1）。
- snapshot後のarchive、手動編集、membership取消を昇格前に再確認する（タスク2）。
- manual/dry-run/途中FAILで日次cursorを進めない（タスク1・3）。
- shared復元requestを普通のDashboard利用者が作成できず、実行時もPAT gateを満たす（タスク4）。

## ファイル構成・共有契約

新設`src/lib/curation/`の`types.ts`は入力期間/manifest、`window.ts`はUTC検証、`store.ts`はmetadata port、`firestore-store.ts`/`local-store.ts`はcheckpoint、`service.ts`はscan/upsert/checkpointを担当する。既存export scriptはMCP reader＋snapshot整形に限定し、model判定とcursor更新は`run-dated-curation.ts`に分ける。

- `CurationWindow = { from: string|null; to: string; mode:'schedule'|'manual'; dry_run:boolean }`。from/toはUTC ISO、manual日付は厳密なYYYY-MM-DDから生成する。
- `CurationPage = { run_id:string; source_project_id:string; window:CurationWindow; memories:Array<{memory:Memory; content_hash:string}>; next_page:string|null; complete:boolean }`。stable orderはcreated_at, ID。1page最大25件/256 KiB、単体超過は明示errorとしてcursorを止める。
- `CurationOutcome = { source_memory_id:string; source_hash:string; outcome:'promoted'|'no_op'|'skipped'; reason_code:string; shared_memory_id?:string }`。
- `SharedProposal = { operation_id:string; run_id:string; expected_target_hash?:string; source_refs:Array<{project_id:string;memory:string;content_hash:string}>; memory:SaveInput; reason_code:string }`。保存先source_refsは既存project_id/memory形式へ変換する。
- `CurationService.page(projectId:string, runId:string, after?:string): Promise<CurationPage>`、`upsert(proposal:SharedProposal): Promise<MutationResult>`、`complete(projectId:string, runId:string): Promise<{ cursor:string|null; advanced:boolean }>`。

### タスク1: UTC期間・ページング・サーバー管理cursorを実装する

**Files:** Create `src/lib/curation/types.ts`, `src/lib/curation/window.ts`, `src/lib/curation/store.ts`, `src/lib/curation/firestore-store.ts`, `src/lib/curation/local-store.ts`, `src/lib/curation/service.ts`; Modify `src/lib/storage/firestore-metadata.ts`, `firestore.indexes.json`; Test `tests/lib/curation/window.test.ts`, `tests/lib/curation/checkpoint.test.ts`。

**Interfaces:** `parseCurationWindow(input:{from_date?:string;to_date?:string;mode:'schedule'|'manual';dry_run:boolean}, now:string): CurationWindow`、`CurationStore.begin(sourceProjectId:string, window:CurationWindow): Promise<{run_id:string}>`。Firestoreは`projects/_shared/sharedCurationCursors/{sourceProjectId}`と`curationRuns/{runId}`配下(`__shared__`はFirestore予約IDのため`_shared`へ写像)へmanifest/page結果を保存し、本文は保存しない。source projectへcursorを書かない。日時未指定ならbeginで当該projectの前cursorをfromへ補い、cursorなしの場合だけ下限なしにする。

`inWindow(createdAt:string, window:CurationWindow): boolean`をwindow.tsで提供する。初回from=nullは下限なし。CurationStoreはbegin/page結果/outcomes/completeのrecordを扱い、completeは保存済みmanifestと結果をtransactionで照合する。dry-runではbeginも永続保存せず、request間を結ぶ署名付きsnapshot tokenで入力hashを検証する。

FirestoreMetadataStoreへ`listMemoryIndexPage(projectId:string, after?:{created_at:string;id:string}, before?:string, limit?:number): Promise<{items:MemoryIndexRecord[];next:string|null}>`を追加する。gatewayはcreated_atとdocument IDでseekするbounded queryを実装し、必要なindexは`firestore.indexes.json`へ追加する。status条件をDB queryへ入れず、返ったmetadataの欠損statusをactiveと解釈してから除外判定する。全件archivedのpageでもscan位置を進め、途中の空pageを全件完了と誤認しない。

dry-run snapshot tokenは既存maintenance secretを用途別HMAC-SHA256 keyとして使い、run ID、固定window、page位置、source hashを署名する。署名tokenをlogへ出さず、body/hash変更時は再取得する。

- [x] `uses_utc_half_open_window`、`pages_all_records_with_same_timestamp`、`incomplete_run_cannot_advance_cursor`を失敗テストとして追加する。

```ts
expect(inWindow('2026-10-01T00:00:00.000Z', window)).toBe(true);
expect(inWindow('2026-10-02T00:00:00.000Z', window)).toBe(false);
expect(allPages.flatMap(p => p.memories)).toHaveLength(501);
expect(await completeWithMissingPage()).toMatchObject({ advanced:false });
```

- [x] `pnpm exec vitest run tests/lib/curation/window.test.ts tests/lib/curation/checkpoint.test.ts`でFAILを確認する。
- [x] 両日付必須、実在日、from<toを検証する。scheduleはprojectごとの前cursor（初回null＝全active履歴）から固定run開始時刻までをscanする。manual/dry-runはcursorを変えない。pagination cursorをopaqueにし、同じtimestampのIDも全て読む。
- [x] 全pageの全sourceにoutcomeがあることをサーバーで確認してから、scheduleかつwriteのrunだけCASでcursor更新する。未完run再開、重複complete、部分失敗、payload上限、source project追加、status欠損legacyとarchivedだけのpageをPASSにし、`feat: 共有集約の期間とcursorを追加`をcommitする。

### タスク2: curator限定snapshot・安全なshared upsertを追加する

**Files:** Create `src/lib/mcp/tools/curation.ts`; Modify `src/lib/curation/service.ts`, `src/lib/mcp/transport.ts`, `src/lib/mcp/server.ts`, `src/lib/mcp/context.ts`; Test `tests/lib/mcp/curation.test.ts`, `tests/lib/curation/upsert.test.ts`。

**Interfaces:** 専用registryは既存の`list_projects({})`に加え、`curation_snapshot({project_id,view:'sources'|'targets',run_id?,from_date?,to_date?,dry_run,after?})`、`curation_apply({project_id:'__shared__',proposal})`、`curation_checkpoint({project_id:'__shared__',source_project_id,run_id,outcomes?,complete?})`を登録する。sourcesはsource membership read＋shared curator gate、targetsはproject_idが`__shared__`の場合だけshared現行記憶のpageを返してcursorを作らない。apply/checkpointは共有gateをcallごとに検証する。

- [x] `requires_curator_pat_and_maintenance_token`、`rejects_archived_or_changed_source_at_apply`、`keeps_cap_without_forget`を失敗テストとして追加。OAuth・普通PAT・automation token・headerだけは拒否、通常registry17件、archive後source拒否、cap40から新規作成しないことをassertする。
  期待値は`expect(archivedSource.result.isError).toBe(true)`、`expect(sharedActiveCount).toBe(40)`、`expect(forgetSpy).not.toHaveBeenCalled()`。
- [x] `pnpm exec vitest run tests/lib/mcp/curation.test.ts tests/lib/curation/upsert.test.ts`でFAILを確認する。
- [x] `x-ltm-operation-mode: curation`を認証後に扱い、通常の汎用writeを専用registryへ登録しない。source_refsをmanifestへ照合し、現行hash/status/membershipを反映直前に再確認する。target hash競合は再提案、曖昧/矛盾はno-op。共有cap判定とcurrent metadata commitは同一transactionにする。
- [x] equivalentはtargetとsource_refsを統合し、revision保存してupsertする。新規operation_idはsource hashと内容から安定生成し、manual/schedule再実行で重複作成しない。原文にない事実・秘密を昇格させないpromptと構造化根拠検証を追加する。
- [x] cap到達候補は`__shared__`配下のdeferredCandidatesへsource IDs/hashと理由だけを保存する。次回scheduleで期間外でも再評価し、現在のactive/hash/membershipを確認する。保留候補はoutcomeを記録してcursor進行と両立させる。capに空きができた後の昇格とarchive後の保留取消をテストする。
- [x] source_refs、secret候補丸ごと除外、元project無変更、revision保持、source権限取消回帰をPASSにし、`feat: curator専用の日時集約MCP操作を追加`をcommitする。

### タスク3: 日付snapshotとheadless実行を接続する

**Files:** Create `scripts/curator/run-dated-curation.ts`; Modify `scripts/curator/run-curation.sh`, `skills/shared-memory-curator/SKILL.md`; Test `tests/curator/dated-curation.test.ts`, `tests/curator/remote-snapshot.test.ts`, `tests/curator/curator-skill.test.ts`。

**Interfaces:** `runDatedCuration(options:CurationRunnerOptions): Promise<CurationRunSummary>`。第1段階のcallMcpToolを使用し、各source projectを全page処理→outcomes報告→completeの順に実行する。current shared照合も許可されたsnapshot経路で取得する。

CurationRunnerOptionsは`{ client:McpClientOptions; window:CurationWindow; propose:(page:CurationPage,targets:Memory[])=>Promise<SharedProposal[]> }`。CurationRunSummaryはscanned_projects/candidates/created/updated/no_op/deferred/failedの数値。list_projectsで対象を列挙し、targets viewの全pageを取得してからsource pageを処理する。

- [x] `includes_session_but_excludes_archive`、`does_not_advance_after_partial_failure`、`backfill_is_idempotent`を追加し、501件、同一timestamp、空project、途中Claude失敗をfixtureにする。全25件pageが読まれることと不足page時complete呼び出しなしをassertする。
  期待値は`expect(processedIds).toHaveLength(501)`、`expect(processedIds).not.toContain(archivedId)`、`expect(checkpointAfterFailure).toEqual(checkpointBefore)`。
- [x] `pnpm exec vitest run tests/curator/dated-curation.test.ts tests/curator/remote-snapshot.test.ts tests/curator/curator-skill.test.ts`でFAILを確認する。
- [x] 既存maxMemories=500の黙示的打ち切りを廃止する。session無条件除外と上限時forget指示をskillから削除し、sessionからdurable汎用情報のみ昇格するルールへ置き換える。元本文はuntrusted inputとして扱い、modelへ渡すsnapshotはprivate tempだけに置く。
- [x] 第1段階と同じくClaudeはproposalのみを返し、Node runnerがmanifest/source hashへ照合してMCP applyを呼ぶ。Claudeのtool allowlistへwrite/checkpoint操作を追加しない。
- [x] 生Claude stdoutを永続log/GitHub logに流さず、codeで検証したsummaryだけを出力する。dry-runはproposalのみでapply/checkpoint書き込みなし、manual writeも日次cursorなし。処理済みprojectだけschedule cursorをcompleteし、失敗projectは再処理対象に残す。
- [x] 対象テストPASSを確認し、`feat: 日付範囲の共有curator実行を追加`をcommitする。

### タスク4: Dashboardのshared履歴・復元を既存gateへ接続する

**Files:** Create `src/app/api/projects/[id]/maintenance/restore-requests/route.ts`, `src/components/project-management/SharedCurationHistory.tsx`, `src/lib/curation/restore.ts`; Modify `src/lib/mcp/tools/curation.ts`, `scripts/curator/run-dated-curation.ts`, `src/app/dashboard/page.tsx`; Test `tests/app/shared-restore.routes.test.ts`, `tests/lib/curation/restore.test.ts`。

**Interfaces:** `SharedRestoreRequest = { id:string; memory_id:string; revision_id:string; expected_hash:string; requested_by:string; state:'pending'|'succeeded'|'failed' }`。`requestSharedRestore(principal, input): Promise<SharedRestoreRequest>`、`applySharedRestore(requestId:string): Promise<MutationResult>`。専用`curation_checkpoint`のschemaに`restore_requests`読み取り/結果報告actionを追加し、`curation_apply`にrequest IDに紐づくrestore actionを追加する。

- [x] `dashboard_cannot_directly_write_shared`と`restore_rechecks_curator_credentials`を追加。非curator403、curator Firebaseでrequest作成可、普通PAT実行不可、missing revision/手動編集競合でfailed、同request二度適用でrevision重複なしをassertする。
  期待値は`expect(queued.state).toBe('pending')`、`expect(unauthorized.status).toBe(403)`、`expect(requestAfterMissingRevision.state).toBe('failed')`。
- [x] `pnpm exec vitest run tests/app/shared-restore.routes.test.ts tests/lib/curation/restore.test.ts`でFAILを確認する。
- [x] Dashboardはcurator UIDとsame-originを検証してrequestを保存する。既存共有curatorが次のscheduleまたはmanual write実行で、現在のPAT/maintenance tokenを再検証して適用する。dry-runでは適用せず、ブラウザへsecretを返さない。通常project ownerの直接復元は第1段階のAPIを使う。
- [x] UIにpending/成功/失敗と処理時刻を表示する。shared復元が遅延実行であることを運用説明へ明記する。PASS確認後、`feat: shared復元をcurator認可経路へ接続`をcommitする。

### タスク5: workflow入力・運用・最終受入を仕上げる

**Files:** Modify `.github/workflows/curator.yml`, `scripts/curator/env.example`, `scripts/curator/install.sh`, `docs/memory-automation.md`, `docs/reproduction-spec.md`, `AGENTS.md`; Test `tests/deploy/dated-curation.test.ts`, `tests/curator/dated-curation.test.ts`。

**Interfaces:** dispatch inputは`from_date`/`to_date`（任意pair、UTC YYYY-MM-DD）と現行`dry_run`（default true）。scheduleは固定windowで自動反映。既存workflowのself-hosted `ltm-curator`、schedule `0 1 * * *`とsecretゲートを維持する。

- [x] input pair/不正日拒否、schedule自動write、dispatch既定dry-run、concurrency/needs、secret出力なしを失敗テストで固定する。
  期待値は`expect(dispatch.inputs.dry_run.default).toBe(true)`、`expect(remoteJob.needs).toContain('memory-maintenance')`、`expect(schedule.cron).toBe('0 1 * * *')`。
- [x] `pnpm exec vitest run tests/deploy/dated-curation.test.ts tests/curator/dated-curation.test.ts`でFAILを確認する。
- [x] workflowへ期間入力と専用runner/headerを接続する。共有jobへの通常automation token注入を避け、維持するPATとmaintenance tokenだけを使う。初回active全履歴、per-project再試行、manual backfill、cap保留、restore待機の運用手順を記録する。
- [x] skill更新と配布asset同期を行い、総合計画の全ローカル受入を実行して結果を記録する。実環境では日時境界save、session昇格、archive除外、duplicate no-op、cursor failure/retry、shared復元を確認する。資格情報なしの場合は未実行ゲートとして明示する。
- [x] `docs: 日時指定の共通情報集約運用を追加`をcommitし、branch reviewとPR作成へ引き継ぐ。Cloud Runへの反映とcredentialed smokeは未実施の別運用ゲートとして残す。
