# PAT発行画面の実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/settings/tokens`からMCP PATを発行し、発行直後だけ本文を表示して安全にコピーできるようにする。

**Architecture:** 既存のServer ComponentはFirebase認証とPAT一覧の取得を担当し、発行操作は新しいClient Componentへ分離する。Client Componentは同一Originの`POST /api/auth/tokens`を呼び出し、レスポンスのPATをメモリ上で一度だけ表示する。Clipboard APIが失敗してもPATを選択・手動コピーできるUIを残し、既存のAPI契約は変更しない。

**Tech Stack:** Next.js App Router、React 19、TypeScript、Vitest、Firebase session cookie、既存の`/api/auth/tokens` API。

**Spec:** `docs/reproduction-spec.md`、`docs/superpowers/specs/2026-09-19-cloud-run-firebase-gcs-firestore-design.md`

## Global Constraints

- PAT本文は発行レスポンスで一度だけ返し、FirestoreにはSHA-256 hash、prefix、所有UID、期限、失効日時だけを保存する。
- 本番は`AUTH_REQUIRED=1`とし、PAT APIはFirebase認証済みの同一Originリクエストだけを受け付ける。
- 認証情報、PAT本文、APIキー、実在`.env`はrepositoryへ保存しない。
- 仕様書・運用ドキュメントは日本語で記述する。
- pnpmは`packageManager`に記載された11.1.3を使用する。

---

### Task 1: PAT発行画面の失敗テストを追加する

**Files:**
- Create: `tests/app/token-settings-page.test.ts`
- Modify: `src/app/settings/tokens/page.tsx`（テストが期待する発行コンポーネントの接続箇所）

**Interfaces:**
- Consumes: `TokenSettingsPage()`、`requireWebPrincipal()`、`listPats()`
- Produces: PAT設定画面に発行フォームと一度だけ表示する説明が存在することを検証するテスト

- [x] **Step 1: Write the failing test**

  `TokenSettingsPage()`をモックした認証主体とPAT一覧で描画し、静的HTMLに次の文言・フォーム要素が存在することを検証する。

  ```ts
  import { renderToStaticMarkup } from 'react-dom/server';
  import { expect, test, vi } from 'vitest';

  const mocks = vi.hoisted(() => ({
    requireWebPrincipal: vi.fn(async () => ({ userId: 'user-1' })),
    listPats: vi.fn(async () => []),
  }));
  vi.mock('@/lib/auth/web-principal', () => mocks);
  vi.mock('@/lib/auth/pat', () => ({ listPats: mocks.listPats }));
  vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

  import TokenSettingsPage from '@/app/settings/tokens/page';

  test('PAT設定画面に発行フォームと一度だけ表示する説明がある', async () => {
    const element = await TokenSettingsPage();
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain('PATを発行');
    expect(markup).toContain('作成時に一度だけ表示');
    expect(markup).toContain('token-label');
    expect(markup).toContain('発行');
  });
  ```

- [x] **Step 2: Run test to verify it fails**

  Run: `pnpm exec vitest run tests/app/token-settings-page.test.ts`

  Expected: FAIL because the current page only renders a heading, explanation, and token list; no form or issue button exists.

### Task 2: 発行・表示・コピーUIを実装する

**Files:**
- Create: `src/components/PatTokenSettings.tsx`
- Modify: `src/app/settings/tokens/page.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: `initialTokens: Array<{ id: string; token_prefix: string; label: string; created_at: string; expires_at: string | null; revoked_at: string | null }>`
- Produces: `POST /api/auth/tokens`へ`{ label }`を送り、201レスポンスの`token`を発行直後だけ表示するClient Component

- [x] **Step 1: Write the minimal Client Component**

  `PatTokenSettings`を`'use client'`で作り、ラベル入力、発行ボタン、処理中状態、APIエラー、発行済みPAT表示を実装する。作成リクエストは次の契約を使う。

  ```ts
  const response = await fetch('/api/auth/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: label.trim() }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body === 'string' ? body : 'PATの発行に失敗しました');
  ```

  発行成功後は`body.token`を`<code>`で表示し、クリック操作の中で`navigator.clipboard.writeText`を呼ぶ。Clipboard APIが拒否された場合も発行成功を失敗扱いにせず、手動選択コピーの案内とエラーメッセージを表示する。画面再読み込み後に本文を再表示しない。

- [x] **Step 2: Server Componentから初期一覧を渡す**

  `src/app/settings/tokens/page.tsx`で`requireWebPrincipal()`と`listPats()`を維持し、PAT一覧を`PatTokenSettings`へ渡す。APIやFirestoreの保存契約は変更しない。

- [x] **Step 3: UIの最小スタイルを追加する**

  `globals.css`へ発行フォーム、成功PAT表示、注意文、エラー文の既存スタイル規約に沿ったクラスだけを追加する。PAT本文をログへ出力するコードは追加しない。

- [x] **Step 4: Run the focused tests**

  Run: `pnpm exec vitest run tests/app/token-settings-page.test.ts tests/app/auth.routes.test.ts`

  Expected: PASS.

### Task 3: 運用ドキュメントを画面発行手順へ更新する

**Files:**
- Modify: `docs/google-cloud-cli-setup.md`
- Modify: `docs/cloud-run-production-deployment.md`

**Interfaces:**
- Consumes: 実装済みの`/settings/tokens`画面と`LTM_MCP_TOKEN` GitHub Environment secret運用
- Produces: Cloud Run URLでログインし、画面からPATを発行・コピー・登録する日本語手順

- [x] **Step 1: PAT発行手順を更新する**

  画面の`/settings/tokens`を正規手順として記載し、PAT本文は作成時に一度だけ表示されること、チャット・repository・ログへ貼らないこと、GitHub `production` Environmentの`LTM_MCP_TOKEN`へ登録することを明記する。画面が使えない場合の同一Origin Console API手順は補助手順として残す。

- [x] **Step 2: Documentation checks**

  Run: `pnpm exec vitest run tests/docs/post-mcp-setup.test.ts`

  Expected: PASS.

### Task 4: 全体検証とコミット

**Files:**
- Verify: `git diff --check`
- Verify: `pnpm test`
- Verify: `pnpm lint`
- Verify: `pnpm exec tsc --noEmit`
- Verify: `NODE_ENV=production pnpm build`

- [x] **Step 1: Run the focused and full verification commands**

  Run:

  ```bash
  git diff --check
  pnpm test
  pnpm lint
  pnpm exec tsc --noEmit
  NODE_ENV=production pnpm build
  ```

- [x] **Step 2: Review the diff for secrets**

  Run: `git diff -- . ':!pnpm-lock.yaml'`

  Confirm that no PAT本文、Firebase API key、Secret Manager値、実在`.env`が含まれていない。

- [x] **Step 3: Commit the implementation**

  ```bash
  git add src/app/settings/tokens/page.tsx src/components/PatTokenSettings.tsx src/app/globals.css tests/app/token-settings-page.test.ts docs/google-cloud-cli-setup.md docs/cloud-run-production-deployment.md docs/superpowers/plans/2026-09-21-pat-token-settings-ui.md
  git commit -m "feat: add PAT issuance UI"
  ```
