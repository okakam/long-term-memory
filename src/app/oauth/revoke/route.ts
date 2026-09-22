import { getOAuthConfiguration } from '@/lib/oauth/config';
import { oauthConfigurationErrorResponse, oauthErrorResponse } from '@/lib/oauth/http';
import { OAuthProtocolError, OAuthService } from '@/lib/oauth/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const token = form.get('token');
    if (typeof token !== 'string' || token.length === 0) throw new OAuthProtocolError('invalid_request', 'token is required');
    await new OAuthService().revokeToken(token, request);
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
