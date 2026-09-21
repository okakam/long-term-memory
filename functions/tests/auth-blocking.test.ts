import { expect, test } from 'vitest';

import {
  authBeforeUserCreated,
  authBeforeUserSignedIn,
  enforceAllowedEmail,
} from '../src/index.js';

test('Blocking Functionは許可ドメイン以外をpermission-deniedで拒否する', () => {
  expect(() => enforceAllowedEmail('user@example.com')).toThrowError(
    expect.objectContaining({ code: 'permission-denied' }),
  );
});

test('Blocking Functionはokakam.netを許可する', () => {
  expect(() => enforceAllowedEmail('user@okakam.net')).not.toThrow();
});

test('Blocking Functionのtriggerを2種類エクスポートする', () => {
  expect(authBeforeUserCreated).toBeDefined();
  expect(authBeforeUserSignedIn).toBeDefined();
});
