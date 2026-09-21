import { describe, expect, test } from 'vitest';

import { getFirebaseAuthErrorMessage } from '@/lib/auth/auth-error';

describe('getFirebaseAuthErrorMessage', () => {
  test('ドメイン制限エラーを日本語表示へ変換する', () => {
    expect(getFirebaseAuthErrorMessage(new Error('email domain is not allowed'), '認証に失敗しました'))
      .toBe('okakam.net のメールアドレスのみ利用できます');
  });

  test('その他のErrorは元のメッセージを表示する', () => {
    expect(getFirebaseAuthErrorMessage(new Error('network error'), '認証に失敗しました'))
      .toBe('network error');
  });

  test('Errorでない値はfallbackを表示する', () => {
    expect(getFirebaseAuthErrorMessage('failed', '認証に失敗しました')).toBe('認証に失敗しました');
  });
});
