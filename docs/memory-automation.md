# 自動棚卸し・共通記憶集約の運用

## 実行の流れ

日次実行はローカルの定期実行(Linuxはsystemd user timer、macOSはlaunchd)で行います。毎日01:00 UTCに`scripts/curator/run-curation.sh`が通常projectの自動棚卸し(`run-maintenance.ts`)を実行してから、curator principalから読めるprojectの共通記憶集約(`run-dated-curation.ts`)を実行します。通常棚卸しが失敗しても共有集約は実行し、全体は失敗で終えます。各stepには専用credentialだけを渡し、通常棚卸しへcurator PATと`LTM_MAINTENANCE_TOKEN`を、共有集約へ`LTM_AUTO_MAINTENANCE_TOKEN`を渡しません。

curatorはGitHub Actionsで実行しません。このrepositoryはpublicで、self-hosted runnerを登録すると外部PRのworkflowがrunner上で任意のcodeを実行できるためです。ローカルではログイン済みの`claude` CLI(サブスクリプション)を使い、Anthropic API keyは使いません。wrapperは`~/.local/state/ltm-curator/run.lock`で定期実行と手動実行の重複を防ぎます。

通常projectの棚卸しはDashboardでownerが有効化したprojectだけを対象にします。初期値はdisabledです。Dashboardではmemory type別review周期とsession archive日数をprojectごとに変更できます。`__shared__`は通常棚卸しの対象外です。

通常棚卸しrunnerは`LTM_AUTO_MAINTENANCE_TOKEN`で専用MCP registryへ接続します。Claudeは読み取り専用のprivate snapshotを確認してproposalだけを返し、trusted Node runnerがschema、memory hash、出典引用を検証してから`maintenance_apply`を呼びます。公開URLを取得する場合はHTTPS、公開IP、最大3回redirect、10秒、展開後1 MiBの制限を適用します。生のmodel出力、本文、URL、tokenはActions logへ書きません。

共通記憶集約はcurator PATと`LTM_MAINTENANCE_TOKEN`を使用し、通常棚卸し用`LTM_AUTO_MAINTENANCE_TOKEN`は使いません。専用curation registryは4 toolsだけを公開し、PATのUIDとmaintenance tokenをrequestごとに確認します。source projectのactive記憶を作成日時順に25件ずつ全page読み、sessionを含む全typeを候補にします。archivedは除外し、反映時にも現在statusとhashを確認します。Claudeはprivate temporary snapshotからJSON proposalだけを返し、MCP書き込みtoolは使えません。Node runnerがschema、source manifest、引用範囲、hash、capを確認してから反映します。source memoryとproposal memoryの全フィールドを共有前に機密情報filterへ通します。元記憶は変更せず、共通記憶には`source_refs`を残します。共有上限40件に達した候補はID/hashだけを保留領域へ記録し、次の日次実行で再評価します。反映時にsource hashが変わった候補も現在のactive記憶とhashで保留し、次回以降に再評価します。既存記憶を完全削除して枠を作ることはありません。

日次cursorはprojectごとに`__shared__`配下のFirestore metadataへ保存します。初回はactive記憶の全履歴、以後は前回cursorから固定されたrun開始時刻までを処理します。本文をcursor/manifestへ保存しません。各pageのsource hashに対する全outcomeを記録し、全pageのsnapshotとoutcomeが完了したschedule runだけがcursorを進めます。途中失敗時はそのprojectを未完了のまま残し、次回runで再試行します。

## 手動実行

ローカルでは`DRY_RUN=1 GITHUB_EVENT_NAME=workflow_dispatch ~/.local/libexec/ltm-curator/run-curation.sh`のように環境変数で上書きして実行します。設定ファイルの値より実行時の`DRY_RUN`が優先されます。`GITHUB_EVENT_NAME`を`schedule`以外にすると手動実行扱いになり、日次cursorを更新しません。手動実行は書き込みを避けるため`DRY_RUN=1`から始めてください。共有集約の期間を指定する場合、UTC `YYYY-MM-DD`の`FROM_DATE`と`TO_DATE`を両方指定します。範囲は`FROM_DATE`当日00:00 UTCを含み、`TO_DATE`当日00:00 UTCを含まない半開区間です。片方だけの指定や存在しない日付、空範囲は拒否します。空欄の場合は初回全履歴（以後は日次cursor）を基準とします。

手動write実行でも日次cursorは変更しません。dry-runはproposal作成までで、MCP write、outcome checkpoint、cursor更新を行いません。スケジュール実行だけが完了したprojectのcursorを進めます。再実行やbackfillは安定したoperation IDと`source_refs`で重複登録を避けます。project単位でsnapshot・Claude・applyに失敗した場合、そのprojectのcursorは進めません。

## ローカル定期実行

Linuxでは`systemd/ltm-curator.service`と`systemd/ltm-curator.timer`、macOSでは`launchd/com.user.ltm-shared-curator.plist`を使います。`install.sh`が`uname`で選び、`LTM_CURATOR_SCHEDULER=systemd|launchd`で上書きできます。runnerはinstall時のrepository checkoutのcodeを実行するため、mainを追う専用checkoutからinstallし、更新時は`git pull`と`pnpm install --frozen-lockfile`の後にinstall scriptを再実行してください。

### Linux(systemd user timer)

本番Cloud Runへ接続する場合は`LTM_MODE=remote`とし、設定ファイルへ`MCP_PUBLIC_URL`、curator UIDのPAT(`LTM_MCP_TOKEN`)、`LTM_MAINTENANCE_TOKEN`、`LTM_AUTO_MAINTENANCE_TOKEN`を設定します。後者2つはSecret Managerの`ltm-maintenance-prod`、`ltm-auto-maintenance-prod`と同じ値です。値を画面やlogへ出さず、設定ファイルは`chmod 600`にします。`CLAUDE_BIN`はログイン済みClaude CLIの絶対pathとし、`LTM_CURATOR_PATH`にnode・pnpm・claudeのdirectoryを含めます。

```bash
CLAUDE_BIN="$(command -v claude)" scripts/curator/install.sh
systemctl --user daemon-reload
systemctl --user enable --now ltm-curator.timer
systemctl --user list-timers ltm-curator.timer
```

timerは毎日01:00 UTC(日本時間10:00)に実行し、`Persistent=true`により停止中に過ぎた実行は次回起動後に1回実行します。ログアウト中も動かすには`loginctl enable-linger "$USER"`を有効にします。結果は`~/.local/state/ltm-curator/systemd.{out,err}.log`と`journalctl --user -u ltm-curator.service`で確認し、すぐ試す場合は`systemctl --user start ltm-curator.service`を使います。

### macOS(launchd)

macOSでは日次curationをユーザーのローカルMCPまたはCloud Runへ接続できます。repositoryの依存関係をinstallし、`.env.example`と同じローカルserver設定でMCP serverを起動してください。設定ファイルを用意します。

```bash
mkdir -p "$HOME/.config/ltm-curator"
cp scripts/curator/env.example "$HOME/.config/ltm-curator/env"
chmod 600 "$HOME/.config/ltm-curator/env"
```

`LTM_MODE=local`では接続先を`localhost`、`127.0.0.1`、`[::1]`に限定します。`LTM_MAINTENANCE_TOKEN`にはローカルserverの同名設定と同じ値を入れ、Claude CLIの絶対pathを`CLAUDE_BIN`へ、`pnpm`とClaude CLIを含むdirectoriesを`LTM_CURATOR_PATH`へ設定してください。local modeではPATを使わず、`LTM_MCP_TOKEN`は空欄のままで構いません。

初期状態の`DRY_RUN=1`は読み取り・proposal生成だけを行います。自動書き込みを有効にする場合は、設定ファイルで`DRY_RUN=0`に変更し、`CLAUDE_BIN`を指定して次を実行します。

```bash
CLAUDE_BIN="$(command -v claude)" scripts/curator/install.sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.user.ltm-shared-curator.plist"
```

launchdはmacOSのローカル時刻10:00に実行します。変更後にrunnerを更新するときはinstall scriptを再実行し、既存LaunchAgentをbootoutしてからbootstrapし直してください。Cloud Runを使う`LTM_MODE=remote`ではHTTPSの`MCP_PUBLIC_URL`、curator UIDのPAT、`LTM_MAINTENANCE_TOKEN`が必要です。GitHub Actionsのscheduleは毎日01:00 UTCにwrite実行し、manual dispatchはdry-runが既定です。

## Secret設定

自動棚卸し専用tokenはランダムな長いsecretを1つ生成し、同じ値をCloud Run Secret Manager、GitHub repository secret(Cloud Run smoke用)、ローカルcuratorの設定ファイルに登録します。値をrepository、`.env`、issue、workflow logへ貼らないでください。

1. Secret Managerにtoken値を登録し、Cloud Run runtime service accountへ対象secretの`Secret Manager Secret Accessor`を付与します。
2. GitHub repository secret `LTM_AUTO_MAINTENANCE_TOKEN`に同じ値を登録します。Cloud Run deploy後のsmokeだけが読みます。ローカルcuratorの設定ファイル(`~/.config/ltm-curator/env`)にも同じ値を設定します。
3. GitHub production Environment variable `GCP_SECRET_LTM_AUTO_MAINTENANCE_TOKEN`にSecret Managerのsecret名を登録します。
4. Production deploy後、Cloud Run revisionの`LTM_AUTO_MAINTENANCE_TOKEN`がSecret Manager version `latest`を参照していることを確認します。token値を画面やlogから読み返しません。

従来のshared curator PATと`LTM_MAINTENANCE_TOKEN`は別credentialのままにします。通常棚卸しへ共有maintenance tokenやcurator PATを渡しません。共有集約にはcurator PATとmaintenance tokenを渡します。PAT失効やtoken rotation時はGitHub secret、Secret Managerのversion、ローカルcuratorの設定ファイルを同じ更新作業で切り替えます。

## 履歴と復元

Dashboardのproject管理からownerが自動棚卸し設定、最新処理status、archive、revisionを確認できます。project memoryの復元はrevisionを選択して実行します。設定更新はversion競合を検出し、記憶復元は現在hash競合をHTTP 409で返します。shared履歴と復元requestはcurator UIDだけが扱えます。共有の復元ボタンはpending requestを作るだけで、次のscheduleまたはmanual writeのcuration jobがcurator PATとmaintenance tokenを再検証してから適用します。dry-runでは適用しません。読み取り・revision確認・適用時の一時障害は`pending`を保ち、次のwrite実行で再試行します。現在hashの不一致、memory消失、revision消失、CAS競合など安全に再試行できないrequestは`failed`として記録します。

履歴APIはevent、revision hash、operation ID、memory ID、理由コードだけを返します。本文、source URL、GCS object keyはブラウザへ返しません。自動棚卸しと共通集約は完全削除を行いません。利用者による手動の完全削除は従来どおりです。

## 失敗の確認

- 通常棚卸しのsummaryはproject数、適用数、skip数、失敗数だけを出します。`failed`が1以上なら通常棚卸しを失敗扱いにし、共有集約は続行します。
- 共有集約が失敗した場合、日次cursorは未完了projectで進みません。次回の定期実行で再試行します。
- 共有restore requestの読み取り・revision確認・適用で一時障害が起きた場合はrequestをpendingのまま保ち、runnerは結果checkpointを送らず次のwrite実行で再試行します。hash/revision競合など安全に再試行できない状態はrequestをfailedとしてDashboardへ表示します。
- URL取得の失敗・曖昧な根拠・矛盾は候補を変更せず、再確認予定にします。
- `LTM_AUTO_MAINTENANCE_TOKEN`が欠落・無効なら通常棚卸しjobが失敗します。共有集約tokenの代替にはしません。
- runnerのraw Claude stdoutやstderrはlogへ出しません。原因調査にはsafe summary、systemd・launchdのlogと終了status、memory IDと監査eventを使います。

## ローカル受入

```bash
pnpm exec vitest run tests/curator/maintenance-runner.test.ts tests/curator/dated-curation.test.ts tests/deploy/memory-maintenance.test.ts tests/deploy/dated-curation.test.ts tests/curator/curator-skill.test.ts
pnpm test
pnpm lint
pnpm exec tsc --noEmit
NODE_ENV=production pnpm build
```

Cloud Run/Firebase/GCS/Firestoreの実環境smokeは、GitHub secrets、opt-in smoke project、Firebase identity、GCP IAMの設定後に行います。repository内のテスト成功を実環境受入完了として扱いません。
