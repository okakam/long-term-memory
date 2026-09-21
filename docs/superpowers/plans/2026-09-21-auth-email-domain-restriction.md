# 認証メールドメイン制限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Firebase AuthenticationとCloud Runの両方で、`@okakam.net` のメールアドレスだけが本番ログインできるようにする。

**Architecture:** Firebase Authentication with Identity Platformの`beforeUserCreated`と`beforeUserSignedIn`で認証処理を拒否し、Cloud RunのFirebase Admin SDK principal生成でも同じ完全一致判定を行う。Firebase Blocking Functionsは`functions/`の独立TypeScriptパッケージとしてデプロイし、Cloud Runアプリは既存の`AUTH_REQUIRED=0`ローカル動作を維持する。

**Tech Stack:** Next.js 16、Firebase Web SDK、Firebase Admin SDK、Firebase Functions v2 Identity Blocking Functions、TypeScript、Vitest、pnpm 11.1.3、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-21-auth-email-domain-restriction-design.md`

## Global Constraints

- 許可ドメインは`okakam.net`だけとし、比較は小文字化後のメールアドレスの`@`以降の完全一致で行う。
- `user@sub.okakam.net`、`user@okakam.net.example`、メールアドレスなし、メールアドレス以外の値は拒否する。
- ローカルの`AUTH_REQUIRED=0`は変更せず、Cloud Run本番の`AUTH_REQUIRED=1`で制限を適用する。
- Google OAuthの`hd=okakam.net`はアカウント選択画面のヒントにだけ使い、認可判定には使わない。
- 認証情報、APIキー、PAT、実在の`.env`はコミットしない。
- 既存PATは自動失効させず、Firebase認証経路の制限だけを実装する。
- 既存のCloud Run、GCS、Firestore、MCP認証の構成とAPI契約を変更しない。
- 変更するテキストファイルはLF改行で保存し、`git diff --check`を通す。

---

### Task 1: アプリ共通のメールドメイン判定

**Files:**
- Create: `src/lib/auth/email-domain.ts`
- Create: `tests/lib/auth/email-domain.test.ts`

**Interfaces:**
- Produces `ALLOWED_EMAIL_DOMAIN: 'okakam.net'` and `isAllowedEmailDomain(email: unknown): boolean` for Cloud Run auth code and UI error handling.

- [x] **Step 1: Write the failing test**

```ts
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/lib/auth/email-domain.test.ts`

Expected: FAIL because `src/lib/auth/email-domain.ts` does not exist.

- [x] **Step 3: Write minimal implementation**

```ts
export const ALLOWED_EMAIL_DOMAIN = 'okakam.net';

export function isAllowedEmailDomain(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  return at > 0 && normalized.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/lib/auth/email-domain.test.ts`

Expected: PASS with four tests passing.

- [x] **Step 5: Commit**

```bash
git add src/lib/auth/email-domain.ts tests/lib/auth/email-domain.test.ts
git commit -m "feat: add allowed auth email domain policy"
```

### Task 2: Cloud Run Firebase principalとsession交換の拒否

**Files:**
- Modify: `src/lib/auth/firebase.ts`
- Modify: `src/app/api/auth/session/route.ts`
- Modify: `tests/lib/auth/firebase.test.ts`
- Modify: `tests/app/auth.firebase-routes.test.ts`

**Interfaces:**
- Consumes `isAllowedEmailDomain` from Task 1.
- Produces `ForbiddenFirebaseError` with `status = 403` and message `email domain is not allowed`.
- `verifyFirebaseIdToken`と`verifyFirebaseSessionCookie`は許可外メールのprincipalを返さず、`POST /api/auth/session`は403とcookieなしを返す。

- [x] **Step 1: Write the failing tests**

Update the existing test fixtures to use `user@okakam.net`, then add these assertions:

```ts
test('許可外メールのFirebase ID tokenをprincipalへ変換しない', async () => {
  setFirebaseAuthForTests({
    ...auth,
    verifyIdToken: vi.fn(async () => ({
      uid: 'external-user',
      email: 'user@example.com',
      email_verified: true,
    })),
  });

  await expect(verifyFirebaseIdToken('external-token')).rejects.toMatchObject({
    status: 403,
    message: 'email domain is not allowed',
  });
});
```

```ts
test('session endpointは許可外メールへcookieを発行しない', async () => {
  const createSessionCookie = vi.fn(async () => 'must-not-be-issued');
  setFirebaseAuthForTests({
    ...auth,
    verifyIdToken: vi.fn(async () => ({ uid: 'external-user', email: 'user@example.com' })),
    createSessionCookie,
  });

  const response = await POST(new Request('https://example.test/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: 'external-token' }),
  }));

  expect(response.status).toBe(403);
  expect(await response.text()).toBe('email domain is not allowed');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(createSessionCookie).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/lib/auth/firebase.test.ts tests/app/auth.firebase-routes.test.ts`

Expected: the new principal test receives a principal instead of a 403, and the new route test receives a 204 instead of a 403.

- [x] **Step 3: Write minimal implementation**

Add the error and enforce the policy when converting decoded tokens:

```ts
import { isAllowedEmailDomain } from './email-domain';

export class ForbiddenFirebaseError extends Error {
  readonly status = 403;

  constructor() {
    super('email domain is not allowed');
    this.name = 'ForbiddenFirebaseError';
  }
}

function principal(decoded: FirebaseDecodedToken): FirebasePrincipal {
  if (!decoded.uid) throw new UnauthorizedFirebaseError();
  if (!isAllowedEmailDomain(decoded.email)) throw new ForbiddenFirebaseError();
  return {
    userId: decoded.uid,
    email: decoded.email,
    emailVerified: decoded.email_verified,
  };
}
```

Handle the error separately in the session route:

```ts
import { ForbiddenFirebaseError } from '@/lib/auth/firebase';

  } catch (cause) {
    if (cause instanceof ForbiddenFirebaseError) {
      return new Response(cause.message, { status: cause.status });
    }
    return new Response('authentication required', { status: 401 });
  }
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/lib/auth/firebase.test.ts tests/app/auth.firebase-routes.test.ts`

Expected: all tests in both files pass, including the existing allowed-user and invalid-token cases.

- [x] **Step 5: Commit**

```bash
git add src/lib/auth/firebase.ts src/app/api/auth/session/route.ts tests/lib/auth/firebase.test.ts tests/app/auth.firebase-routes.test.ts
git commit -m "feat: enforce auth email domain in Cloud Run"
```

### Task 3: Google provider hint、session失敗時のsign out、UIエラー表示

**Files:**
- Modify: `src/lib/auth/firebase-client.ts`
- Modify: `src/components/FirebaseAuthForm.tsx`
- Create: `src/lib/auth/auth-error.ts`
- Create: `tests/lib/auth/auth-error.test.ts`
- Create: `tests/lib/auth/firebase-client.test.ts`

**Interfaces:**
- Consumes `ALLOWED_EMAIL_DOMAIN` from Task 1.
- Produces `createGoogleProvider(): GoogleAuthProvider` with custom parameter `{ hd: 'okakam.net' }`.
- `establishSession` signs out the Firebase client if session exchange returns an error, then preserves the original response message.
- `getFirebaseAuthErrorMessage(cause, fallback)` maps the server message to `okakam.net のメールアドレスのみ利用できます`.

- [x] **Step 1: Write the failing tests**

```ts
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
```

For the client module, mock `firebase/app` and `firebase/auth` before importing the module. The `firebase/auth` mock must provide `GoogleAuthProvider` with `setCustomParameters` and `getCustomParameters`, `getAuth` returning `auth`, and a mocked `signOut`; stub `fetch` only in the session-exchange test. Then verify the wished behavior:

```ts
test('Google providerはokakam.netをアカウント選択のヒントにする', () => {
  expect(createGoogleProvider().getCustomParameters()).toEqual({ hd: 'okakam.net' });
});

test('session交換に失敗したらFirebase client userをsign outする', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('email domain is not allowed', { status: 403 })));
  await expect(establishSession({ user: { getIdToken: vi.fn(async () => 'id-token') } } as UserCredential))
    .rejects.toThrow('email domain is not allowed');
  expect(signOut).toHaveBeenCalledWith(auth);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/lib/auth/auth-error.test.ts tests/lib/auth/firebase-client.test.ts`

Expected: the new error helper and Google provider export are missing; no production client implementation exists for the assertions.

- [x] **Step 3: Write minimal implementation**

Create the display helper:

```ts
export function getFirebaseAuthErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  if (cause.message === 'email domain is not allowed') {
    return 'okakam.net のメールアドレスのみ利用できます';
  }
  return cause.message || fallback;
}
```

Create the provider and preserve the original session error while signing out:

```ts
export function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_EMAIL_DOMAIN });
  return provider;
}

export async function signInWithGoogle(): Promise<UserCredential> {
  return signInWithPopup(await clientAuth(), createGoogleProvider());
}

export async function establishSession(credential: UserCredential): Promise<void> {
  const auth = await clientAuth();
  const idToken = await credential.user.getIdToken();
  const response = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (response.ok) return;
  const message = await response.text();
  await signOut(auth).catch(() => undefined);
  throw new Error(message || 'authentication required');
}
```

Use `getFirebaseAuthErrorMessage` in both existing form catch blocks.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/lib/auth/auth-error.test.ts tests/lib/auth/firebase-client.test.ts`

Expected: all helper and Firebase client tests pass.

- [x] **Step 5: Commit**

```bash
git add src/lib/auth/firebase-client.ts src/components/FirebaseAuthForm.tsx src/lib/auth/auth-error.ts tests/lib/auth/auth-error.test.ts tests/lib/auth/firebase-client.test.ts
git commit -m "feat: improve restricted auth client flow"
```

### Task 4: Firebase Auth Blocking Functionsの追加

**Files:**
- Create: `functions/package.json`
- Create: `functions/pnpm-lock.yaml`
- Create: `functions/tsconfig.json`
- Create: `functions/src/email-domain.ts`
- Create: `functions/src/index.ts`
- Create: `functions/tests/auth-blocking.test.ts`
- Modify: `firebase.json`
- Modify: `tsconfig.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces `authBeforeUserCreated` and `authBeforeUserSignedIn` Firebase Functions v2 blocking triggers.
- Both triggers call `enforceAllowedEmail(email)` and throw `HttpsError('permission-denied', 'Only okakam.net accounts are allowed.')` for all non-allowed values.
- `functions/package.json` uses Node.js 22, `firebase-functions` 7.4.0, TypeScript, and Vitest; `functions/lib` and `functions/node_modules` remain ignored.

- [x] **Step 1: Add the functions package configuration**

Create `functions/package.json` with:

```json
{
  "name": "long-term-memory-auth-functions",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "engines": { "node": "22" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run tests"
  },
  "dependencies": {
    "firebase-functions": "7.4.0"
  },
  "devDependencies": {
    "@types/node": "^20",
    "typescript": "^5",
    "vitest": "^4.1.11"
  }
}
```

Create a NodeNext TypeScript configuration with `rootDir: "src"`, `outDir: "lib"`, strict checking, source maps, `include: ["src/**/*.ts"]`, and `exclude: ["src/**/*.test.ts"]`.

Run: `pnpm --dir functions --ignore-workspace install --ignore-scripts`

Expected: `functions/pnpm-lock.yaml` is generated and the package installs without modifying the root application lockfile.

- [x] **Step 2: Write the failing blocking policy test**

```ts
import { expect, test } from 'vitest';

import { enforceAllowedEmail } from '../src/index.js';

test('Blocking Functionは許可ドメイン以外をpermission-deniedで拒否する', () => {
  expect(() => enforceAllowedEmail('user@example.com')).toThrowError(
    expect.objectContaining({ code: 'permission-denied' }),
  );
});

test('Blocking Functionはokakam.netを許可する', () => {
  expect(() => enforceAllowedEmail('user@okakam.net')).not.toThrow();
});

test('Blocking Functionのtriggerを2種類エクスポートする', async () => {
  const functions = await import('../src/index.js');
  expect(functions.authBeforeUserCreated).toBeDefined();
  expect(functions.authBeforeUserSignedIn).toBeDefined();
});
```

- [x] **Step 3: Run the functions test to verify it fails**

Run: `pnpm --dir functions --ignore-workspace test`

Expected: FAIL because `functions/src/index.ts` and `enforceAllowedEmail` do not exist.

- [x] **Step 4: Implement the functions and Firebase configuration**

Create `functions/src/email-domain.ts` with the same exact-match policy as the Cloud Run helper:

```ts
export const ALLOWED_EMAIL_DOMAIN = 'okakam.net';

export function isAllowedEmailDomain(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  return at > 0 && normalized.slice(at + 1) === ALLOWED_EMAIL_DOMAIN;
}
```

Create the exact policy and triggers:

```ts
import {
  beforeUserCreated,
  beforeUserSignedIn,
  HttpsError,
} from 'firebase-functions/v2/identity';

import { isAllowedEmailDomain } from './email-domain.js';

export function enforceAllowedEmail(email: unknown): void {
  if (!isAllowedEmailDomain(email)) {
    throw new HttpsError('permission-denied', 'Only okakam.net accounts are allowed.');
  }
}

export const authBeforeUserCreated = beforeUserCreated((event) => {
  enforceAllowedEmail(event.data?.email);
});

export const authBeforeUserSignedIn = beforeUserSignedIn((event) => {
  enforceAllowedEmail(event.data?.email);
});
```

Add `functions` to `firebase.json`:

```json
{
  "functions": {
    "source": "functions",
    "predeploy": ["npm --prefix $RESOURCE_DIR run build"]
  }
}
```

Exclude `functions` from the root Next.js `tsconfig.json`, because it has its own NodeNext compiler boundary and dependencies. Add `/functions/lib/`, `/functions/node_modules/`, and `/functions/.firebase/` to `.gitignore`.

- [x] **Step 5: Run functions tests and build**

Run: `pnpm --dir functions --ignore-workspace test && pnpm --dir functions --ignore-workspace build`

Expected: policy tests pass and `functions/lib/index.js` is emitted without TypeScript errors.

- [x] **Step 6: Commit**

```bash
git add functions firebase.json tsconfig.json .gitignore
git commit -m "feat: add Firebase auth blocking functions"
```

### Task 5: CI・Firebase/GCP運用ドキュメントの同期

**Files:**
- Modify: `.github/workflows/cloud-run.yml`
- Modify: `docs/google-cloud-cli-setup.md`
- Modify: `docs/reproduction-spec.md`
- Modify: `docs/cloud-run-production-deployment.md`
- Modify: `AGENTS.md`
- Create: `tests/deploy/auth-domain-restriction.test.ts`

**Interfaces:**
- CI verifies `functions` dependencies, tests, and build without Firebase credentials; it does not deploy Firebase Functions from pull requests or Cloud Run deploy jobs.
- CLI documentation lists the exact required APIs, Identity Platform upgrade, `firebase deploy --only functions`, and `okakam.net` acceptance cases.
- Deployment documentation records that Firebase Functions deployment is a separate authenticated operation from Cloud Run deployment.

- [x] **Step 1: Write the failing configuration tests**

Add tests that read repository files and assert the required operational contract:

```ts
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('CIはFirebase Blocking Functionsのtestとbuildを実行する', async () => {
  const workflow = await readFile('.github/workflows/cloud-run.yml', 'utf8');
  expect(workflow).toContain('pnpm --dir functions --ignore-workspace install --frozen-lockfile --ignore-scripts');
  expect(workflow).toContain('pnpm --dir functions --ignore-workspace test');
  expect(workflow).toContain('pnpm --dir functions --ignore-workspace build');
});

test('運用ドキュメントはokakam.net制限とFunctions deployを記載する', async () => {
  const setup = await readFile('docs/google-cloud-cli-setup.md', 'utf8');
  const production = await readFile('docs/cloud-run-production-deployment.md', 'utf8');
  expect(setup).toContain('firebase deploy --project="$LTM_PROJECT_ID" --only functions');
  expect(setup).toContain('eventarcpublishing.googleapis.com');
  expect(production).toContain('okakam.net');
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/deploy/auth-domain-restriction.test.ts`

Expected: FAIL because CI and the operational documents do not yet contain the new Functions verification/deployment instructions.

- [x] **Step 3: Update CI and documents**

Add these steps after the root dependency install in `verify`:

```yaml
      - run: pnpm --dir functions --ignore-workspace install --frozen-lockfile --ignore-scripts
      - run: pnpm --dir functions --ignore-workspace test
      - run: pnpm --dir functions --ignore-workspace build
```

Update the API command list with `cloudfunctions.googleapis.com`, `eventarc.googleapis.com`, `eventarcpublishing.googleapis.com`, and `pubsub.googleapis.com`. Document that Firebase Authentication with Identity Platform must be upgraded, that Email/Password and Google remain enabled, and that the deployed triggers apply to both new registration and existing-user sign-in. Document:

```bash
firebase deploy --project="$LTM_PROJECT_ID" --only functions
```

Record that Functions deployment must be run after each blocking-function change, and add acceptance checks for an allowed `@okakam.net` account, a disallowed Email/Password account, a disallowed Google account, and an existing disallowed user re-login. Update the reproduction spec and `AGENTS.md` to make the domain policy and separate Functions deployment part of the canonical architecture.

- [x] **Step 4: Run configuration tests**

Run: `pnpm exec vitest run tests/deploy/auth-domain-restriction.test.ts`

Expected: all configuration contract tests pass.

- [x] **Step 5: Commit**

```bash
git add .github/workflows/cloud-run.yml docs/google-cloud-cli-setup.md docs/reproduction-spec.md docs/cloud-run-production-deployment.md AGENTS.md tests/deploy/auth-domain-restriction.test.ts
git commit -m "docs: document restricted Firebase auth operations"
```

### Task 6: 全体検証と外部設定の受入確認

**Files:**
- Modify: no source files; verify the complete branch.

- [x] **Step 1: Run repository verification**

Run all commands:

```bash
pnpm test
pnpm lint
pnpm exec tsc --noEmit
NODE_ENV=production pnpm build
git diff --check
docker compose -f .devcontainer/compose.yaml config --quiet
```

Expected: each available command exits with status 0. The Docker image and Compose verification are not run in this devcontainer because the Docker CLI is unavailable and the user requested that local Docker validation remain externally managed; this is recorded as an external gate rather than an implementation failure.

- [x] **Step 2: Verify repository state**

Run: `git status --short --branch && git diff --stat HEAD~6..HEAD`

Expected: only the planned source, tests, configuration, and Japanese documentation changes are present; no credential or real environment file is tracked.

- [x] **Step 3: Report external gates without claiming them as local verification**

The user must run the following after the code is merged or from the authenticated development container:

```bash
gcloud services enable cloudfunctions.googleapis.com eventarc.googleapis.com eventarcpublishing.googleapis.com pubsub.googleapis.com --project="$LTM_PROJECT_ID"
firebase deploy --project="$LTM_PROJECT_ID" --only functions
```

Then verify the four authentication acceptance cases in the Firebase Console and rerun the Cloud Run smoke. Record the external result separately from the local test/build result.
