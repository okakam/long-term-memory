import { afterEach, expect, test, vi } from 'vitest';

import type { AuthStoreLike, MemberRecord } from '@/lib/auth/store';
import { resetAuthStoreForTests, setAuthStoreForTests } from '@/lib/auth/store';
import { createProjectAccessGuard, extractMaintenanceToken, extractProjectId } from '@/lib/mcp/context';

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetAuthStoreForTests();
});

test('移行期間中は URL query のproject_idを検証する', () => {
  expect(extractProjectId(new URL('https://example.test/api/mcp?project_id=my-project'))).toBe('my-project');
  expect(() => extractProjectId(new URL('https://example.test/api/mcp'))).toThrow('project_id is required');
  expect(() => extractProjectId(new URL('https://example.test/api/mcp?project_id=../escape'))).toThrow();
});

test('project access は呼び出しごとに指定projectの現在のmembershipを確認する', async () => {
  vi.stubEnv('AUTH_REQUIRED', '1');
  const memberships = new Map<string, MemberRecord>([
    ['alpha', { project_id: 'alpha', user_id: 'user-1', role: 'member' }],
    ['beta', { project_id: 'beta', user_id: 'user-1', role: 'owner' }],
  ]);
  const getMembership = vi.fn(async (projectId: string) => memberships.get(projectId) ?? null);
  setAuthStoreForTests({ getMembership } as unknown as AuthStoreLike);
  const requireProjectAccess = createProjectAccessGuard({
    principal: { userId: 'user-1', credentialId: 'credential-1', credentialKind: 'oauth' },
    maintenanceToken: null,
  });

  await expect(requireProjectAccess('alpha', 'read')).resolves.toBeUndefined();
  await expect(requireProjectAccess('beta', 'maintain')).resolves.toBeUndefined();
  await expect(requireProjectAccess('alpha', 'maintain')).rejects.toThrow('project access denied');
  memberships.delete('alpha');
  await expect(requireProjectAccess('alpha', 'read')).rejects.toThrow('project access denied');
  expect(getMembership).toHaveBeenCalledTimes(4);
});

test('shared write はcurator PATとmaintenance tokenが揃った場合だけ許可する', async () => {
  vi.stubEnv('AUTH_REQUIRED', '1');
  vi.stubEnv('LTM_CURATOR_USER_ID', 'curator-1');
  vi.stubEnv('LTM_MAINTENANCE_TOKEN', 'test-maintenance-secret');
  const principal = { userId: 'curator-1', credentialId: 'credential-1', credentialKind: 'pat' as const };
  const allowed = createProjectAccessGuard({ principal, maintenanceToken: 'test-maintenance-secret' });
  const noToken = createProjectAccessGuard({ principal, maintenanceToken: null });
  const oauth = createProjectAccessGuard({ principal: { ...principal, credentialKind: 'oauth' }, maintenanceToken: 'test-maintenance-secret' });

  await expect(allowed('__shared__', 'read')).resolves.toBeUndefined();
  await expect(allowed('__shared__', 'write')).resolves.toBeUndefined();
  await expect(allowed('__shared__', 'maintain')).resolves.toBeUndefined();
  await expect(noToken('__shared__', 'write')).rejects.toThrow('shared scope is read-only');
  await expect(oauth('__shared__', 'maintain')).rejects.toThrow('shared scope is read-only');
});

test('maintenance token は header だけから読む', () => {
  expect(extractMaintenanceToken(new Request('https://example.test?maintenance_token=bad', { headers: { 'X-LTM-Maintenance-Token': 'good' } }))).toBe('good');
  expect(extractMaintenanceToken(new Request('https://example.test?maintenance_token=bad'))).toBeNull();
});
