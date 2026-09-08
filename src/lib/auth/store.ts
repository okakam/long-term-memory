import type { IndexStore, SqlValue } from '@/lib/storage/contracts';
import { openAuthDb } from './connection';

export interface ProjectRecord {
  project_id: string;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface MemberRecord {
  project_id: string;
  user_id: string;
  role: 'owner' | 'member';
}

export interface TokenRecord {
  id: string;
  user_id: string;
  token_hash: string;
  token_prefix: string;
  label: string;
  audience: 'mcp';
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export class AuthStore {
  constructor(public readonly db: IndexStore) {}

  async rawQuery<T extends object>(sql: string, args: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.query<T>(sql, args);
  }

  async createProject(projectId: string, ownerUserId: string, now = new Date().toISOString()): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.exec(
        'INSERT INTO projects (project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [projectId, ownerUserId, now, now],
      );
      await tx.exec(
        'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
        [projectId, ownerUserId, 'owner'],
      );
    });
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const rows = await this.db.query<ProjectRecord>(
      'SELECT project_id, owner_user_id, created_at, updated_at FROM projects WHERE project_id = ?',
      [projectId],
    );
    return rows[0] ?? null;
  }

  async getMembership(projectId: string, userId: string): Promise<MemberRecord | null> {
    const rows = await this.db.query<MemberRecord>(
      'SELECT project_id, user_id, role FROM project_members WHERE project_id = ? AND user_id = ?',
      [projectId, userId],
    );
    return rows[0] ?? null;
  }

  async listAccessibleProjects(userId: string): Promise<Array<ProjectRecord & { role: 'owner' | 'member' }>> {
    return this.db.query<ProjectRecord & { role: 'owner' | 'member' }>(
      'SELECT p.project_id, p.owner_user_id, p.created_at, p.updated_at, pm.role ' +
      'FROM projects p JOIN project_members pm ON pm.project_id = p.project_id ' +
      'WHERE pm.user_id = ? ORDER BY p.updated_at DESC, p.project_id ASC',
      [userId],
    );
  }

  async addMember(projectId: string, userId: string, role: 'owner' | 'member' = 'member'): Promise<void> {
    await this.db.exec(
      'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
      [projectId, userId, role],
    );
  }

  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.db.exec('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  }

  async setMemberRole(projectId: string, userId: string, role: 'owner' | 'member'): Promise<void> {
    await this.db.exec(
      'UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?',
      [role, projectId, userId],
    );
  }

  async listMembers(projectId: string): Promise<MemberRecord[]> {
    return this.db.query<MemberRecord>(
      'SELECT project_id, user_id, role FROM project_members WHERE project_id = ? ORDER BY user_id',
      [projectId],
    );
  }

  async insertToken(record: TokenRecord): Promise<void> {
    await this.db.exec(
      'INSERT INTO mcp_tokens ' +
      '(id, user_id, token_hash, token_prefix, label, audience, created_at, last_used_at, expires_at, revoked_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [record.id, record.user_id, record.token_hash, record.token_prefix, record.label, record.audience,
        record.created_at, record.last_used_at, record.expires_at, record.revoked_at],
    );
  }

  async findTokenByHash(hash: string): Promise<TokenRecord | null> {
    const rows = await this.db.query<TokenRecord>(
      'SELECT id, user_id, token_hash, token_prefix, label, audience, created_at, ' +
      'last_used_at, expires_at, revoked_at FROM mcp_tokens WHERE token_hash = ? AND audience = \'mcp\'',
      [hash],
    );
    return rows[0] ?? null;
  }

  async touchToken(id: string, timestamp = new Date().toISOString()): Promise<void> {
    await this.db.exec('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?', [timestamp, id]);
  }

  async revokeToken(userId: string, id: string, timestamp = new Date().toISOString()): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      'SELECT id FROM mcp_tokens WHERE id = ? AND user_id = ?',
      [id, userId],
    );
    if (result.length === 0) return false;
    await this.db.exec('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ?', [timestamp, id]);
    return true;
  }

  async listTokens(userId: string): Promise<Array<Omit<TokenRecord, 'token_hash'>>> {
    return this.db.query<Array<Omit<TokenRecord, 'token_hash'>>[number]>(
      'SELECT id, user_id, token_prefix, label, audience, created_at, last_used_at, expires_at, revoked_at ' +
      'FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    );
  }
}

let storePromise: Promise<AuthStore> | null = null;
let testStore: AuthStore | null = null;

export async function getAuthStore(): Promise<AuthStore> {
  if (testStore) return testStore;
  if (!storePromise) {
    storePromise = openAuthDb().then((db) => new AuthStore(db));
  }
  return storePromise;
}

export function setAuthStoreForTests(store: AuthStore): void {
  testStore = store;
  storePromise = Promise.resolve(store);
}

export async function resetAuthStoreForTests(): Promise<void> {
  const current = testStore ?? (storePromise ? await storePromise.catch(() => null) : null);
  testStore = null;
  storePromise = null;
  if (current) await current.db.close?.();
}
