# 自動棚卸し・共通記憶集約の運用

## 実行の流れ

GitHub Actionsの`curator` workflowが毎日01:00 UTCに動き、同じself-hosted `ltm-curator` runner上で通常projectの自動棚卸しを実行してから、全projectの共通記憶集約を実行します。workflow単位のconcurrencyで二重実行を防ぎます。通常棚卸しにproject単位の失敗があっても、共有集約jobは続行します。

通常projectの棚卸しはDashboardでownerが有効化したprojectだけを対象にします。初期値はdisabledです。Dashboardではmemory type別review周期とsession archive日数をprojectごとに変更できます。`__shared__`は通常棚卸しの対象外です。

通常棚卸しrunnerは`LTM_AUTO_MAINTENANCE_TOKEN`で専用MCP registryへ接続します。Claudeは読み取り専用のprivate snapshotを確認してproposalだけを返し、trusted Node runnerがschema、memory hash、出典引用を検証してから`maintenance_apply`を呼びます。公開URLを取得する場合はHTTPS、公開IP、最大3回redirect、10秒、展開後1 MiBの制限を適用します。生のmodel出力、本文、URL、tokenはActions logへ書きません。

共通記憶集約はcurator PATと`LTM_MAINTENANCE_TOKEN`を使用します。`LTM_AUTO_MAINTENANCE_TOKEN`は通常projectの3つのmaintenance tools専用で、shared write権限を持ちません。共通集約はsource projectのactive記憶だけを読み、sessionを含む全typeを候補にできます。元記憶は変更せず、共通記憶には`source_refs`を残します。共有上限40件に達した候補は保留し、既存記憶を完全削除して枠を作ることはありません。

## 手動実行

GitHub Actionsで`curator` workflowを開き、`Run workflow`を選びます。`dry_run`はtrueが既定です。期間指定は日時集約runnerの入力として、UTC `YYYY-MM-DD`の`from_date`と`to_date`を両方指定します。範囲は`from_date`当日00:00 UTCを含み、`to_date`当日00:00 UTCを含まない半開区間です。片方だけの指定や存在しない日付は拒否します。

手動write実行でも日次cursorは変更しません。dry-runはproposal作成までで、MCP writeとcursor更新を行いません。スケジュール実行だけが完了したprojectのcursorを進めます。再実行やbackfillは同じsource hashを重複登録しない設計です。

## Secret設定

自動棚卸し専用tokenはランダムな長いsecretを1つ生成し、同じ値をCloud Run Secret ManagerとGitHub repository secretに登録します。値をrepository、`.env`、issue、workflow logへ貼らないでください。

1. Secret Managerにtoken値を登録し、Cloud Run runtime service accountへ対象secretの`Secret Manager Secret Accessor`を付与します。
2. GitHub repository secret `LTM_AUTO_MAINTENANCE_TOKEN`に同じ値を登録します。curator workflowの通常棚卸しjobだけが読みます。
3. GitHub production Environment variable `GCP_SECRET_LTM_AUTO_MAINTENANCE_TOKEN`にSecret Managerのsecret名を登録します。
4. Production deploy後、Cloud Run revisionの`LTM_AUTO_MAINTENANCE_TOKEN`がSecret Manager version `latest`を参照していることを確認します。token値を画面やlogから読み返しません。

従来のshared curator PATと`LTM_MAINTENANCE_TOKEN`は別credentialのままにします。通常棚卸しjobへ共有maintenance tokenやcurator PATを渡しません。PAT失効やtoken rotation時はGitHub secretとSecret Managerのversionを同じ更新作業で切り替えます。

## 履歴と復元

Dashboardのproject管理からownerが自動棚卸し設定、最新処理status、archive、revisionを確認できます。復元はrevisionを選択して実行します。設定更新はversion競合を検出し、記憶復元は現在hash競合をHTTP 409で返します。shared履歴はcurator UIDだけが読め、shared memoryの復元requestは別のcurator認可経路で扱います。

履歴APIはevent、revision hash、operation ID、memory ID、理由コードだけを返します。本文、source URL、GCS object keyはブラウザへ返しません。自動棚卸しと共通集約は完全削除を行いません。利用者による手動の完全削除は従来どおりです。

## 失敗の確認

- `memory-maintenance` jobのsummaryはproject数、適用数、skip数、失敗数だけを出します。`failed`が1以上ならjobを失敗扱いにし、shared curation jobは続行します。
- `remote-curation`が失敗した場合、日次cursorは未完了projectで進みません。次回scheduleで再試行します。
- URL取得の失敗・曖昧な根拠・矛盾は候補を変更せず、再確認予定にします。
- `LTM_AUTO_MAINTENANCE_TOKEN`が欠落・無効なら通常棚卸しjobが失敗します。共有集約tokenの代替にはしません。
- runnerのraw Claude stdoutやstderrはlogへ出しません。原因調査にはsafe summary、Actions job status、memory IDと監査eventを使います。

## ローカル受入

```bash
pnpm exec vitest run tests/curator/maintenance-runner.test.ts tests/deploy/memory-maintenance.test.ts tests/curator/curator-skill.test.ts
pnpm test
pnpm lint
pnpm exec tsc --noEmit
NODE_ENV=production pnpm build
```

Cloud Run/Firebase/GCS/Firestoreの実環境smokeは、GitHub secrets、opt-in smoke project、Firebase identity、GCP IAMの設定後に行います。repository内のテスト成功を実環境受入完了として扱いません。
