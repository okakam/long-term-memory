export const ALLOWED_EMAIL_DOMAIN = 'okakam.net';

export function isAllowedEmailDomain(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  return at > 0 && normalized.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}
