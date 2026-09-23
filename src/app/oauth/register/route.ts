import { getOAuthConfiguration } from '@/lib/oauth/config';
import { oauthConfigurationErrorResponse, oauthErrorResponse } from '@/lib/oauth/http';
import { DcrClientRegistrationSchema, OAuthProtocolError, OAuthService } from '@/lib/oauth/service';
import { MCP_OAUTH_SCOPE } from '@/lib/oauth/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function contentType(request: Request, expected: string): boolean {
  return (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() === expected;
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
    if (!contentType(request, 'application/json')) throw new OAuthProtocolError('invalid_request', 'JSON content type is required');
    const parsed = DcrClientRegistrationSchema.safeParse(await request.json());
    if (!parsed.success) throw new OAuthProtocolError('invalid_client_metadata', 'client metadata is invalid');
    const client = await new OAuthService().registerPublicClient(parsed.data, request);
    return Response.json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      scope: MCP_OAUTH_SCOPE,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
