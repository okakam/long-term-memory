import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';

import type { MemoryService } from '@/lib/memory/service';
import { resetSessionState } from '@/lib/mcp/session';
import { handleMcpRequest } from '@/lib/mcp/transport';
import { SETUP_MANIFEST } from '@/lib/mcp/setup-manifest.generated';
import { resetTelemetryStore } from '@/lib/telemetry/store';

async function request(method: string, params: object) {
  const response = await handleMcpRequest(new Request('https://example.test/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), { service: {} as MemoryService });
  expect(response.status).toBe(200);
  return response.json();
}

function setup(args: object) {
  return request('tools/call', { name: 'setup_client_environment', arguments: args });
}

afterEach(async () => {
  await resetSessionState();
  resetTelemetryStore();
  vi.unstubAllEnvs();
});

for (const client of ['claude-code', 'codex'] as const) {
  test(`${client} setup はprojectやmemory dataを使わず正本manifestを返す`, async () => {
    vi.stubEnv('AUTH_REQUIRED', '0');
    const response = await setup({ client });
    expect(response.error, 'setup_client_environment must be registered').toBeUndefined();
    expect(response.result.isError).not.toBe(true);
    const serialized = response.result.content[0].text;
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(64 * 1024);
    const payload = JSON.parse(serialized);
    expect(payload).toMatchObject({
      ...SETUP_MANIFEST,
      client,
      target_scope: client === 'codex' ? 'codex-current-repository' : 'claude-user-config',
    });
    for (const asset of payload.assets) {
      expect(createHash('sha256').update(asset.content, 'utf8').digest('hex')).toBe(asset.sha256);
    }
    const instructions = payload.setup_instructions.join('\n');
    expect(instructions).toContain('MCP add/login');
    expect(instructions).toContain('ローカル');
    expect(instructions).toContain('Dashboard');
    expect(instructions).toContain('PAT');
    expect(instructions).toContain('sha256');
    expect(instructions).toContain('バックアップ');
    if (client === 'codex') {
      expect(instructions).toContain('git rev-parse --show-toplevel');
      expect(instructions).toContain('AGENTS.override.md');
      expect(instructions).toContain('.agents/skills/long-term-memory/SKILL.md');
      expect(instructions).toContain('inline');
      expect(instructions).toContain('claude-config/hooks/ltm-init-reminder.sh');
      expect(payload.post_setup_actions.join('\n')).toContain('/hooks');
      expect(payload.post_setup_actions.join('\n')).toContain('trust');
    } else {
      expect(instructions).toContain('CLAUDE_CONFIG_DIR');
      expect(instructions).toContain('$HOME/.claude');
      expect(instructions).toContain('settings.json');
      expect(instructions).toContain('CLAUDE.md');
      expect(payload.post_setup_actions.join('\n')).toContain('Claude Code');
      expect(payload.post_setup_actions.join('\n')).not.toContain('/hooks');
    }
  });
}

for (const args of [{}, { client: 'unknown' }, { client: 'codex', project_id: 'example' }, { client: 'codex', unexpected: true }]) {
  test(`setup は不正な引数 ${JSON.stringify(args)} を拒否する`, async () => {
    vi.stubEnv('AUTH_REQUIRED', '0');
    const response = await setup(args);
    // A missing tool is not evidence of input validation.
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toMatch(/Input validation error/);
  });
}

test('tools/list のsetup schemaはclientだけを必須にする', async () => {
  vi.stubEnv('AUTH_REQUIRED', '0');
  const response = await request('tools/list', {});
  const tool = response.result.tools.find((item: { name: string }) => item.name === 'setup_client_environment');
  expect(tool, 'setup_client_environment must be registered').toBeDefined();
  expect(tool.inputSchema.required).toEqual(['client']);
  expect(Object.keys(tool.inputSchema.properties)).toEqual(['client']);
  expect(tool.inputSchema.properties.client.enum).toEqual(['claude-code', 'codex']);
  expect(tool.inputSchema.additionalProperties).toBe(false);
});
