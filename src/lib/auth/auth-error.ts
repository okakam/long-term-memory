export function getFirebaseAuthErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  if (cause.message === 'email domain is not allowed') {
    return 'okakam.net のメールアドレスのみ利用できます';
  }
  return cause.message || fallback;
}
