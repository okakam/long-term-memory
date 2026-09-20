export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONFIG_KEYS = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
] as const;

export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).search) return new Response('query parameters are not allowed', { status: 400 });
  const values = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key] ?? ''])) as Record<typeof CONFIG_KEYS[number], string>;
  if (Object.values(values).some((value) => value.length === 0)) {
    return Response.json({ error: 'Firebase client configuration is unavailable' }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
  return Response.json({
    apiKey: values.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: values.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: values.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: values.NEXT_PUBLIC_FIREBASE_APP_ID,
  }, { headers: { 'cache-control': 'no-store' } });
}
