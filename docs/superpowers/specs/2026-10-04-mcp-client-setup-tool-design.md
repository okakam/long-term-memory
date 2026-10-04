# MCP接続後のクライアントsetup tool設計

**状態: レビュー待ち（この設計の承認後に実装計画を作成する）**

## 背景

`docs/post-mcp-setup.md`にはCodex CLIとClaude Codeの接続後設定、Dashboardでのproject/member管理、curator・CI向けPAT運用が記載されている。現在は利用者が手順を選び、必要な補助資産を手作業で配置する。

利用者はMCP接続を済ませた後にsetup用MCP toolを実行し、同文書に基づく設定を利用中のClaude CodeまたはCodex CLIへ反映したい。Cloud Run上のMCP serverから呼び出し側端末のfilesystemを直接変更することはできない。このためMCP toolが正本の手順と資材を返し、呼び出し側のClaude/Codex agentが自身のfilesystem機能を使って適用する。

## 目的

- 接続済みのlong-term-memory MCPから、Claude CodeまたはCodex CLI向けの初期設定を実行できるようにする。
- 正本である`docs/post-mcp-setup.md`と補助資産を使い、個別clientの設定へ適用する。
- 既存設定を保持し、差分のある上書き、壊れた設定、hook trustの扱いを利用者へ報告する。
- project scopeなしの1つのMCP接続とmulti-project tool契約を維持する。

## 非目的

- Cloud Runから利用者の端末・repository・home directoryへ直接書き込むこと。
- MCP接続登録、OAuth login、Dashboard上のproject作成・membership変更をMCP toolから代行すること。
- curator、CI、Cloud Run smoke向けPATを通常利用者の設定へ追加すること。
- MCP認証情報やPATをtool引数、出力、環境変数へコピーすること。

## 利用フロー

1. 利用者はCodex CLIまたはClaude Codeへlong-term-memory MCPを登録し、通常の認証を完了する。
2. 利用者が`setup_client_environment`を呼ぶ。呼び出し時に現在のclientを明示する。
3. MCP toolはclient別の適用手順、正本ドキュメント、必要な正本資産、version/hashを返す。tool自身はproject dataやclient filesystemを変更しない。
4. Claude/Codex agentは返された手順と資産を読み、ドキュメントで定めたclientの既定scopeへローカル設定を適用する。Claude Codeは設定directory、Codexは現在のrepository rootを対象とする。
5. agentは変更、変更なし、検証結果、作成したbackup、再起動・hook trustなど利用者に残る操作を報告する。壊れたJSON/TOML、曖昧なmarker、必要な実行環境の欠如など安全に継続できない状態では変更を中断する。

## MCP tool契約

- 名前: `setup_client_environment`
- 入力: 必須の`client` enum。値は`claude-code`または`codex`。
- `project_id`は受け取らない。setupはclient環境の設定であり、memory projectのread/writeではない。
- 既存MCP OAuth/API認証を通す。project membershipやowner roleは要求しない。
- 出力は次を含むJSON形式とする。
  - schema/config version、対象client、対象scope
  - 実行エージェントへの適用指示と、すでにMCP接続済みであることを示す前提
  - `docs/post-mcp-setup.md`の内容
  - `skills/long-term-memory/SKILL.md`、`claude-config/hooks/ltm-init-reminder.sh`、`claude-config/claude-md-block.md`の正本内容とsha256
  - client適用後に利用者が行う必要のある確認（Claude Code再起動、Codexの`/hooks` trust等）
- tool descriptionは、利用者がsetupを依頼した時にのみ呼び、返却後に説明だけで終了せずclientに対応するローカル適用を実行するよう明示する。

## 適用ルール

- Claude Codeは`CLAUDE_CONFIG_DIR`が設定されていればその値、なければ`$HOME/.claude`を使う。
- Codex CLIは`git rev-parse --show-toplevel`で得る現在repositoryのrootを使い、skill、activeな`AGENTS.override.md`または`AGENTS.md`、および既存形式に合わせたhook設定を扱う。
- 正本のskill、hook、instruction blockを使う。ネットワーク上の別sourceや呼び出し側repositoryに存在すると仮定したsourceを正本にしない。
- 同一内容は書き換えない。差分のある既存ファイルだけbackup後に更新する。既存の他設定・hook・文書sectionは保持する。
- JSON/TOML/shell構文、marker数、canonical hookの重複、資産hashを検証する。曖昧な状態を自動修復しない。
- `.ltm-config-version`へclient、config version、installed source/hashを記録し、従来の更新報告・hook script差分確認ルールを保つ。
- Dashboardのproject membershipはMCP toolが変更しない。agentは`list_projects`で現状を確認し、必要なproject作成・member追加がある場合はDashboardでの手動操作を案内する。
- MCP add/loginはすでに完了した前提なので繰り返さない。接続確認には`list_projects`とclientのMCP一覧を使う。
- curator/CI向けPAT節は通常のclient setupから分離し、ユーザー設定へ適用しない。

## 資産の配布方法

Cloud Run imageから実行時にrepositoryの`docs/`を読む構成には依存しない。正本ドキュメントと3つの補助資産から、buildに同梱できる生成済みsetup manifestを用意する。既存の`node scripts/sync-embedded-docs.mjs`を拡張または連携し、docs内embedとMCP toolが同じ資産を参照する。生成物のversion/hashにより、docと配布内容の不一致を検出できるようにする。

## 影響範囲

- MCP: meta toolを1つ追加し、公開tool数は16から17になる。
- docs: `docs/reproduction-spec.md`、`docs/post-mcp-setup.md`、`AGENTS.md`、本設計書および実装計画を更新する。
- 正本・生成物: setup manifest生成処理とその同期確認を追加する。
- 検証: clientごとの入力/出力、project_id不要、manifestの資産hash、17 toolsの文書・テスト整合、生成物同期を確認する。

## 受け入れ条件

1. `list_projects`などproject-scopedでない既存契約を壊さず、新しいtoolは`project_id`なしで呼べる。
2. `client=claude-code`と`client=codex`で異なる適用手順・既定scopeが返る。
3. 配布されたドキュメントと補助資産はrepositoryの正本と一致し、hashで確認できる。
4. 呼び出し側agentが手順を実行する以外に、Cloud Run tool handlerはローカルfilesystem変更を試みない。
5. 既存ファイルが同一なら変更なし、異なる場合はbackupと保持方針を報告し、壊れた設定では安全に中断する。
6. Dashboard project管理とmachine-only PATが一般利用者のローカル設定へ混入しない。

## レビュー項目

- tool名`setup_client_environment`と必須`client`入力で問題ないか。
- 既定scopeをClaude Codeのuser configとCodexのcurrent repositoryにする方針で問題ないか。
- tool出力にsetup guide全文とcanonical assetsを含め、client側agentが適用する責務分担で問題ないか。
- Dashboard操作とMCP登録/loginは前提確認・案内のみ、curator PAT節は適用対象外とする境界で問題ないか。
