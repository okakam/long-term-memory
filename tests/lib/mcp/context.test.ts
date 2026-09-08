import { expect, test } from 'vitest';

import { extractMaintenanceToken, extractProjectId } from '@/lib/mcp/context';

test('project_id は URL query から検証して抽出する', () => {
  expect(extractProjectId(new URL('https://example.test/api/mcp?project_id=my-project'))).toBe('my-project');
  expect(() => extractProjectId(new URL('https://example.test/api/mcp'))).toThrow('project_id is required');
  expect(() => extractProjectId(new URL('https://example.test/api/mcp?project_id=../escape'))).toThrow();
});

test('maintenance token は header だけから読む', () => {
  expect(extractMaintenanceToken(new Request('https://example.test?maintenance_token=bad', { headers: { 'X-LTM-Maintenance-Token': 'good' } }))).toBe('good');
  expect(extractMaintenanceToken(new Request('https://example.test?maintenance_token=bad'))).toBeNull();
});
