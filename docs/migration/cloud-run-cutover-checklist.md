# Cloud Run切り替え・Vercel削除チェックリスト

このチェックリストは、VercelからCloud Runへ切り替える最終受け入れ記録である。認証情報、Firebase Admin credential JSON、PAT本文、migration manifestはrepositoryへ保存しない。

## 1. コードとローカル検証

- [x] Cloud Run/Firebase Authentication/GCS/Firestoreの実装をfeature branchへ反映した。
- [x] Cloud SQL、Redis、Upstash、Firebase StorageクライアントSDK、Cloud Scheduler、常駐workerを採用していない。
- [x] `pnpm install --frozen-lockfile` が成功した。
- [x] `pnpm test` が成功した。
- [x] `pnpm lint` が成功した。
- [x] `pnpm exec tsc --noEmit` が成功した。
- [x] `NODE_ENV=production pnpm build` が成功した。
- [x] ローカルDocker検証はdevcontainer内では実施しない方針とし、GitHub Actionsの`cloud-run` verifyで`docker build`とコンテナhealth checkを代替検証した。
- [x] GitHub Actionsの`cloud-run` verifyで`docker build`とコンテナhealth checkが成功した。

補足（2026-09-20）: devcontainer内のローカルDocker build/health checkは実施しない。GitHub ActionsのPR verify（run `35485079541`）ではDocker buildと`GET /api/health`が成功した。`pnpm test`（67 files・193 tests）、lint、型検査、本番build、`git diff --check`は成功。

## 2. GCP、Firebase、GCSの準備

- [ ] GCPプロジェクト、Cloud Run API、Artifact Registry API、Firestore APIを有効化した。
- [ ] Cloud Run用サービスアカウントを作成し、GCSアクセスとFirestoreアクセスを最小権限で付与した。
- [ ] GitHub ActionsはWorkload Identity Federationを使い、長期秘密鍵を登録していない。
- [ ] Cloud Runは `min=0`、`max=1`、`concurrency=1`、1 vCPU、512 MiBで設定した。
- [ ] Cloud Run Invokerは公開にし、`AUTH_REQUIRED=1`とFirebase/MCPのアプリ層認証を有効にした。
- [ ] Firebase AuthenticationでEmail/Passwordと必要なGoogle providerだけを有効化した。
- [ ] Firebaseのauthorized domainsへ本番ドメインを追加した。
- [ ] FirestoreをNative modeで作成し、`firestore.rules`をdeployした。
- [ ] GCS bucketを非公開、Block Public Access有効、暗号化有効で作成した。
- [ ] GCSのIAM policyは対象bucketとprefixだけを許可している。
- [ ] 本番secretはCloud Run secret環境変数またはCI secretへ登録し、repositoryへ保存していない。

## 3. 旧環境の破棄（移行なし）

- [x] 旧データは移行せず破棄し、空のCloud Run/Firebase/GCS/Firestore環境から開始する方針を決定した。
- [x] 旧Vercel Projectはユーザー操作で削除した（2026-09-20、対象Project名は未記録）。
- [ ] 旧Turso、旧Blob、旧Clerk、旧Redisの独立リソースとcredentialを削除したことを確認する。
- [x] 旧データのexport、UID map作成、GCS/Firestore import、migration verifyは空スタート方針のため実施しない。

## 4. importと整合性検証

- [x] 旧データを移行しないため、UID map、import、migration verify、source/target照合は対象外とした。
- [x] 新規環境の初期状態は空であり、最初のmemoryはCloud Run smokeまたは運用開始後に作成する。

## 5. Cloud Run受け入れ

- [ ] `GET /api/health` が200を返す。
- [ ] `scripts/cloud-run-smoke.ts`でMCP initialize、16 tools/list、save、search、get、update、link、reindex、deleteを確認した。
- [x] renameはMCP公開toolに含まれないため、`CloudMemoryService`の回帰テストで検証済み。実環境smokeの対象外とする。
- [ ] Firebaseログイン、session cookie交換、ログアウトをブラウザで確認した。
- [ ] 未認証Web APIが401、別projectアクセスが403、MCP PATが対象projectだけへ到達することを確認した。
- [ ] `__shared__`のwriteがFirebase UIDとmaintenance tokenの二重条件を満たさない限り拒否される。
- [ ] Cloud Run cold start後もFirestore metadataからSQLite cacheをreindexできる。
- [ ] Cloud Run logへPAT本文、Firebase credential、GCS credential keyが出力されない。
- [ ] 無料枠を超える可能性のあるGCS、Firestore、Artifact Registry、Cloud Runの使用量監視を設定した。

## 6. 切り替えとrollback

- [ ] Cloud Run revision URL、smoke実行日時、commit SHA、import reportを運用記録へ保存した。
- [ ] DNS、カスタムドメイン、MCP client、Claude Code設定、curator設定をCloud Runへ切り替えた。
- [ ] 切り替え後に新環境でmemory writeを1件実行し、GCSとFirestoreの両方を確認した。
- [ ] rollback期間と判断責任者を決めた。
- [ ] 最終GCS snapshotとFirestore exportまたは復旧手順をrepository外へ保存した。
- [ ] 旧Vercel環境へのwriteが拒否されることを確認した。

## 7. Vercel削除（最後の不可逆操作）

- [ ] rollback期間を設けないfresh start方針を確認し、Cloud Run smoke成功後に運用開始する。
- [ ] Vercel domain mapping、integration、environment variable、GitHub Vercel secretを削除した。
- [ ] 旧Turso、旧Blob、旧Clerk、旧Redis credentialを失効させた。
- [x] 認証済みVercel Consoleで旧Projectを削除した（ユーザー報告、2026-09-20）。
- [x] Vercel Project削除日時を記録した。対象Project名と実行者の詳細はrepository外の管理記録に残す。

## 記録

- commit SHA: 未記録
- Cloud Run revision URL: 未実行
- export日時: 対象外（fresh start）
- import日時: 対象外（fresh start）
- verify日時: 対象外（fresh start）
- smoke日時: 未実行
- rollback終了日時: 未設定
- Vercel Project削除日時: 2026-09-20（ユーザー報告）
