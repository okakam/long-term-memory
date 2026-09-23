import { getOAuthConfiguration } from '@/lib/oauth/config';
import { getOAuthAuthorizationPageCsp } from '@/lib/oauth/authorization-csp';
import { oauthConfigurationErrorResponse, oauthErrorResponse } from '@/lib/oauth/http';
import { OAuthProtocolError, type OAuthAuthorizationRequest, OAuthService } from '@/lib/oauth/service';
import { renderOAuthAuthorizationPage } from '@/components/OAuthAuthorizationPage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TRANSACTION_PATTERN = /^ltm_oatx_[A-Za-z0-9_-]{43}$/;
const TRANSACTION_COOKIE = 'ltm_oauth_tx';
const CSRF_COOKIE = 'ltm_oauth_csrf';

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Path=/${secure}`;
}

function appendAuthorizationCookies(response: Response, transactionId: string, csrfToken: string): void {
  response.headers.append('set-cookie', cookie(TRANSACTION_COOKIE, transactionId, 600));
  response.headers.append('set-cookie', cookie(CSRF_COOKIE, csrfToken, 600));
}

function clearAuthorizationCookies(response: Response): void {
  response.headers.append('set-cookie', cookie(TRANSACTION_COOKIE, '', 0));
  response.headers.append('set-cookie', cookie(CSRF_COOKIE, '', 0));
}

function redirectToSignIn(issuer: URL, transactionId: string): Response {
  const location = new URL('/sign-in', issuer);
  location.searchParams.set('oauth_transaction', transactionId);
  return new Response(null, { status: 302, headers: { location: location.href } });
}

function formValue(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function authorizationInput(request: Request): OAuthAuthorizationRequest {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const responseType = url.searchParams.get('response_type');
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');
  if (!clientId || !redirectUri || !responseType || !codeChallenge || !codeChallengeMethod) {
    throw new OAuthProtocolError('invalid_request', 'authorization parameters are incomplete');
  }
  return {
    clientId,
    redirectUri,
    responseType: responseType as 'code',
    scope: (url.searchParams.get('scope') ?? 'mcp:access') as 'mcp:access',
    resource: url.searchParams.get('resource') ?? getOAuthConfiguration().resource.href,
    state: url.searchParams.get('state'),
    codeChallenge,
    codeChallengeMethod: codeChallengeMethod as 'S256',
  };
}

function renderAuthorizationPage(start: { transactionId: string; csrfToken: string; clientName: string; scope: string; redirectUri: string }): Response {
  const markup = renderOAuthAuthorizationPage(start);
  return new Response(`<!doctype html>${markup}`, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': getOAuthAuthorizationPageCsp(start.redirectUri),
      'content-type': 'text/html; charset=utf-8',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  let configuration: ReturnType<typeof getOAuthConfiguration>;
  try {
    configuration = getOAuthConfiguration();
  } catch {
    return oauthConfigurationErrorResponse();
  }
  if (!configuration.enabled) return new Response('Not Found', { status: 404 });

  try {
    const service = new OAuthService();
    const existingTransaction = new URL(request.url).searchParams.get('oauth_transaction');
    let start;
    if (existingTransaction !== null) {
      if (!TRANSACTION_PATTERN.test(existingTransaction) || cookieValue(request, TRANSACTION_COOKIE) !== existingTransaction) {
        throw new OAuthProtocolError('invalid_request', 'OAuth transaction is invalid');
      }
      const csrfToken = cookieValue(request, CSRF_COOKIE);
      if (!csrfToken) throw new OAuthProtocolError('invalid_request', 'OAuth transaction is invalid');
      start = await service.resumeAuthorization(existingTransaction, csrfToken);
    } else {
      start = await service.beginAuthorization(authorizationInput(request), request);
    }

    if (!await service.identityProvider.getPrincipal(request)) {
      const response = redirectToSignIn(configuration.issuer, start.transactionId);
      appendAuthorizationCookies(response, start.transactionId, start.csrfToken);
      return response;
    }
    const response = renderAuthorizationPage(start);
    appendAuthorizationCookies(response, start.transactionId, start.csrfToken);
    return response;
  } catch (error) {
    return oauthErrorResponse(error);
  }
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
    const transactionId = formValue(form, 'transaction_id');
    const csrfToken = formValue(form, 'csrf_token');
    const decision = formValue(form, 'decision');
    if (!transactionId || !csrfToken || !TRANSACTION_PATTERN.test(transactionId) || decision === null || !['approve', 'deny'].includes(decision)) {
      throw new OAuthProtocolError('invalid_request', 'authorization form is invalid');
    }
    if (cookieValue(request, TRANSACTION_COOKIE) !== transactionId || cookieValue(request, CSRF_COOKIE) !== csrfToken) {
      throw new OAuthProtocolError('invalid_request', 'authorization form is invalid');
    }
    const service = new OAuthService();
    const principal = await service.identityProvider.getPrincipal(request);
    if (!principal) return redirectToSignIn(configuration.issuer, transactionId);
    const approval = await service.approveAuthorization({
      transactionId, csrfToken, userId: principal.userId, approved: decision === 'approve',
    });
    const location = new URL(approval.redirectUri);
    if (approval.state !== null) location.searchParams.set('state', approval.state);
    if (approval.code) location.searchParams.set('code', approval.code);
    if (approval.error) location.searchParams.set('error', approval.error);
    const response = new Response(null, { status: 302, headers: { location: location.href } });
    clearAuthorizationCookies(response);
    return response;
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
