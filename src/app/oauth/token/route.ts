import { getOAuthConfiguration } from '@/lib/oauth/config';
import { oauthConfigurationErrorResponse, oauthErrorResponse } from '@/lib/oauth/http';
import { OAuthProtocolError, OAuthService } from '@/lib/oauth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function formValue(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function POST(request: Request): Promise<Response> {
  let configuration: ReturnType<typeof getOAuthConfiguration>;
  try {
    configuration = getOAuthConfiguration();
  } catch {
    return oauthConfigurationErrorResponse();
  }
  if (!configuration.enabled) return new Response('Not Found', { status: 404 });

  try {
    if ((request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      throw new OAuthProtocolError('invalid_request', 'form-urlencoded content type is required');
    }
    const form = await request.formData();
    const grantType = formValue(form, 'grant_type');
    const clientId = formValue(form, 'client_id');
    if (!grantType || !clientId) throw new OAuthProtocolError('invalid_request', 'grant_type and client_id are required');
    const service = new OAuthService();
    const token = grantType === 'authorization_code'
      ? await service.exchangeAuthorizationCode({
        clientId,
        code: formValue(form, 'code') ?? '',
        redirectUri: formValue(form, 'redirect_uri') ?? '',
        codeVerifier: formValue(form, 'code_verifier') ?? '',
      }, request)
      : grantType === 'refresh_token'
        ? await service.refreshAccessToken({
          clientId,
          refreshToken: formValue(form, 'refresh_token') ?? '',
          resource: formValue(form, 'resource'),
        }, request)
        : (() => { throw new OAuthProtocolError('invalid_request', 'grant_type is not supported'); })();
    return Response.json({
      access_token: token.accessToken,
      token_type: 'Bearer',
      expires_in: token.expiresIn,
      refresh_token: token.refreshToken,
      scope: token.scope,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
