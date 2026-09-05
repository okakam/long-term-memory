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
