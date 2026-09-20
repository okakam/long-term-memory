# Cloud Run切り替え・Vercel削除チェックリスト

このチェックリストは、VercelからCloud Runへ切り替える最終受け入れ記録である。認証情報、Firebase Admin credential JSON、PAT本文、migration manifestはrepositoryへ保存しない。

## 1. コードとローカル検証

- [x] Cloud Run/Firebase Authentication/S3/Firestoreの実装をfeature branchへ反映した。
- [x] Cloud SQL、Redis、Upstash、Firebase Cloud Storage、Cloud Scheduler、常駐workerを採用していない。
- [x] `pnpm install --frozen-lockfile` が成功した。
- [x] `pnpm test` が成功した。
- [x] `pnpm lint` が成功した。
- [x] `pnpm exec tsc --noEmit` が成功した。
- [x] `NODE_ENV=production pnpm build` が成功した。
- [x] ローカルDocker検証はdevcontainer内では実施しない方針とし、GitHub Actionsの`cloud-run` verifyで`docker build`とコンテナhealth checkを代替検証した。
- [x] GitHub Actionsの`cloud-run` verifyで`docker build`とコンテナhealth checkが成功した。

補足（2026-09-20）: devcontainer内のローカルDocker build/health checkは実施しない。GitHub ActionsのPR verify（run `35485079541`）ではDocker buildと`GET /api/health`が成功した。`pnpm test`（69 files・200 tests）、lint、型検査、本番build、`git diff --check`は成功。

## 2. GCP、Firebase、S3の準備

- [ ] GCPプロジェクト、Cloud Run API、Artifact Registry API、Firestore APIを有効化した。
- [ ] Cloud Run用サービスアカウントを作成し、S3アクセスとFirestoreアクセスを最小権限で付与した。
- [ ] GitHub ActionsはWorkload Identity Federationを使い、長期秘密鍵を登録していない。
- [ ] Cloud Runは `min=0`、`max=1`、`concurrency=1`、1 vCPU、512 MiBで設定した。
- [ ] Cloud Run Invokerは公開にし、`AUTH_REQUIRED=1`とFirebase/MCPのアプリ層認証を有効にした。
- [ ] Firebase AuthenticationでEmail/Passwordと必要なGoogle providerだけを有効化した。
- [ ] Firebaseのauthorized domainsへ本番ドメインを追加した。
- [ ] FirestoreをNative modeで作成し、`firestore.rules`をdeployした。
- [ ] S3 bucketを非公開、Block Public Access有効、暗号化有効で作成した。
- [ ] S3のIAM policyは対象bucketとprefixだけを許可している。
- [ ] 本番secretはCloud Run secret環境変数またはCI secretへ登録し、repositoryへ保存していない。

## 3. 旧環境の停止とexport

- [ ] 旧Vercel deploymentをread-onlyまたはmaintenance状態にした。
- [ ] 旧Vercel Blob、Turso memory DB、Turso auth DBの接続確認を行った。
- [ ] `scripts/migration/export-vercel.ts`を実行した。
- [ ] export manifestのMarkdown hash、memory数、project数、member数、PAT hash数、tombstone数を記録した。
- [ ] export出力をrepository外の暗号化された一時保管場所へ保存した。
- [ ] manifest、log、出力ファイルへprovider credentialと平文PATが含まれていないことを確認した。
- [ ] 旧Vercel/Turso/Blob credentialを切り替え完了まで保持し、先に削除していない。

## 4. importと整合性検証

- [ ] 旧UIDからFirebase UIDへの対応表をrepository外で作成し、全owner/memberを網羅した。
- [ ] `scripts/migration/import-s3-firestore.ts`を実行した。
- [ ] import前のFirestore document/request/write数preflightが成功した。
- [ ] import reportのS3 object数、Firestore memory数、membership数、PAT数、tombstone数を記録した。
- [ ] 同じmanifestを再度importし、重複やhash変更が発生しないことを確認した。
- [ ] `scripts/migration/verify-migration.ts`を実行した。
- [ ] missing、extra、hash、parse、memory metadata、name index、membership、PAT、tombstone mismatchがすべて0件である。
- [ ] S3本文を1件手動取得し、Firestore metadataのcontent hashと一致することを確認した。

## 5. Cloud Run受け入れ

- [ ] `GET /api/health` が200を返す。
- [ ] `scripts/cloud-run-smoke.ts`でMCP initialize、16 tools/list、save、search、get、update、link、reindex、deleteを確認した。
- [x] renameはMCP公開toolに含まれないため、`CloudMemoryService`の回帰テストで検証済み。実環境smokeの対象外とする。
- [ ] Firebaseログイン、session cookie交換、ログアウトをブラウザで確認した。
- [ ] 未認証Web APIが401、別projectアクセスが403、MCP PATが対象projectだけへ到達することを確認した。
- [ ] `__shared__`のwriteがFirebase UIDとmaintenance tokenの二重条件を満たさない限り拒否される。
- [ ] Cloud Run cold start後もFirestore metadataからSQLite cacheをreindexできる。
- [ ] Cloud Run logへPAT本文、Firebase credential、AWS secretが出力されない。
- [ ] 無料枠を超える可能性のあるS3、Firestore、Artifact Registry、Cloud Runの使用量監視を設定した。

## 6. 切り替えとrollback

- [ ] Cloud Run revision URL、smoke実行日時、commit SHA、import reportを運用記録へ保存した。
- [ ] DNS、カスタムドメイン、MCP client、Claude Code設定、curator設定をCloud Runへ切り替えた。
- [ ] 切り替え後に新環境でmemory writeを1件実行し、S3とFirestoreの両方を確認した。
- [ ] rollback期間と判断責任者を決めた。
- [ ] 最終S3 snapshotとFirestore exportまたは復旧手順をrepository外へ保存した。
- [ ] 旧Vercel環境へのwriteが拒否されることを確認した。

## 7. Vercel削除（最後の不可逆操作）

- [ ] rollback期間が終了し、Cloud Run smokeとmigration verifyが成功している。
- [ ] Vercel domain mapping、integration、environment variable、GitHub Vercel secretを削除した。
- [ ] 旧Turso、旧Blob、旧Clerk credentialを失効させた。
- [ ] 認証済みVercel ConsoleまたはCLIで旧Projectを削除した。
- [ ] Vercel Project削除日時、実行者、対象project名をこの記録へ追記した。

## 記録

- commit SHA: 未記録
- Cloud Run revision URL: 未実行
- export日時: 未実行
- import日時: 未実行
- verify日時: 未実行
- smoke日時: 未実行
- rollback終了日時: 未設定
- Vercel Project削除日時: 未実行
