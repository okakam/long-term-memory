import type { Firestore } from 'firebase-admin/firestore';

import type { AuthStoreLike, MemberRecord, ProjectRecord, TokenRecord } from './store';
import { createFirestoreMetadataStore, type FirestoreMetadataStore } from '@/lib/storage/firestore-metadata';

export class FirestoreAuthStore implements AuthStoreLike {
  constructor(private readonly metadata: FirestoreMetadataStore) {}

  static fromFirestore(firestore: Firestore): FirestoreAuthStore {
    return new FirestoreAuthStore(createFirestoreMetadataStore(firestore));
  }

  createProject(projectId: string, ownerUserId: string, now?: string): Promise<void> {
    return this.metadata.createProject(projectId, ownerUserId, now);
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    return this.metadata.getProject(projectId);
  }

  getMembership(projectId: string, userId: string): Promise<MemberRecord | null> {
    return this.metadata.getMembership(projectId, userId);
  }

  async listAccessibleProjects(userId: string): Promise<Array<ProjectRecord & { role: 'owner' | 'member' }>> {
    return this.metadata.listAccessibleProjects(userId);
  }

  addMember(projectId: string, userId: string, role?: 'owner' | 'member'): Promise<void> {
    return this.metadata.addMember(projectId, userId, role);
  }

  removeMember(projectId: string, userId: string): Promise<void> {
    return this.metadata.removeMember(projectId, userId);
  }

  setMemberRole(projectId: string, userId: string, role: 'owner' | 'member'): Promise<void> {
    return this.metadata.setMemberRole(projectId, userId, role);
  }

  listMembers(projectId: string): Promise<MemberRecord[]> {
    return this.metadata.listMembers(projectId);
  }

  insertToken(record: TokenRecord): Promise<void> {
    return this.metadata.insertToken(record);
  }

  findTokenByHash(hash: string): Promise<TokenRecord | null> {
    return this.metadata.findTokenByHash(hash);
  }

  touchToken(id: string, timestamp?: string, tokenHash?: string): Promise<void> {
    return this.metadata.touchToken(id, timestamp, tokenHash);
  }

  revokeToken(userId: string, id: string, timestamp?: string): Promise<boolean> {
    return this.metadata.revokeToken(userId, id, timestamp);
  }

  listTokens(userId: string): Promise<Array<Omit<TokenRecord, 'token_hash'>>> {
    return this.metadata.listTokens(userId);
  }
}
