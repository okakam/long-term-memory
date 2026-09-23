export function buildContentSecurityPolicy(additionalFormActionOrigins: readonly URL[] = []): string {
  const formAction = ["'self'", ...additionalFormActionOrigins.map(({ origin }) => origin)].join(' ');

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://*.firebaseapp.com https://apis.google.com",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "frame-src 'self' https://*.firebaseapp.com https://*.web.app https://accounts.google.com",
    "base-uri 'self'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join('; ');
}
