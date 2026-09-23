function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function validateDcrRedirectUri(value: string): URL {
  const url = parseUrl(value);
  if (!url
    || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\//.test(value)
    || url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port === '0'
    || url.pathname === '/'
    || url.search
    || url.hash
    || url.username
    || url.password) {
    throw new Error('redirect URI must be a valid http://127.0.0.1 callback');
  }
  return url;
}

export function redirectUriMatches(registered: string, requested: string): boolean {
  const left = parseUrl(registered);
  const right = parseUrl(requested);
  if (!left || !right) return false;

  if (left.protocol === 'http:' && left.hostname === '127.0.0.1'
    && right.protocol === 'http:' && right.hostname === '127.0.0.1') {
    try {
      validateDcrRedirectUri(registered);
      validateDcrRedirectUri(requested);
    } catch {
      return false;
    }
    return left.pathname === right.pathname && left.search === right.search;
  }
  return left.href === right.href;
}
