import { expect, test } from 'vitest';

import {
  authBeforeUserCreated,
  authBeforeUserSignedIn,
  enforceAllowedEmail,
} from '../src/index.js';

type BlockingTrigger = {
  run: (event: { data?: { email?: string } }) => void;
};

function invoke(trigger: unknown, email?: unknown): void {
  const event = email === undefined ? {} : { data: { email: email as string } };
  (trigger as BlockingTrigger).run(event);
}

const triggers = [
  ['beforeUserCreated', authBeforeUserCreated],
  ['beforeUserSignedIn', authBeforeUserSignedIn],
] as const;

test('Blocking Functionは許可ドメイン以外をpermission-deniedで拒否する', () => {
  expect(() => enforceAllowedEmail('user@example.com')).toThrowError(
    expect.objectContaining({ code: 'permission-denied', message: 'email domain is not allowed' }),
  );
});

test('Blocking Functionはokakam.netを許可する', () => {
  expect(() => enforceAllowedEmail('user@okakam.net')).not.toThrow();
  expect(() => enforceAllowedEmail('USER@OKAKAM.NET')).not.toThrow();
});

test.each(triggers)('Blocking Functionの%s triggerが許可ドメイン以外を拒否する', (_, trigger) => {
  expect(() => invoke(trigger, 'user@example.com')).toThrowError(
    expect.objectContaining({ code: 'permission-denied' }),
  );
  expect(() => invoke(trigger, undefined)).toThrowError(
    expect.objectContaining({ code: 'permission-denied' }),
  );
});

test.each(triggers)('Blocking Functionの%s triggerが境界値を正しく判定する', (_, trigger) => {
  expect(() => invoke(trigger, 'USER@OKAKAM.NET')).not.toThrow();
  expect(() => invoke(trigger, 'user@sub.okakam.net')).toThrow();
  expect(() => invoke(trigger, 'user@okakam.net.evil')).toThrow();
  expect(() => invoke(trigger, 'user@example.com')).toThrow();
});
