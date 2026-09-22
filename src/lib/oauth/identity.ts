import { getFirebasePrincipal } from '@/lib/auth/session';

export interface OAuthIdentityProvider {
  getPrincipal(request: Request): Promise<{ userId: string; email: string | null } | null>;
}

export class FirebaseOAuthIdentityProvider implements OAuthIdentityProvider {
  async getPrincipal(request: Request): Promise<{ userId: string; email: string | null } | null> {
    const principal = await getFirebasePrincipal(request);
    return principal ? { userId: principal.userId, email: principal.email ?? null } : null;
  }
}
