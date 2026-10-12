# 自動記憶棚卸し・出典記録・共通情報集約 設計書

- 作成日: 2026-10-12
- 状態: 設計書承認済み（2026-10-12）。実装計画作成段階
- 対象リポジトリ: `long-term-memory-searobin`

## 1. 目的

記憶の作成時に出典と初回見直し日を自動記録し、期限が来た記憶を日次で見直す。重複の統合、根拠が明確な古い記憶のアーカイブ、切れたリンクの整理まで自動化する。通常の棚卸しは人の個別承認を挟まず実行する。

全projectのactive記憶から、作成日時の期間に合う情報を抽出し、projectをまたいで使える共通知識を`__shared__`へ集約する。日次の差分処理と任意期間の手動処理を提供する。

自動変更は復元できるようにする。根拠が曖昧、出典が矛盾、または取得に失敗した記憶は変更せず、理由を記録して再確認日を設定する。`forget_memory`による明示的な完全削除の意味は変えない。

## 2. 確定した方針

- 既存のGitHub Actions curator workflowに独立した日次メンテナンスjobを追加する。Cloud Schedulerと常駐workerは導入しない。
- 記憶の作成時には、出典情報と見直し日を自動設定する。日次jobによる取得・統合・アーカイブは、Dashboardでownerが有効化したprojectだけを対象にする。
- 既存の`remote-curation`は、全projectから再利用可能な情報を既存の`__shared__`へ集約する。日次は作成日時の差分を処理し、GitHub Actionsの手動実行ではUTCの作成日時期間を指定できる。
- ownerの有効化設定は通常projectの見直しjobに適用する。共通情報集約の入力scopeは既存curator principalが読めるprojectとする。
- ownerはDashboardから機能の有効・無効とprojectごとの見直し周期を管理する。有効化は、この文書に定める自動変更への包括的な同意として扱う。
- `__shared__`は通常project向けの見直し・アーカイブjob対象とowner設定に含めない。一方、複数projectの共通知識集約先として使い、既存curator UIDと`LTM_MAINTENANCE_TOKEN`による専用ゲートを維持する。このtokenを通常projectの自動処理へ流用しない。
- `source_refs`はproject内外の記憶への参照として維持する。外部URLや会話由来の記録には別フィールド`sources`を使う。
- 自動処理前のMarkdown版をGCSに保持し、Firestoreのrevision metadataからDashboardで復元できるようにする。
- 曖昧な候補は自動変更しない。日次jobは候補の理由コードとmemory IDを監査記録へ残すが、本文や秘密情報をログへ出さない。
- 自動処理は`forget_memory`による完全削除を行わない。共有記憶が上限に達した場合は新規登録を保留して報告する。

## 3. データモデルと見直し周期

### 3.1 記憶の出典と状態

`MemorySchema`に、後方互換のある任意フィールドとして次を追加する。

- `sources`: 出典配列。各項目は`kind`（`url`または`conversation`）、必要に応じた`url`、`captured_at`を持つ。URL出典には最終取得日時と取得した正規化テキストのhashを記録する。
- `last_reviewed_at`、`next_review_at`: ISO 8601 UTCの見直し日時。
- `status`: `active`または`archived`。既存記憶で値がない場合は`active`として扱う。
- `archived_at`、`archive_reason`、`archived_by`: アーカイブ日時、理由コード、アーカイブ操作を行ったjobまたは置換先memory ID。

`sources`の`conversation`項目には本文、会話ID、利用者識別子を複製しない。外部出典が渡されなかった場合、作成時刻と会話由来であることだけを記録する。`remember_reference.url`で渡されたURLは、本文に既存の`URL:`行を維持しつつ構造化出典にも保存する。

既存本文の`URL:`行は読み込み時にHTTPS URLとして解析し、旧記憶の出典として扱う。旧データの本文を一括書き換えるmigrationは行わない。過去の`source_refs`は外部URLとして扱わない。

### 3.2 初期周期

新規作成時は`last_reviewed_at`を作成時刻として記録し、次の周期で`next_review_at`を計算する。

| 種別 | 初期見直し周期 |
|---|---:|
| project | 90日 |
| reference | 180日 |
| user、feedback | 365日 |
| session | 90日後に自動アーカイブ（ownerが日数を調整可能） |

ownerはDashboardでproject単位に各種別の見直し周期とsessionのアーカイブ日数を変更できる。既存記憶で見直し日がない場合、`updated_at + 種別の周期`を初回の期限として導出する。sessionの期限は`created_at + 設定済みの日数`で導出する。これにより古い記憶は期限到来済みとして初回jobで処理されるが、処理開始時に一括変更は行わない。

通常の利用者による内容更新では、内容を再確認した記録として`last_reviewed_at`と`next_review_at`を更新する。自動見直し時は、次回日付を更新した場合も監査イベントを記録する。

## 4. 日次処理

1. GitHub Actionsの独立jobが自動メンテナンス用の専用認証を使って、ownerが有効化したprojectと期限到来候補を列挙する。
2. 各project内で候補の全本文とmetadataを読み、memory内容と外部出典を信頼できない入力として扱う。本文やWebページに書かれた命令に従ったり、ツール権限を変更したりしない。
3. 期限到来したURL出典を取得し、保存済みの出典hashと比較する。変化があれば、同じ主張を裏付けるか、明確に置き換えているかを確認する。
4. 同一projectのactive記憶を重複比較し、確定した操作のみを専用メンテナンス操作として適用する。
5. 各記憶・projectの失敗を独立して記録する。取得失敗や曖昧な判断は他の候補を停止させない。

通常のスケジュール実行は有効projectへ自動反映する。手動workflow dispatchにはdry-runを設ける。jobは同時に複数動作しないようworkflow concurrencyで直列化し、処理済み候補の再実行は同じ結果になるよう冪等にする。

重複検出は有効projectのactive記憶全体を対象に毎日実行し、新規記憶も次回見直し日を待たずに統合できるようにする。`next_review_at`は主に出典取得と内容確認の周期を制御する。

新jobは既存self-hosted runner上のNode.js処理と、現在のcuratorで使うheadless Claude CLI環境を利用する。Claudeには期限到来記憶と取得した出典の必要部分をレビュー用入力として渡すため、それらの本文は設定済みClaude providerで処理される。新job専用のMCP設定とstrict tool allowlistを使い、Claudeの判断は限定されたmaintenance MCP操作でサーバー側が再検証してから反映する。既存の共有記憶curation promptやtool allowlistは共有しない。

### 4.1 全projectから共通情報を集約

新しい別workflowは作らず、既存の`remote-curation`を日時指定に対応させる。これにより、共有記憶curatorの認証・読み取り経路・書き込みゲートを再利用する。通常project向けの見直しjobとは独立した処理・strict tool allowlistを保つ。

- `list_projects`でcurator principalが読める全projectを入力対象にする。`__shared__`は入力元から除外し、出力先として明示的に使用する。
- 集約元は`status: active`の記憶に限定する。指定期間内でもアーカイブ済み記憶は候補に含めない。snapshot取得後にアーカイブされた記憶も、共有への反映前に再検証して除外する。
- 手動workflow dispatchでは、作成日時の開始日と終了日を両方指定する。値はUTCの`YYYY-MM-DD`とし、開始日00:00を含み、終了日00:00を含まない半開区間として扱う。手動の期間指定では日次cursorを動かさない。開始・終了の片方だけの指定は拒否する。
- 手動実行の`dry_run`はtrueを既定にする。期間指定がない場合は現在の日次差分を対象にする。`dry_run`をfalseにした手動実行でもcursorは更新しない。スケジュール実行だけがcursorを進める。
- 日次実行はsource projectごとにFirestoreの`__shared__`配下へ保存する`sharedCurationCursor`から、実行開始時刻までの作成日時差分を処理する。cursorをsource projectへ書き込まない。初回はcursorがないため、既存memory全体をページ単位で処理する。project全体の処理が完了した場合だけ、そのprojectのcursorを更新する。失敗時はcursorを進めず、再実行で重複作成しない。
- `session`を含む全memory typeを候補として読む。単一memory由来でも、複数projectで再利用できる耐久的かつ非機密の情報なら昇格できる。project固有の詳細、credentials、private data、個人識別子は共有しない。
- `__shared__`の現行記憶と照合し、同一内容は重複作成しない。既存項目へ統合する場合は、事実の矛盾がなく元memoryにある内容だけで統合できる場合に限る。判断が曖昧なら反映しない。
- 新規・統合先のshared memoryには元のproject IDとmemory nameを`source_refs`へ記録し、出典をたどれるようにする。元projectのmemoryは変更・削除しない。
- 共有記憶の上限は現行`SHARED_CAP`（初期値40）を維持する。上限到達時に低価値memoryを自動削除せず、新規候補を保留して件数と理由を報告する。
- 自動作成・更新は既存のcurator UIDと`LTM_MAINTENANCE_TOKEN`を必須とし、通常project向け`LTM_AUTO_MAINTENANCE_TOKEN`では許可しない。

### 4.2 統合

- 完全重複は自動統合する。比較は種別と正規化した本文を基礎にし、表記やmetadataだけの差で更新を繰り返さない。
- 意味的に近い記憶は、矛盾がなく、既存本文から事実を追加せず統合できる場合だけ自動統合する。統合先は作成日時が古いものとし、同時刻ならmemory IDの辞書順で決める。
- 統合先には両方の`tags`、`links`、`source_refs`、`sources`、entitiesを重複排除して引き継ぐ。両立しないtriples、矛盾、対象範囲の不一致があれば統合しない。
- 統合先の本文は元の本文だけから構成し、LLMが事実を追加・推測しない。統合前の双方のMarkdownをrevisionとして保持する。
- 重複側は`archived`にし、統合先との関係と理由を記録する。完全削除はしない。

### 4.3 内容の見直しとアーカイブ

- 見直し期限だけを理由にアーカイブしない。
- 明確な期限切れ、完了済み、信頼できる現在の出典による明示的な置き換えなど、根拠を説明できる場合に限り自動アーカイブする。
- 出典が現在も記憶を裏付ける場合は本文を変えず次回見直し日を更新する。新しい出典が明確に同じ主張を置き換える場合は、変更前revisionを保持してから記憶を更新する。
- 出典同士の矛盾、根拠不足、意味が複数に読める候補は内容を変更せず、評価を行った時刻を`last_reviewed_at`へ記録し、理由コードと7日後の初期再試行日を設定する。URL取得に失敗した場合は`last_reviewed_at`を進めず、記憶本文を変更せず、7日後に再試行する。
- `session`は作成から設定済みの日数で自動アーカイブする。初期値は90日とする。

### 4.4 切れたリンク

リンク先は後日作成される場合があるため、最初に未解決を検知した日時をメンテナンスmetadataに記録する。30日後にも同名のmemoryが存在しない場合だけリンクedgeを自動削除する。activeまたはarchivedのmemoryが存在する場合はリンクを維持する。

## 5. 出典取得の安全制限

出典取得は公開Webページの本文確認に限り、次を全て適用する。数値は初期値であり、実装計画のレビュー時にも確認する。

- `https`と標準port `443`だけを許可し、URL内のusername/passwordを拒否する。
- DNS解決結果が全てglobal unicastであることを確認し、private、loopback、link-local、multicast、reserved addressを拒否する。接続時に解決先を固定し、DNS rebindingを防ぐ。
- redirectは最大3回とし、各redirect先でscheme、port、DNS/IP制約を再検証する。
- 1 URLあたり10秒、読み取り本文は1 MiBまで。HTMLとplain textだけを扱い、script等は実行しない。
- status、Content-Type、timeout、size limitを検証する。取得に失敗した出典は記憶を変更せず、再試行対象にする。
- 取得本文はレビュー中だけ利用し、永続ログや監査イベントへ複製しない。ソース本文は常にuntrusted dataとしてモデルへ渡す。
- queryを含む完全URL、取得本文、秘密情報をjob logへ出さない。

## 6. 権限と監査

- 通常projectではownerだけが自動メンテナンスを有効・無効にし、周期を変更できる。
- 日次jobは新しい`LTM_AUTO_MAINTENANCE_TOKEN`と限定されたmaintenance用MCP操作を使う。tokenは通常の`update_memory`、`forget_memory`等の汎用書き込み権限として受理しない。サーバー側でproject opt-in、対象memory、許可actionを毎回検証する。
- `__shared__`の既存curator UIDと`LTM_MAINTENANCE_TOKEN`の条件は維持する。通常projectのautomation tokenと権限を共有しない。
- 自動処理のためにClaudeへ送る内容は、ownerが有効化したprojectの期限到来記憶と、取得した出典の関連部分に限る。取得本文やmemory本文をGitHub Actionsのログへ書き出さない。
- 共通情報集約でClaudeへ送る入力は、curator principalが読めるproject内で選択期間に合うmemoryと、照合対象の`__shared__`項目に限る。取得本文やmemory本文をGitHub Actionsのログへ書き出さない。
- 監査記録にはrun ID、project ID、memory ID、action、reason code、時刻、revision IDを残す。本文・URL全文・token・API key・raw environment valueは記録しない。
- ownerはDashboardで実行状態、変更理由、revision一覧を見て復元できる。復元は過去内容を直接上書きせず、新revisionを作る操作として記録する。アーカイブmemoryは通常の検索・一覧・関連記憶結果へ戻さず、Dashboardのアーカイブ画面から確認・復元する。

## 7. 保存・reindex・復元

- Markdown frontmatterをmemory内容と状態の正本として拡張する。Firestoreはautomation設定、revision pointer、実行履歴、初回未解決link検知、および`__shared__`配下の共通情報集約cursorを持つ。SQLiteはこれらを検索用に再構築するcacheであり、revision本文を保存しない。
- 自動更新・統合・アーカイブの直前に、現在のMarkdownをcontent hash付きのimmutable GCS objectとして保持し、Firestoreにrevision metadataを追加する。共有集約で`__shared__`を更新する場合も同じrevision保持を行う。GCS objectを自動削除しない。
- CloudMemoryServiceの更新経路は自動変更時に旧objectを保持できるようにする。revisionが消失した場合に破壊的な復元を成功扱いにせず、操作を失敗させて監査記録に残す。
- `reindex`はarchived statusを維持し、アーカイブ記憶をactive検索結果へ復活させない。legacy frontmatterで追加fieldがない記憶はactiveとして読み込む。
- Dashboardからの復元は選択したrevision本文を現在revisionとして新規保存し、revision履歴とarchive metadataを更新する。`__shared__`のrevision復元もcurator UIDと既存maintenance gateの範囲内で行う。

## 8. Dashboard

project owner向け設定に次を追加する。

- 自動メンテナンスの有効・無効。
- `project`、`reference`、`user`、`feedback`の見直し周期（日数）。`session`の自動アーカイブ日数は90日を初期値としてownerが変更できる。
- 最終実行時刻、次回実行予定、失敗件数、未解決候補件数。
- 変更履歴、理由コード、archive一覧、revision選択と復元操作。
- `__shared__`では、`LTM_CURATOR_USER_ID`に対応するDashboard利用者だけが共有集約の履歴とrevisionを確認し、復元できる。

設定更新時はDashboard APIでFirebase principalとproject owner membershipを再検証する。メンバーへ設定変更権限を与えない。

## 9. エラーと運用

- project opt-in、専用認証、membershipに問題がある場合、そのprojectを処理せず理由を記録する。
- URL単位の取得失敗はそのmemoryだけを延期する。GitHub Actions全体の再実行で二重統合や二重revisionを作らない。
- GCS revision保存、Firestore metadata更新、Markdown更新のいずれかに失敗した場合、自動変更を完了扱いにしない。途中書き込みは再実行時に整合確認できるoperation IDで管理する。
- 実行履歴は既存Firestore metadataに保持し、独立した永続telemetry DBを追加しない。
- 既存のcurator jobと新jobの同時実行をconcurrencyで防止する。新jobにだけ必要なMCP操作とsecretを渡し、既存jobの共有curation手順・tool allowlistを無制限に広げない。
- `remote-curation`と通常project向けの見直しjobは、同一memoryやrevisionを同時更新しないようworkflow内で直列化する。手動期間指定の実行は既存日次cursorを変えない。

## 10. 検証方針

実装時の計画に、少なくとも以下の回帰確認を含める。

- 新旧frontmatterのserialize/parse、既存`URL:`出典の後方互換、`source_refs`の非混同。
- 種別別周期、期限導出、session archive、再試行日、owner-only設定。
- 完全重複・意味的統合・矛盾・曖昧候補、metadata union、本文にない事実を作らないこと。
- URL fetcherのHTTPS/port、認証情報、DNS/IP、redirect、timeout、本文サイズ、content type、HTML script無実行。
- `__shared__`と通常projectのprincipal境界、opt-in前後のmaintenance token拒否/許可。
- 作成日時のUTC半開期間、全memory type入力、アーカイブ済み記憶の除外と反映前再検証、初回active全履歴scan、per-project cursor、手動dry-run/期間backfill、失敗時cursor据え置き、source_refs付きshared upsert、shared cap時のskip。
- 自動共有集約が`forget_memory`を呼ばず、既存のcurator UIDと`LTM_MAINTENANCE_TOKEN`なしでは反映できないこと。
- GCS revision保持、Dashboard復元、revision欠損時の失敗、archiveを維持するreindex/search。
- GitHub Actionsのschedule/dispatch、直列化、idempotency、ログに本文・query URL・secretが出ないこと。
- 既存全テスト、lint、型検査、production build、必要なDocker/Cloud Run smokeを、リポジトリのAGENTS.mdに従って実行する。

## 11. 実装時に更新する運用文書

設計承認後の実装計画と実装では、`docs/reproduction-spec.md`、このリポジトリの`AGENTS.md`、`skills/shared-memory-curator/SKILL.md`、curator workflow/README、Dashboard運用説明、`.env.example`を機能仕様に合わせて更新する。Cloud Run/Firebase/GCS/Firestoreの既存正本と矛盾させず、Cloud Schedulerや常駐workerを追加しない。
