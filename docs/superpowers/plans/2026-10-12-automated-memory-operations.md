# 自動記憶運用・共通情報集約 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 出典・見直し日の記録、復元可能な自動棚卸し、日時指定による共通情報の共有projectへの集約を提供する。

**Architecture:** Cloud Runの保存・認可層にrevisionと限定された自動処理操作を追加し、既存GitHub Actionsのself-hosted runnerでClaudeを使う。独立して受け入れられる2つの段階に分け、共有集約は第1段階のrevisionとactive判定を再利用する。

**Tech Stack:** Node.js 22、pnpm 11.1.3、TypeScript、Next.js、Zod、Vitest、Firebase Admin SDK、Firestore、GCS、SQLite、Claude CLI、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-12-automated-memory-review-and-provenance-design.md`

## 全体制約

- 設計書、`docs/reproduction-spec.md`、`AGENTS.md`を実装前に読む。仕様・計画・運用説明は日本語。
- Git Flowの`feature/*`を使い、main/developへの統合はPR経由。実行開始時にusing-git-worktreesで隔離を確保する。
- Cloud Runはscale to zero。Cloud Scheduler、常駐worker、独立した永続telemetry DBを追加しない。
- Markdown本文の正本はGCS、Firestoreはmetadata、SQLiteは再構築可能cache。localは既存のファイル保存契約を維持する。
- `project` 90日、`reference` 180日、`user`/`feedback` 365日、`session`のアーカイブ初期値90日。ownerがproject単位に調整する。
- 取得URLは公開HTTPS/443のみ、redirect最大3回、総時間10秒/URL、展開後本文1 MiB、HTML/plain textのみ。
- 通常MCPクライアントの17 toolsとqueryなしの`POST /api/mcp`を維持する。専用操作は認証済みの自動処理用tool構成だけに登録する。
- 通常projectの自動処理はowner opt-in必須。共有集約はcuratorが読めるprojectを対象とし、書き込みにはcurator UIDのPATと`LTM_MAINTENANCE_TOKEN`を要求する。
- 自動処理は`forget_memory`を使わない。共有上限は40、上限到達時は新規登録を保留。
- 全memory typeを集約元にできるがarchivedは除外。作成日時のUTC半開区間で選択し、手動処理は日次cursorを更新しない。
- credentials、本文、完全URL、raw environment valueを実行ログ・監査へ残さない。実値の`.env`とsecretはcommitしない。

## レビュー重点

1. 手動編集と自動統合の競合で編集を失わないこと → 第1段階タスク2・4のhash/CAS回帰。
2. DNS rebinding、redirect、gzip展開で取得制限を迂回できないこと → 第1段階タスク3の接続先・展開後size回帰。
3. retained GCS objectからarchived/旧版がreindexで再出現しないこと → 第1段階タスク2。
4. 500件超・同一timestamp・途中失敗で共有入力を欠落させないこと → 第2段階タスク1・3。
5. Dashboardからshared gateを迂回しないこと → 第2段階タスク4の復元requestとPAT再検証。

## 分割した計画と順序

1. [第1段階: 出典記録・自動棚卸し・復元](2026-10-12-memory-review-and-provenance.md)。7タスクで通常projectの自動処理を完結させる。
2. [第2段階: 日時指定の共通情報集約](2026-10-12-dated-shared-curation.md)。第1段階のタスク1・2で定義する型・revision基盤を使い、5タスクで既存共有curatorを拡張する。

第1段階を受け入れた後に第2段階を実行する。両方を同時に未完了のままproductionへ有効化しない。各タスクは意味のある失敗テスト、最小実装、成功テスト、小さなcommitの順に進める。

## 計画で固定する接続方式

通常のMCP registryは17 toolsのまま維持する。`LTM_AUTO_MAINTENANCE_TOKEN`をBearerで検証したrequestはmaintenance専用registryを使う。curator PATに`x-ltm-operation-mode: curation`と既存maintenance headerを付けたrequestはcuration専用registryを使う。headerだけでregistryを切り替えず、tool invocationごとに権限を再検証する。自動処理tokenを利用者PATとして扱わない。

Dashboardの通常project復元はowner認可で直接行う。shared復元はFirebaseでcurator UIDを確認してrequestを保存し、既存curator jobがPATとmaintenance tokenで実行する。ブラウザへPAT/maintenance tokenを渡さず、Dashboard操作の状態をpending/succeeded/failedで表示する。

## 設計書との対応

| 設計書 | 実装先 |
|---|---|
| 3 出典・見直し周期・状態 | 第1段階タスク1 |
| 4.2〜4.4 統合・archive・未解決link | 第1段階タスク2・4 |
| 5 出典取得制限 | 第1段階タスク3 |
| 6 専用認可・監査 | 第1段階タスク2・5、第2段階タスク2 |
| 7 revision・reindex・復元 | 第1段階タスク2・6、第2段階タスク4 |
| 8 Dashboard | 第1段階タスク6、第2段階タスク4 |
| 4.1 日時指定共有集約 | 第2段階タスク1〜3 |
| 9 実行・障害・cursor | 第1段階タスク7、第2段階タスク1・3・5 |
| 10〜11 検証・運用 | 両段階の最終タスク |

## 最終受入

- [x] 各段階の対象テスト、全`pnpm test`、`pnpm lint`、`pnpm exec tsc --noEmit`、`NODE_ENV=production pnpm build`を実装時に実行して記録する。
- [x] YAML/JSON構文、shell構文、`git diff --check`を確認した。`docker compose -f .devcontainer/compose.yaml config --quiet`も試したが、この環境のDocker CLIにCompose pluginがなく実行できなかった。runner imageのhealth checkは既存CIの対象とする。
- [x] Dev ContainerのpnpmがpackageManagerの11.1.3に一致するよう修正した。正しいbuild contextからimageを再構築し、Node.js、pnpm、Codex、Git/Flow、gh、gcloud、Firebase、sshd、nc、jq、xzと3つのnamed volume書き込みを検証した。
- [x] 認証情報を使うCloud Run/GCS/Firestore/Claude実環境smokeは別ゲートとして記録する。fake成功を本番動作確認としない。
- [x] 通常17 tools、owner opt-in、専用認証、URL取得、archive/reindex/restore、共有手動期間・cursor・secret非露出を自動テストで確認した。本番有効化前の実環境smokeは別ゲートに残す。
- [x] `AGENTS.md`、再現仕様、運用説明、`.env.example`、curator skillとclient setup配布assetを更新した。skill変更にはwriting-skillsを適用し、生成assetを既存手順で同期した。

## 今回の到達点

第1段階は`10ef659`〜`4146300`で実装済み。第2段階の共通curation・shared restore・workflow・運用資料も実装し、ローカル受入を完了した。Cloud Runへのdeploy、GitHub/self-hosted runner secrets設定、credentialed smoke、PRは未実施。Docker Compose検証はCLI pluginがないため未実行。

実装後の独立レビューで見つかった4件（構造化フィールドの機密filter漏れ、source hash競合の再評価漏れ、target page byte上限、一時restore障害のterminal化）を修正した。再レビューですべて解消し、新たなCritical/Important指摘なし。最終差分で対象回帰テスト24件、全テスト116 files/396 tests、lint、型検査、本番buildを実行して成功を確認した。
