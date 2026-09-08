import { handleMcpRequest } from '@/lib/mcp/transport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export async function GET(): Promise<Response> {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function DELETE(): Promise<Response> {
  return new Response('Method Not Allowed', { status: 405 });
}

export async function OPTIONS(req: Request): Promise<Response> {
  const origin = req.headers.get('origin');
  const configured = (process.env.MCP_ALLOWED_ORIGINS ?? process.env.MCP_PUBLIC_URL ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try { return new URL(value).origin; } catch { return value; }
    });
  if (!origin || configured.length === 0 || !configured.includes(origin)) {
    return new Response('forbidden', { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, X-LTM-Maintenance-Token, Mcp-Session-Id',
      vary: 'Origin',
    },
  });
}
