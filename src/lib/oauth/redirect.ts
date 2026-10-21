const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export function validateDcrRedirectUri(value: string): URL {
  const url = parseUrl(value);
  if (!url
    || !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\//.test(value)
    || !isLoopbackHttp(url)
    || url.port === '0'
    || url.pathname === '/'
    || url.search
    || url.hash
    || url.username
    || url.password) {
    throw new Error('redirect URI must be a valid http://127.0.0.1 or http://localhost callback');
  }
  return url;
}

export function redirectUriMatches(registered: string, requested: string): boolean {
  const left = parseUrl(registered);
  const right = parseUrl(requested);
  if (!left || !right) return false;

  if (isLoopbackHttp(left) && isLoopbackHttp(right)) {
    try {
      validateDcrRedirectUri(registered);
      validateDcrRedirectUri(requested);
    } catch {
      return false;
    }
    return left.hostname === right.hostname
      && left.pathname === right.pathname
      && left.search === right.search;
  }
  return left.href === right.href;
}
