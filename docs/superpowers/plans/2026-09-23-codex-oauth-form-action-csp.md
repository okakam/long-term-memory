# Codex OAuth同意後のCSP callback遮断 修正計画

> **実行手順:** `superpowers:executing-plans`に従い、各タスクをテスト先行で実施する。

**目標:** ChromiumがOAuth同意フォームの302 callback redirectを`form-action 'self'`で遮断せず、検証済みCodex loopback listenerへ到達できるようにする。

**構成:** 全体のCSPは厳格な`form-action 'self'`を維持する。`/oauth/authorize`の同意画面だけ、保存済みtransactionから復元した検証済み`http://127.0.0.1[:port]` callbackのoriginを追加した同等のCSPを返す。静的な全体CSPはこのrouteだけ除外し、同意画面のCSPが複数ポリシーの積で再び遮断されないようにする。

**技術:** Node.js 22、TypeScript、Next.js、Vitest、Content Security Policy。

**仕様:** `docs/superpowers/specs/2026-09-21-mcp-oauth-codex-login-design.md`、`docs/reproduction-spec.md`。

## 全体制約

- Native App callbackは`http://127.0.0.1[:port]/<path>`形式とし、authorize時は登録済みredirect URIとscheme・host・pathを一致させ、port差だけを許可する。
- `localhost`、`[::1]`、HTTPS、custom scheme、wildcard、port 0をcallbackとして受け付けない。
- CSPへ追加するsourceはauthorize transactionで検証済みのcallback URIから得たoriginだけとし、path、query、code、stateを含めない。
- `/oauth/authorize`以外のページに適用するCSP、Firebase/Firestore認証、OAuth protocol、PAT経路は変更しない。
- `MCP_PUBLIC_URL`を基準にする既存の公開redirect設計を維持し、内部Hostや`Request.url`から公開redirectを作らない。
- callback port、OAuth transaction、state、authorization code、cookie、tokenをログやテスト出力へ記録しない。

## レビューフォーカス

1. Codexが実行ごとに選ぶloopback portだけが同意画面CSPに許可されること。route testで動的port付きcallbackを検証する。
2. Firebaseログイン後のtransaction再開でも同じcallback originが復元されること。authorize route testで未ログインredirectから再開までを検証する。
3. CSP sourceにcallback pathやqueryが含まれないこと。route testでoriginのみを確認する。
4. callback URIの不正なhost/scheme/portを許可しないこと。既存redirect validation testに加えてCSP builderの拒否を検証する。
5. 他のrouteは従来の`form-action 'self'`を保ち、OAuth routeでも他のsecurity headerが維持されること。Next config testとproduction buildで検証する。

---

### Task 1: 検証済みcallback originをOAuth同意画面CSPへ適用する

**Files:**

- Create: `src/lib/security/content-security-policy.ts` — 共通CSP directiveを一元構築する。
- Create: `src/lib/oauth/authorization-csp.ts` — 既存`validateDcrRedirectUri`を使い、同意画面用CSPを作る。
- Modify: `src/lib/oauth/service.ts` — `OAuthAuthorizationStart`に検証済み`redirectUri`を内部値として含め、begin/resume双方で返す。
- Modify: `src/app/oauth/authorize/route.ts` — 同意HTML responseにtransaction由来のCSPを設定する。
- Modify: `tests/app/oauth-protocol-routes.test.ts` — 動的portおよびFirebase sign-in後のresume flowを検証する。
- Create: `tests/lib/oauth/authorization-csp.test.ts` — loopback originのallowと不正redirect URIの拒否を検証する。

**Interfaces:**

- Consumes: `validateDcrRedirectUri(value: string): URL`。
- Produces: `buildContentSecurityPolicy(additionalFormActionOrigins?: readonly URL[]): string`と`getOAuthAuthorizationPageCsp(redirectUri: string): string`。
- `OAuthAuthorizationStart`に`redirectUri: string`を追加する。この値はserver-side routeからCSPを生成するだけに使い、同意HTMLやclient response bodyには出さない。

- [x] **Step 1: 失敗するテストを追加する**

同意画面route testで、authorize requestのcallbackを`http://127.0.0.1:53124/callback/codex`にし、response CSPに`form-action 'self' http://127.0.0.1:53124`が含まれ、`/callback/codex`やqueryが含まれないことをassertする。別testではtransactionを作ってsign-inへredirectした後、transaction cookieとsession cookieを使って再開し、同じportだけが許可されることをassertする。CSP helper testでは`localhost`、`[::1]`、HTTPS、port 0、非loopback hostを拒否する。

```ts
expect(authorization.headers.get('Content-Security-Policy'))
  .toContain("form-action 'self' http://127.0.0.1:53124");
expect(authorization.headers.get('Content-Security-Policy'))
  .not.toContain('/callback/codex');
expect(getOAuthAuthorizationPageCsp('http://127.0.0.1:53124/callback/codex'))
  .toContain("form-action 'self' http://127.0.0.1:53124");
expect(() => getOAuthAuthorizationPageCsp('http://localhost/callback/codex')).toThrow();
```

- [x] **Step 2: focused testが期待理由で失敗することを確認する**

Run: `pnpm exec vitest run tests/app/oauth-protocol-routes.test.ts tests/lib/oauth/authorization-csp.test.ts`

Expected: responseにroute-scoped CSPがなく、helper moduleがないためFAILする。

- [x] **Step 3: CSP builderとauthorization transaction値を実装する**

共通builderは現在の`default-src`、Firebase用`script-src`/`connect-src`、画像・style・font・frame・base-uri・frame-ancestors directiveを維持し、`form-action`だけ`'self'`と追加URLの`.origin`から作る。OAuth専用helperは`validateDcrRedirectUri`を呼び、そのURLだけをbuilderへ渡す。`beginAuthorization`は入力を既存validationに通した後にredirect URIを返し、`resumeAuthorization`はFirestore/SQLite transactionの保存値から同じ値を返す。routeは同意HTML responseにのみ専用CSPを設定する。

```ts
export function buildContentSecurityPolicy(additionalFormActionOrigins: readonly URL[] = []): string {
  const formAction = ["'self'", ...additionalFormActionOrigins.map(({ origin }) => origin)].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://*.firebaseapp.com https://apis.google.com",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "frame-src 'self' https://*.firebaseapp.com https://*.web.app https://accounts.google.com",
    "base-uri 'self'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

export function getOAuthAuthorizationPageCsp(redirectUri: string): string {
  return buildContentSecurityPolicy([validateDcrRedirectUri(redirectUri)]);
}
```

`OAuthAuthorizationStart`のserver-side値は次の形にする。

```ts
export type OAuthAuthorizationStart = {
  transactionId: string;
  csrfToken: string;
  clientName: string;
  scope: typeof MCP_OAUTH_SCOPE;
  redirectUri: string;
};
```

- [x] **Step 4: focused testを通す**

Run: `pnpm exec vitest run tests/app/oauth-protocol-routes.test.ts tests/lib/oauth/authorization-csp.test.ts`

Expected: callback hostとportだけを許可し、非loopback URIを許可しない。OAuth成功時の302、code/state、cookie clear動作は維持される。

### Task 2: 静的CSPの適用範囲を分離し仕様を同期する

**Files:**

- Modify: `next.config.ts` —共通security headersを全routeに適用し、静的CSPだけ`/oauth/authorize`以外に適用する。
- Modify: `tests/deploy/task8.test.ts` —全体CSP directive維持とOAuth authorize除外を検証する。
- Modify: `docs/superpowers/specs/2026-09-21-mcp-oauth-codex-login-design.md` —browser consent CSP境界を記録する。
- Modify: `docs/reproduction-spec.md` —Codex OAuth運用のCSP挙動を記録する。
- Modify: `AGENTS.md` —同意routeだけへ検証済みloopback originを許可し、global CSPを緩めない保守ルールを加える。

**Interfaces:**

- Consumes: Task 1の共通CSP builder。
- Produces: `X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、production HSTSを全routeで維持し、静的CSPがOAuth authorization routeを除外するNext config。

- [x] **Step 1: 失敗するheader config testを追加する**

`tests/deploy/task8.test.ts`で`nextConfig.headers()`が全routeに共通security headersを返し、静的Content-Security-Policyのmatcherが`/oauth/authorize`を除外することをassertする。CSP本文は従来のFirebase hostと`form-action 'self'`を含むことをassertする。

```ts
const cspGroups = headerGroups.filter(group =>
  group.headers.some(header => header.key === 'Content-Security-Policy'));
expect(cspGroups).toHaveLength(1);
expect(cspGroups[0].source).toBe('/((?!oauth/authorize$).*)');
expect(cspGroups[0].headers.find(header => header.key === 'Content-Security-Policy')?.value)
  .toContain("form-action 'self'");
```

- [x] **Step 2: config testが期待理由で失敗することを確認する**

Run: `pnpm exec vitest run tests/deploy/task8.test.ts`

Expected: 現在の静的CSP matcherが全routeを対象にするためFAILする。

- [x] **Step 3: Next headersを分離し、仕様を同期する**

共通security headersは`/(.*)`で継続して適用する。静的CSPはNext.jsのregex route pattern `'/((?!oauth/authorize$).*)'`で適用し、`/oauth/authorize` consent responseだけはTask 1のroute response CSPを使う。Next.jsのcustom header matcher仕様とproduction buildでmatcher構文を確認する。OAuth設計書、再現仕様書、AGENTS.mdには静的global CSPを緩めず、transactionから検証済みcallback originだけを許可することを記載する。

```ts
return [
  { source: '/(.*)', headers: commonSecurityHeaders },
  { source: '/((?!oauth/authorize$).*)', headers: [contentSecurityPolicyHeader] },
];
```

- [x] **Step 4: focused testとproduction buildを確認する**

Run: `pnpm exec vitest run tests/deploy/task8.test.ts tests/app/oauth-protocol-routes.test.ts tests/lib/oauth/authorization-csp.test.ts`

Run: `NODE_ENV=production pnpm build`

Expected: testsがPASSし、Next.jsがcustom header route matcherを受理してproduction buildが完了する。

### Task 3: 回帰ゲートを実行する

- [x] Run: `pnpm test`
- [x] Run: `pnpm lint`
- [x] Run: `pnpm exec tsc --noEmit`
- [x] Run: `NODE_ENV=production pnpm build`
- [x] Run: `git diff --check`
- [x] Confirm `git status --short`にHAR、token、その他未依頼のローカルファイルが含まれない。
- [x] 本番のChromium consent/callback受け入れはデプロイ後の別ゲートとして残し、local test成功と混同しない。

補足: `docker compose -f .devcontainer/compose.yaml config --quiet`は実行を試みたが、この環境に`docker`コマンドがなく確認できなかった。

## 自己レビュー

- 既存OAuth specのloopback validation、Firebase transaction resume、同意POST、302 callbackを維持し、追加要件はroute-scoped CSPに限定した。
- authorization code/state/tokenはCSP値にもログにも含めず、sourceはURL originだけに絞った。
- global CSPのFirebase連携source、各routeのsecurity header、OAuth/PATの処理契約を維持する検証をタスクへ割り当てた。
- 本番でのブラウザー受入はローカルbuild/testで代替できない外部ゲートとして明示した。
