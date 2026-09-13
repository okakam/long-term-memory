# Task 10 実施報告

実施日: 2026-09-13

## 結果

Task 10 のローカル検証、clean reindex 訓練、運用資料、評価証跡を更新した。認証付き Vercel smoke と実プロバイダ fault injection は、必要な資格情報と隔離環境が未提供のため実行していない。これらを成功として記録していない。

## 変更ファイル

- `.gitattributes`: global `core.autocrlf=true` の checkout でも、hook、curator wrapper、embedded-doc generator、生成先 docs を LF として扱うよう固定した。
- `claude-config/hooks/ltm-init-reminder.sh`
- `scripts/curator/run-curation.sh`
- `scripts/sync-embedded-docs.mjs`
- `docs/post-mcp-setup.md`: 上記の LF 正規化と embedded docs 同期。意味上の契約変更はない。
- `docs/vercel-operations.md`: Marketplace provisioning、完全認証 smoke、実プロバイダ耐障害性、curator scheduling の手順と前提を追記した。
- `docs/eval/vercel-smoke.json`: 実行済みローカル証跡と、未実行外部チェックの正確な前提を記録した。
- `docs/superpowers/plans/2026-09-05-vercel-long-term-memory.md`: clean reindex、運用文書化、自己レビューだけを証拠に基づき完了へ更新し、検証記録を追記した。テスト数不一致のため手順 1 は未チェック、外部手順 3/4 も未チェックのままとした。

ユーザー所有の `.devcontainer/README.md` と `.devcontainer/compose.yaml` は変更していない。

## 実行コマンドと結果

| Command | Result |
| --- | --- |
| `pnpm test`（昇格環境、修正前） | 64/65 suite、168/171 tests。global `core.autocrlf=true` が LF の shell/docs を CRLF にし、bash parse、embed check、LF 固定文字列契約が失敗。 |
| `pnpm vitest run tests/docs/post-mcp-setup.test.ts`（昇格環境、LF 属性/同期後） | 1 suite、3 tests passed。 |
| `pnpm tsx /tmp/task-10-clean-reindex.ts` | 3 memory を copied Markdown objects から再構築。tags、links、entities、triples、`body_chars`、supersession が一致。 |
| `pnpm vitest run tests/storage/atomic-failure.test.ts tests/lib/lock/project-lock.test.ts tests/lib/memory/vercel-service.test.ts tests/lib/mcp/vercel-stateless.test.ts tests/lib/telemetry/recorder.test.ts` | 5 suites、21 tests passed。 |
| `pnpm test`（最終） | 65 suites、171 tests passed。 |
| `pnpm lint` | passed。 |
| `pnpm exec tsc --noEmit` | passed。 |
| `NODE_ENV=production pnpm build` | passed。 |
| `node -e "JSON.parse(...)"` | `docs/eval/vercel-smoke.json` is valid JSON。 |
| `node scripts/sync-embedded-docs.mjs --check` | passed（embedded docs drift なし）。 |
| `bash -n claude-config/hooks/ltm-init-reminder.sh` / `bash -n scripts/curator/run-curation.sh` | passed。 |
| `git diff --check` | passed。 |

## 未実行チェックと理由

- 認証付き Vercel Preview E2E smoke: Preview URL、owner/member PAT、curator PAT、maintenance token、Clerk test session、対象 project membership が未提供。initialize/16 tools/save/search/read/delete/UI/API/telemetry/shared gate は実行していない。
- 実プロバイダ耐障害性: Blob failure、Turso transient failure、Redis lock contention、Function instance change とログ/telemetry 実査には隔離された Vercel/Turso/Blob/Upstash 環境と資格情報が必要。ローカル契約テストを代替の外部成功として扱っていない。
- Turso remote probe: remote URL/token が未提供。ローカル libSQL テストを remote gate 成功として扱っていない。

## 自己レビューと懸念

- `docs/reproduction-spec.md` の §1–§19 は Task 0–10 のスコープで対応することを確認した。Task 10 ブロックに未解決 placeholder はない。規範要件は変更していない。
- 再現仕様書は 69 test files と記すが、最終 `pnpm test` は 65 test files/suites を報告した。この不一致は未解決で、Task 10 手順 1 を完了にしていない。
- `.gitattributes` は発見した global autocrlf 起因の bash/embedded-doc failure をリポジトリ側で再発防止するための限定的な変更である。

## Commit IDs

この Task 10 作業ではコミットしていない。
