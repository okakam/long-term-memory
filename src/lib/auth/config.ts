export function authRequired(): boolean {
  return process.env.AUTH_REQUIRED === '1';
}

export function authConfigurationReady(): boolean {
  if (!authRequired()) return true;
  return Boolean(process.env.FIREBASE_PROJECT_ID);
}
