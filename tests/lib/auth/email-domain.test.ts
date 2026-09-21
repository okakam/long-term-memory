import { describe, expect, test } from 'vitest';

import { isAllowedEmailDomain } from '@/lib/auth/email-domain';

describe('isAllowedEmailDomain', () => {
  test('許可ドメインのメールアドレスを受け入れる', () => {
    expect(isAllowedEmailDomain('user@okakam.net')).toBe(true);
  });

  test('ドメインの大文字小文字を正規化して受け入れる', () => {
    expect(isAllowedEmailDomain('User@OKAKAM.NET')).toBe(true);
  });

  test('サブドメインと類似ドメインを拒否する', () => {
    expect(isAllowedEmailDomain('user@sub.okakam.net')).toBe(false);
    expect(isAllowedEmailDomain('user@okakam.net.example')).toBe(false);
  });

  test('メールアドレスでない値を拒否する', () => {
    expect(isAllowedEmailDomain(undefined)).toBe(false);
    expect(isAllowedEmailDomain(null)).toBe(false);
    expect(isAllowedEmailDomain('okakam.net')).toBe(false);
  });
});
