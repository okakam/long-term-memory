const OAUTH_TRANSACTION_PATTERN = /^ltm_oatx_[A-Za-z0-9_-]{43}$/;
const INTERNAL_BASE = 'https://oauth.internal.invalid';

export function parseOAuthTransaction(value: unknown): string | null {
  return typeof value === 'string' && OAUTH_TRANSACTION_PATTERN.test(value) ? value : null;
}

export function oauthAuthorizationContinuation(value: unknown): string | null {
  const transaction = parseOAuthTransaction(value);
  return transaction ? `/oauth/authorize?oauth_transaction=${encodeURIComponent(transaction)}` : null;
}

export function transactionFromContinuation(continuation: string | null | undefined): string | null {
  if (!continuation) return null;
  let url: URL;
  try {
    url = new URL(continuation, INTERNAL_BASE);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_BASE || url.pathname !== '/oauth/authorize' || url.hash || url.searchParams.size !== 1) {
    return null;
  }
  return parseOAuthTransaction(url.searchParams.get('oauth_transaction'));
}

export function authSwitchHref(pathname: '/sign-in' | '/sign-up', continuation: string | null | undefined): string {
  const transaction = transactionFromContinuation(continuation);
  return transaction ? `${pathname}?oauth_transaction=${encodeURIComponent(transaction)}` : pathname;
}
