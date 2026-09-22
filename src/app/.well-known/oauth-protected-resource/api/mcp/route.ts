import { getOAuthConfiguration } from '@/lib/oauth/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const configuration = getOAuthConfiguration();
    if (!configuration.enabled) return new Response('Not Found', { status: 404 });
    return Response.json({
      resource: configuration.resource.href,
      authorization_servers: [configuration.issuer.origin],
      scopes_supported: ['mcp:access'],
      resource_name: 'long-term-memory',
    }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return new Response('OAuth configuration is invalid', { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
