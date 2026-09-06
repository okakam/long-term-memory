import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');

test('Claude Code資産は能動検索と6つのMUSTを保持する', () => {
  const skill = read('skills/long-term-memory/SKILL.md');
  expect(skill).toContain('mcp__long-term-memory__*');
  expect(skill).toContain('search_memories');
  expect(skill).toContain('get_memory');
  expect(skill).toContain('get_memory_index');
  expect(skill).toContain('subagent');

  const block = read('claude-config/claude-md-block.md');
  for (const rule of [
    'search_memories',
    'get_memory_index',
    '機密情報は保存しない',
    'MCP側',
    '確認不要',
    'subagent',
  ]) {
    expect(block).toContain(rule);
  }

  const hook = read('claude-config/hooks/ltm-init-reminder.sh');
  expect(hook).toContain('set -uo pipefail');
  expect(hook).toContain('claude-ltm-read-');
  expect(hook).toContain('search_memories');
  expect(hook).toContain('get_memory');
  expect(hook).toContain('1 セッション 1 回');
  expect(hook).not.toContain('set -e');
  execFileSync('bash', ['-n', resolve(root, 'claude-config/hooks/ltm-init-reminder.sh')]);
});

test('設置プロンプトは一経路の冪等配置と自己検証を定義する', () => {
  const setup = read('docs/post-mcp-setup.md');
  for (const requirement of [
    'jq',
    'unchanged',
    '.bak-',
    'replace-markers',
    'replace-legacy',
    'append',
    '.ltm-config-version',
    'bash -n',
    '3 ターン',
    'Claude Code を再起動',
  ]) {
    expect(setup).toContain(requirement);
  }
  expect(setup).not.toContain('claude-config/install.sh');

  const embeds = setup.match(/<!-- ltm:embed src=/g) ?? [];
  expect(embeds).toHaveLength(3);
  expect(setup.match(/<!-- \/ltm:embed -->/g) ?? []).toHaveLength(3);

  const sync = read('scripts/sync-embedded-docs.mjs');
  expect(sync).toContain('--check');
  expect(sync).toContain('fence');
  expect(sync).toContain('0');
  execFileSync('node', [resolve(root, 'scripts/sync-embedded-docs.mjs'), '--check']);
});

test('curatorのlocal/remote設定は秘密を露出せず権限を絞る', () => {
  const wrapper = read('scripts/curator/run-curation.sh');
  for (const requirement of [
    'DRY_RUN_WAS_SET',
    'DRY_RUN_VALUE',
    '--mcp-config',
    '--strict-mcp-config',
    '--add-dir',
    '--tools\n  Read\n  Grep\n  Glob',
    '--setting-sources user',
    '--disallowedTools',
    'CURATION SUMMARY',
    'awk',
    'last-success',
  ]) {
    expect(wrapper).toContain(requirement);
  }
  expect(wrapper).not.toContain('pkill');

  const env = read('scripts/curator/env.example');
  for (const name of ['LTM_MCP_TOKEN', 'LTM_MAINTENANCE_TOKEN']) {
    expect(env).toMatch(new RegExp('^' + name + '=\\s*$', 'm'));
  }

  const plist = read('launchd/com.user.ltm-shared-curator.plist');
  expect(plist).toContain('__LIBEXEC__/run-curation.sh');
  expect(plist).toContain('<integer>10</integer>');
  expect(plist).toContain('<integer>0</integer>');
  expect(plist).not.toContain('Documents');

  const config = JSON.parse(read('docs/mcp-config.vercel.json')) as {
    mcpServers: { 'ltm-shared': { url: string; headers: Record<string, string> } };
  };
  expect(config.mcpServers['ltm-shared'].url).toContain('$' + '{MCP_PUBLIC_URL}');
  expect(config.mcpServers['ltm-shared'].headers.Authorization).toContain('$' + '{LTM_MCP_TOKEN}');
  expect(config.mcpServers['ltm-shared'].headers['X-LTM-Maintenance-Token']).toContain('$' + '{LTM_MAINTENANCE_TOKEN}');
  expect(existsSync(resolve(root, 'scripts/curator/install.sh'))).toBe(true);

  const workflow = read('.github/workflows/curator.yml');
  expect(workflow).toContain("cron: '0 1 * * *'");
  expect(workflow).toContain('runs-on: [self-hosted, ltm-curator]');
  expect(workflow).toContain('scripts/curator/export-remote-snapshot.ts');
  expect(workflow.match(/^\s*MCP_PUBLIC_URL:/gm) ?? []).toHaveLength(2);
  expect(workflow).toContain('cat > "$LTM_CURATOR_ENV" <<ENV');
  expect(workflow).not.toContain('cat > "$LTM_CURATOR_ENV" <<' + "'ENV'");
});
