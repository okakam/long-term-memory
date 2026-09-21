import { getOAuthConfiguration } from '@/lib/oauth/config';
import { OAuthService } from '@/lib/oauth/service';

import {
  requirePatPrincipal,
  UnauthorizedMcpError,
} from '@/lib/auth/pat';

export type McpPrincipal = {
  userId: string;
  credentialId: string;
  credentialKind: 'oauth' | 'pat';
};

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (!match || !match[1] || !match[1].startsWith('ltm_')) throw new UnauthorizedMcpError();
  return match[1];
}

export async function requireMcpPrincipal(request: Request): Promise<McpPrincipal> {
  const token = bearerToken(request);
  if (token.startsWith('ltm_oat_')) {
    let configuration: ReturnType<typeof getOAuthConfiguration>;
    try {
      configuration = getOAuthConfiguration();
    } catch {
      throw new UnauthorizedMcpError();
    }
    if (!configuration.enabled) throw new UnauthorizedMcpError();
    return new OAuthService().verifyAccessToken(token);
  }

  const pat = await requirePatPrincipal(request);
  return { userId: pat.userId, credentialId: pat.tokenId, credentialKind: 'pat' };
}
