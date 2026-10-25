# 依存ライブラリ更新計画

**目的:** ルートアプリとFirebase Functionsの依存範囲内の更新に加え、Next.js・Reactと対応パッケージを最新安定版へ更新する。

**仕様:** `docs/reproduction-spec.md`。Cloud Run構成は`2026-09-20-cloud-run-gcs-storage.md`、Functionsの独立パッケージ境界は`2026-09-21-auth-email-domain-restriction.md`を参照する。

## 制約

- ユーザーの追加指定により、Next.js・React・React DOM・eslint-config-nextはnpm registryの最新安定版へ固定指定を更新する。他の依存範囲・固定指定は維持する。
- Node.js 22、pnpm 11.1.3を使用し、ルートとFunctionsの`pnpm-lock.yaml`をそれぞれ更新する。
- アプリケーションの機能・認証契約・デプロイ構成を変更しない。
- 本番へのデプロイはこの作業の対象外とする。

## 作業

- [x] registryから更新候補を確認し、依存範囲内の更新を適用した。`pnpm update`がmanifestの下限も変更したため元の指定へ戻し、`install --lockfile-only --ignore-scripts`で同期した。Functionsのupdateはビルドスクリプト制限で終了コード1となったが、CIと同じ`--ignore-scripts`でのinstallは成功した。自動生成された未設定の`functions/pnpm-workspace.yaml`は除去した。
- [x] 両パッケージのfrozen lockfile installで再現性を確認した。
- [x] ルートの全テスト・lint・型検査・本番ビルド、Functionsのテスト・ビルドを実行した。SQLite native module、MCP、Firebase認証の既存回帰テストを含む。
- [x] `git diff --check`とJSON/YAML構文・Compose設定を検証した。Docker imageのhealth確認はCIの回帰ゲートを維持する。
- [x] 仕様書・AGENTS.mdへ更新手順と検証結果を記録した。

## Next.js・React追加更新

- [x] npm registryの`latest`を確認: Next.js / eslint-config-next 16.4.0、React / React DOM 19.3.0。Node.js 22とpeer dependency条件を満たす。
- [x] 上記4パッケージのmanifestとpnpm lockfileを更新した。
- [x] frozen install、全テスト・lint・型検査・本番ビルドを再実行した。
- [x] 仕様書とAGENTS.mdを最終スコープへ揃え、検証結果を記録した。

公式release notes: [Next.js 16.4](https://nextjs.org/blog/next-16-4)、[React 19.3](https://react.dev/blog/2026/09/09/react-19-3)。Cache Componentsは既存アプリでは設定で有効化する機能のため、今回の依存更新では設定を変更しない。

### 最終バージョンと検証結果

| パッケージ | 更新前 | 更新後 |
|---|---|---|
| `next` | 16.2.6 | 16.4.0 |
| `eslint-config-next` | 16.2.6 | 16.4.0 |
| `react` | 19.2.4 | 19.3.0 |
| `react-dom` | 19.2.4 | 19.3.0 |

- `pnpm install --frozen-lockfile`: 成功。
- `pnpm test`: 96ファイル・305テスト成功。サンドボックス内ではドキュメント同期を行う3テストの子プロセス起動が`EPERM`で拒否されたため、制限外で同じ全テストを再実行して成功を確認した。
- `pnpm lint`、`pnpm exec tsc --noEmit`: 成功。
- `NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 pnpm build`: 成功。サンドボックス内ではTypeScript `--showConfig`の出力解析で停止したが、制限外で同じコマンドは成功した。設定やアプリコードの変更は不要だった。
- Functionsの`test`: 1ファイル・6テスト成功。`build`: 成功。
- 本番モードの`next start`をloopbackへ起動し、`GET /api/health`のHTTP 200とJSON内容、`GET /sign-in`のHTTP 200とHTML応答を確認した。確認後に停止した。
- manifest変更は指定4パッケージのみであること、lockfileの解決済みバージョンと固定指定が一致することを確認した。
- JSON/YAML構文、Compose設定、`git diff --check`: 成功。
- Docker imageと本番Cloud Run/Firebaseの検証は引き続き未実行。既存CIと本番受入ゲートを維持する。

## 初回の依存範囲内更新結果

### 直接依存の変更

| パッケージ | 更新前 | 更新後 |
|---|---|---|
| `@google-cloud/storage` | 8.2.0 | 8.4.0 |
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.32.1 |
| `@xyflow/react` | 12.11.6 | 12.12.0 |
| `firebase-admin` | 14.4.0 | 14.5.0 |
| `zod` | 4.5.4 | 4.6.5 |
| `@types/react` | 19.2.18 | 19.3.0 |
| `@types/react-dom` | 19.2.7 | 19.3.0 |
| `tsx` | 4.23.13 | 4.23.15 |

Functionsの直接依存は既存範囲内の解決済み最新版だったため変化なし。両lockfileの間接依存も更新した。Next.js 16.2.6、React/React DOM 19.2.4、eslint-config-next 16.2.6、firebase-functions 7.4.0の固定指定を維持した。

### 実行結果

- Node.js 22.23.3・pnpm 11.1.3で実行。
- `pnpm install --frozen-lockfile`: 成功。
- `pnpm --dir functions --ignore-workspace install --frozen-lockfile --ignore-scripts`: 成功。
- `pnpm test`: 96ファイル・305テスト成功。
- `pnpm lint`、`pnpm exec tsc --noEmit`: 成功。
- `NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 pnpm build`: 成功。ホスト上の複数lockfileによるworkspace root推定警告が出た。
- Functionsの`test`: 1ファイル・6テスト成功。`build`: 成功。
- 両lockfileのimporter specifierと更新前manifestを比較し、全ての依存範囲・固定指定が同じであることを確認。
- package manifest・Dev Container・Firebase設定のJSON、および両lockfile・pnpm workspace・Compose・Cloud Run workflowのYAML構文: 成功。
- ホストにCompose pluginがなかったため、一時ディレクトリへ公式Compose v5.6.0を導入し、`docker --config /tmp/ltm-docker-cli compose -f .devcontainer/compose.yaml config --quiet`: 成功。
- Docker imageビルド・コンテナhealth確認・本番Cloud Run/Firebase smokeは未実行。前者は既存GitHub Actionsの回帰ゲート、後者は外部資格情報が必要な本番受入ゲートとする。

## 2026-10-25 Next.js 16.4.1 セキュリティ更新

`NODE_ENV=production pnpm build`が既知脆弱性の通知で停止し、`pnpm audit --prod`でNext.js `>=16.0.0 <=16.4.0`のcritical advisory（GHSA-2464-fhr4-w9xw: SVG使用時のImage Optimization API RCE、GHSA-673q-mjm6-r5xr: `use cache`のtyped array RCE）とhigh（Server ActionsのDoS）を確認した。修正版の`next`・`eslint-config-next` 16.4.1へ固定指定を更新した。React/React DOMは19.3.0を維持する。更新後の`pnpm audit --prod`にNext.jsのadvisoryは残っていない（間接依存の別advisoryは別途扱う）。

## 2026-10-25 Node.js 24 LTS への更新

ユーザー指定により、Node.jsを22から当時のActive LTSである24（v24.22.1 Krypton）へ全体で上げた。Node.js 26はCurrentでLTS昇格前のため対象外とした。

- 対象: `.nvmrc`、`package.json`の`engines`（`>=24.11.0 <25`）と`@types/node ^24`、`functions/package.json`の`engines.node`（Cloud Functions runtime 24）と`@types/node ^24`、Cloud Run `Dockerfile`・Dev Containerの`node:24-bookworm-slim`、GitHub Actionsの`node-version-file: .nvmrc`、関連ドキュメントとテスト。`.nvmrc`を`24.22.1`に固定して正本とし、Dockerfile・Dev Containerの`node:24.22.1-bookworm-slim`と`engines`の一致をテストで検証する。
- Node.js 24でルート・Functionsのfrozen install、全テスト（116ファイル・403テスト）、lint、型検査、`NODE_ENV=production pnpm build`、Functionsのtest/build: 成功。
- 既存の`node_modules`はNode.js 22向けにbuildされた`better-sqlite3`のnative binary（`NODE_MODULE_VERSION 127`）を含むため、Node.js 24では`pnpm rebuild better-sqlite3`（又は再install）が必要。
- Docker imageとCloud Run/Functionsの本番受入は既存CI・deploy smokeで確認する。
