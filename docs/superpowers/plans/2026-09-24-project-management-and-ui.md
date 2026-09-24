# プロジェクト管理とWeb UI刷新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboardでproject作成とowner/member管理を完結させ、ログイン・OAuth同意・Dashboardを一貫した安全なUIへ刷新する。

**Architecture:** FirestoreのUID-based membershipを認可の正本に保ち、Firebase Admin SDKのdirectory lookupをUI用のemail→UID変換にだけ使う。server routeはowner authorizationとlast-owner制約を担い、client componentsはAPI呼び出しと表示状態を担う。OAuth同意はraw HTML routeを維持し、既存CSP内のinline styleだけで認証shellを描画する。

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Firebase Authentication/Admin SDK, Firestore, Vitest, CSS

**Spec:** `docs/superpowers/specs/2026-09-24-project-management-and-ui-design.md`

## Global Constraints

- FirebaseはWeb本人確認、Firestore membershipはMCP/Web authorizationの正本として維持する。
- OAuthの同意はproject又はmembershipを作成・変更しない。OAuth/PAT/DCR/PKCEのcontractは変更しない。
- project作成者はowner、ownerだけがmember管理を行う。`__shared__`はread-onlyのままとする。
- メンバー追加のUIは登録済み`@okakam.net`アカウントのemailを使い、UIDを入力させない。
- token、OAuth code、cookie、callback query、Firebase SDKエラー本文をUI・console・ログ・test fixtureへ出さない。
- 新規dependency、外部font、外部image、外部UI libraryは追加しない。pearl系の明るい背景、charcoalの文字色、indigo accentを使い、キャッチフレーズ・歓迎文・架空機能を追加しない。既存のCSP/security headerを弱めない。
- UIの表示ブランドは`Long term memory`に統一する。MCP server name、Codex設定名、project slugの`long-term-memory`は変更しない。
- `MCP_OAUTH_ENABLED=1`では`AUTH_REQUIRED=1`とHTTPSの`MCP_PUBLIC_URL`を必須とする既存検証を維持する。
- 実装ドキュメントは日本語で記述し、`AGENTS.md`、`docs/reproduction-spec.md`を仕様変更に合わせて更新する。

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/auth/firebase.ts` | Firebase Adminの安全なemail directory lookupを提供する。 |
| `src/app/api/projects/[id]/members/route.ts` | owner-only membership mutation、email input、last-owner保護。 |
| `src/components/project-management/ProjectManagementPanel.tsx` | project作成、選択、member管理をまとめるclient shell。 |
| `src/components/project-management/MemberList.tsx` | member role変更・削除とpending/error表示。 |
| `src/components/dashboard/DashboardOverview.tsx` | Dashboardのtelemetry card群とproject管理領域をレイアウトする。 |
| `src/app/dashboard/page.tsx` | telemetryとaccessible projectをserverで取得してviewへ渡す。 |
| `src/components/FirebaseAuthForm.tsx` | login/signupのpresentational auth shell。 |
| `src/components/OAuthAuthorizationPage.tsx` | raw OAuth consent HTMLとReact表示の安全なauth shell。 |
| `src/app/globals.css` | design token、layout、responsive/a11y style。 |
| `tests/lib/auth/firebase.test.ts` | directory lookup adapter。 |
| `tests/app/project-membership.test.ts` | membership routeのauthorizationとlast-owner制約。 |
| `tests/components/project-management.test.tsx` | project management UIの表示とrequest contract。 |
| `tests/app/dashboard.test.ts` | dashboard data/layout rendering。 |
| `tests/components/firebase-auth-form.test.ts` | auth shellとcontinuation回帰。 |
| `tests/components/oauth-authorization-page.test.ts` | consent form markup/escape回帰。 |

### Task 1: Firebase directory lookupとmember APIの認可契約

**Files:**
- Modify: `src/lib/auth/firebase.ts`
- Modify: `src/app/api/projects/[id]/members/route.ts`
- Modify: `tests/lib/auth/firebase.test.ts`
- Modify: `tests/app/project-membership.test.ts`

**Interfaces:**
- Consumes: `FirebasePrincipal`, `isAllowedEmailDomain(email)`, `AuthStoreLike`, `assertProjectAccess`。
- Produces: `findFirebaseUserIdByEmail(email: string): Promise<string>`、`MemberInput = { email?: string; user_id?: string; role?: 'owner' | 'member' }`、`MemberView = { user_id: string; email: string | null; role: 'owner' | 'member' }`。

- [ ] **Step 1: directory lookupの失敗testを書く**

`tests/lib/auth/firebase.test.ts`へFirebase Admin fakeを追加し、許可emailだけがUIDへ変換され、許可外又は未登録emailが安全な400になることを固定する。

```ts
test('登録済みの許可emailだけをmember UIDへ解決する', async () => {
  setFirebaseAuthForTests({ ...auth, getUserByEmail: vi.fn(async () => ({ uid: 'member-1', email: 'member@okakam.net' })) });
  await expect(findFirebaseUserIdByEmail('member@okakam.net')).resolves.toBe('member-1');
  await expect(findFirebaseUserIdByEmail('member@example.com')).rejects.toMatchObject({ status: 400 });
});
```

- [ ] **Step 2: testが未実装で失敗することを確認する**

Run: `pnpm exec vitest run tests/lib/auth/firebase.test.ts`

Expected: `findFirebaseUserIdByEmail is not a function` または同等の失敗。

- [ ] **Step 3: Firebase Admin adapterを最小実装する**

`FirebaseAdminAuth`に`getUserByEmail(email): Promise<{ uid: string; email?: string }>`を追加する。`findFirebaseUserIdByEmail`はtrim/lowercase後に`isAllowedEmailDomain`を検証し、未登録時はSDKエラーを外へ出さず`MemberLookupError`（`status = 400`）に正規化する。既存test fakeすべてにmethodを追加する。

```ts
export async function findFirebaseUserIdByEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (!isAllowedEmailDomain(normalized)) throw new MemberLookupError();
  try { return (await adminAuth().getUserByEmail(normalized)).uid; }
  catch { throw new MemberLookupError(); }
}
```

- [ ] **Step 4: member routeの失敗testを書く**

ownerがemailでmemberを追加できること、memberが変更不能なこと、ownerを最後の一人にしたままrole変更・削除できないことを追加する。

```ts
test('最後のownerをmemberへ変更又は削除できない', async () => {
  await setup();
  const context = { params: Promise.resolve({ id: 'project' }) };
  const changed = await membersRoute.PATCH(request({ user_id: 'owner', role: 'member' }), context);
  expect(changed.status).toBe(409);
  const deleted = await membersRoute.DELETE(sameOriginRequest('https://example.test/api/projects/project/members?user_id=owner', { method: 'DELETE' }), context);
  expect(deleted.status).toBe(409);
});
```

- [ ] **Step 5: member routeを実装する**

Zod inputを`email`又は`user_id`の一方だけ必須に拡張する。emailがある場合はTask 1 adapterでUIDを解決する。`GET`は各recordを`MemberView`へ変換し、lookup不能時は`email: null`にする。`PATCH`/`DELETE`は操作後にownerが1人以上残るかを検証して409を返す。追加済みUIDは同一roleなら201で返し、role相違なら409を返す。`__shared__`、non-owner、same-origin、session検証は既存contractを維持する。

- [ ] **Step 6: focused testを通す**

Run: `pnpm exec vitest run tests/lib/auth/firebase.test.ts tests/app/project-membership.test.ts tests/app/auth.routes.test.ts`

Expected: PASS。email lookup、role mutation、既存project作成が全て通る。

- [ ] **Step 7: commitする**

```bash
git add src/lib/auth/firebase.ts src/app/api/projects/[id]/members/route.ts tests/lib/auth/firebase.test.ts tests/app/project-membership.test.ts
git commit -m "feat: add owner-safe project membership management"
```

### Task 2: Project管理client componentを追加する

**Files:**
- Create: `src/components/project-management/ProjectManagementPanel.tsx`
- Create: `src/components/project-management/MemberList.tsx`
- Create: `tests/components/project-management.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/projects`、Task 1の`MemberView`とmember endpoints。
- Produces: `ProjectManagementPanel({ initialProjects, currentUserId, selectedProjectId })`。`MemberList({ projectId, members, currentUserId })`。

- [ ] **Step 1: UI renderingとfetch contractの失敗testを書く**

```tsx
test('ownerにはproject作成とemailによるmember追加を表示する', () => {
  const html = renderToStaticMarkup(<ProjectManagementPanel initialProjects={[{ project_id: 'alpha', role: 'owner' }]} currentUserId="owner" selectedProjectId="alpha" />);
  expect(html).toContain('新しいプロジェクト');
  expect(html).toContain('メールアドレスで追加');
  expect(html).toContain('alpha');
});
```

- [ ] **Step 2: testがcomponent不在で失敗することを確認する**

Run: `pnpm exec vitest run tests/components/project-management.test.tsx`

Expected: module not found。

- [ ] **Step 3: project作成formを実装する**

`ProjectManagementPanel`を`'use client'`にする。slug inputをtrimして`POST /api/projects`へJSON送信し、201後はcreated projectを`role: 'owner'`としてlocal stateへ追加し、`router.push('/dashboard?project=' + encodeURIComponent(project_id))`と`router.refresh()`を行う。400/409のresponse本文はform alertへ表示する。送信中はbuttonをdisabledにする。

- [ ] **Step 4: member一覧・追加・role変更・削除を実装する**

project選択時に`GET /api/projects/:id/members`を読み、ownerであればemail＋role formを表示する。`POST`は`{ email, role }`、`PATCH`は`{ user_id, role }`、`DELETE`はqueryの`user_id`を使う。last ownerとcurrent ownerには無効化理由を表示し、confirm dialogを使わず削除button直後にundoを設けない（API成功時だけ一覧から外す）。memberには閲覧用一覧だけを表示する。

- [ ] **Step 5: UI testを通す**

Run: `pnpm exec vitest run tests/components/project-management.test.tsx`

Expected: PASS。owner/memberの表示差、project slug form、email member form、pending/alert状態を確認する。

- [ ] **Step 6: commitする**

```bash
git add src/components/project-management tests/components/project-management.test.tsx
git commit -m "feat: add dashboard project management panel"
```

### Task 3: Dashboardをproject管理対応のcontrol-room UIへ組み替える

**Files:**
- Create: `src/components/dashboard/DashboardOverview.tsx`
- Modify: `src/app/dashboard/page.tsx`
- Modify: `tests/app/dashboard.test.ts`

**Interfaces:**
- Consumes: 既存`TelemetrySummary`相当の集計値、Task 2の`ProjectManagementPanel`、`listAccessibleProjects(userId)`。
- Produces: telemetry計算を変えず、`dashboard-shell`内にKPI、period filters、data tables、project管理panelを描画する。

- [ ] **Step 1: Dashboardの失敗testを書く**

```ts
expect(html).toContain('プロジェクト管理');
expect(html).toContain('利用状況');
expect(html).toContain('7日');
expect(html).toContain('get_memory');
```

- [ ] **Step 2: testが新しい領域不在で失敗することを確認する**

Run: `pnpm exec vitest run tests/app/dashboard.test.ts`

Expected: `プロジェクト管理`を含まないためFAIL。

- [ ] **Step 3: server dataと表示componentを分離する**

`DashboardPage`は既存のrequest project authorizationとtelemetry queryを保つ。`AUTH_REQUIRED=1`時にはprincipalと`listAccessibleProjects`を一度取得し、`currentUserId`とaccessible project summaryを`DashboardOverview`へ渡す。`AUTH_REQUIRED=0`時はlocal userとmemory serviceのproject summaryを表示し、管理操作も既存local APIとして許可する。inline styleを排除し、semantic section/table/headerを維持する。

- [ ] **Step 4: Dashboard UIを実装する**

KPIを`metric-card`、日次推移を`analytics-panel`、tableを横scroll可能な`data-panel`にし、project filterと期間filterをbutton/link groupに置く。計算関数、JST表示、7/30/90日URL、全tool table、error breakdownを削らない。Task 2 panelをtelemetryの前に表示する。

- [ ] **Step 5: Dashboard testを通す**

Run: `pnpm exec vitest run tests/app/dashboard.test.ts tests/app/project-membership.test.ts`

Expected: PASS。既存の365日clampとJST/time要素数を維持し、新しいproject管理領域を確認する。

- [ ] **Step 6: commitする**

```bash
git add src/app/dashboard/page.tsx src/components/dashboard/DashboardOverview.tsx tests/app/dashboard.test.ts
git commit -m "feat: refresh dashboard and surface project management"
```

### Task 4: 共通design systemとheaderを刷新する

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/components/Header.tsx`
- Modify: `src/components/AuthControls.tsx`
- Test: `tests/app/pages.test.ts`

**Interfaces:**
- Consumes: 既存の`card`、`primary`、`danger`、form/table classとHeader link。
- Produces: CSS custom properties、`app-shell`、`surface-card`、`button-primary`、`button-secondary`、`button-danger`、`focus-visible`、reduced-motion rule。

- [ ] **Step 1: header markupの失敗testを書く**

`tests/app/pages.test.ts`又は新規component testに、main navigationがDashboard、project、settingsを含み、brandに`Long term memory`が表示されることを追加する。

```ts
expect(renderToStaticMarkup(<Header />)).toContain('設定');
```

- [ ] **Step 2: testがsettings link不在で失敗することを確認する**

Run: `pnpm exec vitest run tests/app/pages.test.ts`

Expected: `設定`を含まないためFAIL。

- [ ] **Step 3: global CSS tokenを実装する**

`:root`へpearl/slate/charcoal/indigo/criticalの色、spacing、radius、shadow tokenを追加する。bodyは淡いgradient背景、headerは半透明blurのsticky bar、mainはresponsive max-widthにする。button/input/table/cardをtokenへ移し、`*:focus-visible`、`@media (prefers-reduced-motion: reduce)`、720px以下のnavigation/form/table表示を追加する。既存editor、graph、token settings classを壊さない。

- [ ] **Step 4: Header/AuthControlsを実装する**

HeaderにDashboard、プロジェクト、検索、設定を置き、モバイルでwrapする。AuthControlsのログアウトをsecondary button classとし、ログイン／登録linkをheader actionとして揃える。link先とFirebase sign-outの振る舞いは変更しない。

- [ ] **Step 5: focused testを通す**

Run: `pnpm exec vitest run tests/app/pages.test.ts tests/components/firebase-auth-form.test.ts`

Expected: PASS。既存pageの本文、auth continuation、new header navigationが全て維持される。

- [ ] **Step 6: commitする**

```bash
git add src/app/globals.css src/components/Header.tsx src/components/AuthControls.tsx tests/app/pages.test.ts
git commit -m "feat: establish modern shared application styling"
```

### Task 5: Login/signup UIを認証shellへ刷新する

**Files:**
- Modify: `src/components/FirebaseAuthForm.tsx`
- Modify: `src/app/sign-in/[[...sign-in]]/page.tsx`
- Modify: `src/app/sign-up/[[...sign-up]]/page.tsx`
- Modify: `tests/components/firebase-auth-form.test.ts`
- Modify: `tests/app/oauth-login-continuation.test.ts`

**Interfaces:**
- Consumes: `completeFirebaseAuth(credential, continuation, router)`、`authSwitchHref`。
- Produces: `auth-shell`、`auth-card`、OAuth continuation有無に応じた安全な補助copy。

- [ ] **Step 1: auth shellの失敗testを書く**

```tsx
const markup = renderToStaticMarkup(<FirebaseAuthForm mode="sign-in" continuation={null} />);
expect(markup).toContain('long-term-memory');
expect(markup).toContain('Googleで続行');
expect(markup).toContain('メールアドレス');
```

- [ ] **Step 2: testが新しいbrand copy不在で失敗することを確認する**

Run: `pnpm exec vitest run tests/components/firebase-auth-form.test.ts tests/app/oauth-login-continuation.test.ts`

Expected: brand copy assertionがFAIL。

- [ ] **Step 3: form markupを実装する**

認証shellにはbrand、短い価値説明、email/password labels、Google button、mode switch、alertを置く。`continuation`がある場合だけ「ログイン後、MCP接続の確認画面へ戻ります」を表示する。form action、state、Firebase関数呼び出し、button disabled、error handling、safe relative continuationを変更しない。

- [ ] **Step 4: sign-in/sign-up pageにlayout classを追加する**

両pageは`<main className="auth-page">`でformを包む。search parameterの許可・破棄規則を変えない。

- [ ] **Step 5: auth testを通す**

Run: `pnpm exec vitest run tests/components/firebase-auth-form.test.ts tests/app/oauth-login-continuation.test.ts tests/app/auth.firebase-routes.test.ts`

Expected: PASS。OAuth transactionだけを保持し、外部URLとtoken関連文字列をmarkupへ出さない。

- [ ] **Step 6: commitする**

```bash
git add src/components/FirebaseAuthForm.tsx src/app/sign-in src/app/sign-up tests/components/firebase-auth-form.test.ts tests/app/oauth-login-continuation.test.ts
git commit -m "feat: refresh Firebase authentication screens"
```

### Task 6: OAuth同意画面を安全なraw auth shellへ刷新する

**Files:**
- Modify: `src/components/OAuthAuthorizationPage.tsx`
- Modify: `tests/components/oauth-authorization-page.test.ts`
- Modify: `tests/lib/oauth/authorization-csp.test.ts`
- Test: `tests/app/oauth-protocol-routes.test.ts`

**Interfaces:**
- Consumes: `renderOAuthAuthorizationPage({ transactionId, csrfToken, clientName, scope })`、`getOAuthAuthorizationPageCsp(redirectUri)`。
- Produces: raw HTMLとReact JSXで同一のclient/scope/consent content。POST field namesとCSP behaviorは不変。

- [ ] **Step 1: raw markup security regression testを書く**

```ts
test('OAuth consentは安全なform contractと新しいauth shellを返す', () => {
  const html = renderOAuthAuthorizationPage({ transactionId: 'ltm_oatx_x', csrfToken: 'csrf', clientName: '<Codex>', scope: 'mcp:access' });
  expect(html).toContain('oauth-consent-card');
  expect(html).toContain('action="/oauth/authorize"');
  expect(html).toContain('name="transaction_id"');
  expect(html).toContain('&lt;Codex&gt;');
});
```

- [ ] **Step 2: testが新class不在で失敗することを確認する**

Run: `pnpm exec vitest run tests/components/oauth-authorization-page.test.ts`

Expected: module/class assertion FAIL。

- [ ] **Step 3: raw HTMLとReact版を実装する**

inline `<style>`にOAuth専用のpearl/charcoal/indigo color、responsive card、button focus/hover、`prefers-reduced-motion`を定義する。`escapeHtml`はそのまま使い、client name/scopeをtextとして埋める。scope/再評価の説明、許可と拒否を視覚的に区別する。キャッチフレーズや歓迎文は入れない。hidden input、`method="post"`、action、button name/valueは一字も変えない。React版には対応classを付けるが、routeはraw rendererを継続する。

- [ ] **Step 4: OAuth security regressionを通す**

Run: `pnpm exec vitest run tests/components/oauth-authorization-page.test.ts tests/lib/oauth/authorization-csp.test.ts tests/app/oauth-protocol-routes.test.ts`

Expected: PASS。loopback originだけが`form-action`へ入り、CSRF/form/redirect flowが維持される。

- [ ] **Step 5: commitする**

```bash
git add src/components/OAuthAuthorizationPage.tsx tests/components/oauth-authorization-page.test.ts tests/lib/oauth/authorization-csp.test.ts
git commit -m "feat: redesign OAuth consent experience"
```

### Task 7: Documentation、quality gate、production acceptanceを更新する

**Files:**
- Modify: `docs/reproduction-spec.md`
- Modify: `AGENTS.md`
- Modify: `docs/post-mcp-setup.md`
- Modify: `docs/superpowers/specs/2026-09-24-project-management-and-ui-design.md`
- Test: `tests/docs/post-mcp-setup.test.ts`

**Interfaces:**
- Consumes: Task 1-6のAPI/UI/security contract。
- Produces: project作成、owner/member管理、Codex OAuth first-useの運用手順と本番acceptance check。

- [ ] **Step 1: documentation regression testを書く**

`tests/docs/post-mcp-setup.test.ts`に、OAuth利用前にDashboardでprojectを作成し、URLの`project_id`とmember/ownerの責務を確認する記述があることを追加する。

```ts
expect(document).toContain('プロジェクトを作成');
expect(document).toContain('owner');
expect(document).toContain('project_id');
```

- [ ] **Step 2: testが新運用記述不在で失敗することを確認する**

Run: `pnpm exec vitest run tests/docs/post-mcp-setup.test.ts`

Expected: required copy assertionがFAIL。

- [ ] **Step 3: 正本ドキュメントを更新する**

`docs/reproduction-spec.md`へDashboardによるproject初期化とFirestore membership再評価を追記する。`docs/post-mcp-setup.md`へ、Dashboardでownerとしてproject作成→member追加→`codex mcp add`→`codex mcp login`→新Codex sessionの`/mcp verbose`で16 tools確認、という順序を追記する。`AGENTS.md`へ、project管理UIのowner制約とOAuth consent CSPを弱めないルールを追記する。secret/token本文は例示しない。

- [ ] **Step 4: full local quality gateを実行する**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit && NODE_ENV=production pnpm build && git diff --check`

Expected: 全てPASS。native module又はsandbox制約で実行不能な場合は、失敗ログを最小限に記録し、同じcheckをDev Containerで再実行する。

- [ ] **Step 5: production acceptance手順を実行する**

mainへのrelease PR mergeとdeploy成功後、`https://ltm.okakam.net`でFirebaseログインし、Dashboardから`long-term-memory`をownerとして作成する。同じアカウントでOAuth loginを行い、`codex mcp add long-term-memory --url 'https://ltm.okakam.net/api/mcp?project_id=long-term-memory'`、`codex mcp login long-term-memory`、新しいCodex sessionの`/mcp verbose`を確認する。token、code、cookie、state、callback queryを記録しない。

Expected: `long-term-memory: connected`、16 toolsが表示される。memberでは通常toolが利用でき、ownerのみ`reindex`が利用できる。未所属accountでは403で拒否される。

- [ ] **Step 6: commitする**

```bash
git add AGENTS.md docs/reproduction-spec.md docs/post-mcp-setup.md docs/superpowers/specs/2026-09-24-project-management-and-ui-design.md tests/docs/post-mcp-setup.test.ts
git commit -m "docs: document project membership and OAuth onboarding"
```

## Plan Self-Review

- Spec coverage: project creation/owner assignmentはTask 1-3、email member管理とlast-owner保護はTask 1-2、Dashboard刷新はTask 3-4、login/signupはTask 5、OAuth同意とCSP回帰はTask 6、運用・本番受入はTask 7で扱う。
- Scope: invitation email、組織、OAuth protocol変更、その他memory画面の個別再設計は非目標として除外した。
- Security: member APIのsame-origin/owner check、Firebase UIDを正本とする認可、token非表示、OAuth form/CSP契約を各taskのtestと実装手順に明記した。
- Consistency: UIはTask 2の`ProjectManagementPanel`をTask 3が利用し、Task 1の`MemberView`をTask 2が利用する。後続taskは未定義のinterfaceを参照しない。
