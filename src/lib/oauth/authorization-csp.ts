import { buildContentSecurityPolicy } from '@/lib/security/content-security-policy';

import { validateDcrRedirectUri } from './redirect';

export function getOAuthAuthorizationPageCsp(redirectUri: string): string {
  return buildContentSecurityPolicy([validateDcrRedirectUri(redirectUri)]);
}
