export function authRequired(): boolean {
  return process.env.AUTH_REQUIRED === '1' || process.env.VERCEL === '1';
}

export function authConfigurationReady(): boolean {
  if (!authRequired()) return true;
  return Boolean(process.env.CLERK_SECRET_KEY);
}
