import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SetupClientEnvironmentInput } from '../schemas';
import { SETUP_MANIFEST } from '../setup-manifest.generated';
import { json } from './util';

const commonInstructions = [
  'MCP add/login はすでに完了しています。再登録や再ログインを行わず、呼び出し側agentが返された資産をローカルの対象clientへ適用してください。Cloud Runのtoolはclientのfilesystemへアクセスしません。説明だけで終了せず、以下とguide_markdownの対象client手順を実行してください。',
  '正本はこの応答のassetsです。呼び出し側repositoryに同名sourceがあると仮定せず、各contentのUTF-8 sha256がasset.sha256と一致することを配置前後に確認してください。schema_versionとconfig_versionも確認し、不一致なら中断してください。',
  'ローカルのbashとjqを確認してください。必要な環境がない場合、壊れたJSON/TOML、片方だけ・複数・壊れたltm markerがある場合は自動修復せず中断し、原因を報告してください。',
  '同一内容は変更せず、異なる既存ファイルは更新前に*.bak-<timestamp>へバックアップしてください。他の設定、hook、文書sectionを保持してください。instruction blockはltm:begin/endが各1個なら置換、旧見出し ## long-term-memory MCP なら次の ## まで置換、それ以外は追記してください。',
  'list_projectsで接続と利用可能projectを確認してください。project作成やmember追加など不足する操作はDashboardでの手動操作として案内してください。OAuth同意はmembershipを作成しません。',
  'guide_markdownのcurator・CI・Cloud Run smoke専用PAT節は通常client設定へ適用しないでください。PAT、OAuth token、maintenance token、MCP URLを補助設定ファイルへ追加せず、認証情報を応答・ログ・version stampへ保存しないでください。',
];

const claudeInstructions = [
  'ローカルのCONFIG_DIRはCLAUDE_CONFIG_DIRが設定されていればその値、無ければ$HOME/.claudeです。必要な親directoryを作成し、skillをCONFIG_DIR/skills/long-term-memory/SKILL.md、hookをCONFIG_DIR/hooks/ltm-init-reminder.shへassetsから配置してください。hookにchmod +xとbash -nを実行してください。',
  'CONFIG_DIR/settings.jsonが無ければ空のJSON objectとして扱います。hooks.UserPromptSubmitへCONFIG_DIR/hooks/ltm-init-reminder.shをbashで実行するcanonical commandを正確に1個登録し、同一commandは重複させず、既存設定と他hookを保持してください。instruction blockはCONFIG_DIR/CLAUDE.mdへ適用してください。',
  'CONFIG_DIR/.ltm-config-versionへinstalled_at、client、source（setup_client_environment）、config_version、skill/hook/CLAUDE.mdのsha256を記録し、既存stampの旧→新を報告してください。JSON妥当性、hook構文と実行権限、commandが正確に1個、markerが各1個、既存設定の保持を検証してください。',
];

const codexInstructions = [
  '呼び出し側agent自身がローカルでgit rev-parse --show-toplevelを実行してREPO_ROOTを求めてください。失敗した場合は変更せず中断してください。target_scopeのcodex-current-repositoryは識別子でありCloud Runのpathではありません。',
  '必要な親directoryを作成し、assetsのskillを$REPO_ROOT/.agents/skills/long-term-memory/SKILL.md、hookを$REPO_ROOT/claude-config/hooks/ltm-init-reminder.shへ配置してください。hookにchmod +xとbash -nを実行してください。$REPO_ROOT/AGENTS.override.mdがあればRULES_FILEはそれ、無ければ$REPO_ROOT/AGENTS.mdとし、instruction blockをactiveなRULES_FILEへ適用してください。',
  '同じ.codex layerのconfig.tomlにinline hooksがあればその形式を保持し、hooks.jsonを作らないでください。無ければ$REPO_ROOT/.codex/hooks.jsonを使い、不在なら{"hooks":{}}から始めてください。他のhookと設定を保持し、UserPromptSubmitへcommand bash "$(git rev-parse --show-toplevel)/claude-config/hooks/ltm-init-reminder.sh"を正確に1個だけ登録してください。matcherは指定せず、[features] hooks = falseなら削除またはtrueへ戻してください。',
  '$REPO_ROOT/.codex/.ltm-config-versionへinstalled_at、client、source（setup_client_environment）、config_version、skill/hook/RULES_FILEとhooks.jsonまたはconfig.tomlのsha256を記録し、既存stampの旧→新を報告してください。JSON/TOML妥当性、hook構文と実行権限、commandが正確に1個、markerが各1個、既存設定の保持を検証してください。',
];

export function registerClientSetupTool(server: McpServer): void {
  server.registerTool('setup_client_environment', {
    description: 'Call only when the user requests client setup after MCP add/login. No project_id is needed. Returns canonical versioned setup guide/assets; the calling agent must apply them locally for the selected client, not stop at an explanation. Dashboard membership changes remain manual and machine-only curator PAT setup is excluded.',
    inputSchema: SetupClientEnvironmentInput,
  }, async ({ client }) => json({
    ...SETUP_MANIFEST,
    client,
    target_scope: client === 'claude-code' ? 'claude-user-config' : 'codex-current-repository',
    setup_instructions: [
      ...commonInstructions,
      ...(client === 'claude-code' ? claudeInstructions : codexInstructions),
      'hook scriptのsha256が以前から変わった場合、command定義のtrustだけでは不足します。source差分の手動レビューが完了するまでhookを実行しないでください。レビュー後にguide_markdownの3ターン検証（雑談は無反応、作業はsearch_memories reminder、同じsession_id再実行は無反応）を行い、変更・unchanged・検証結果・rollback backupを報告してください。',
    ],
    post_setup_actions: client === 'claude-code' ? [
      'Claude Codeを再起動してください。skill、hook、MCP tool定義は起動時に読み込まれます。',
      'hook scriptが変わった場合はsource差分を手動レビューしてから実行してください。',
    ] : [
      'Codex CLIを再起動し、/hooksで新しいhookをレビュー・trustしてください。',
      'hook scriptが変わった場合は定義変更がなくてもsource差分を手動レビューするまで実行しないでください。command定義も変わった場合は/hooksで新しい定義をtrustしてください。',
    ],
  }));
}
