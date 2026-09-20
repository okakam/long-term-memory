# Devcontainer Google Cloud CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 開発コンテナから `gcloud` と Firebase CLIを使って、Cloud Run/Firebase/GCS/Firestoreの初期設定を再現できるようにする。

**Architecture:** `.devcontainer/Dockerfile`へGoogle Cloud CLIの公式APTリポジトリとFirebase CLIを追加する。CLIの認証状態は開発用named volumeへ保存し、リポジトリには認証情報を置かない。GCPリソース作成、WIF、IAM、Secret Manager、Firestore Rules適用の手順を日本語の運用文書へ集約する。

**Tech Stack:** Node.js 22、Debian Bookworm、Google Cloud CLI、Firebase CLI、Docker Compose、GitHub Actions Workload Identity Federation。

**Spec:** `docs/reproduction-spec.md`、`docs/cloud-run-production-deployment.md`、`docs/google-cloud-cli-setup.md`

## Global Constraints

- Cloud Runは `asia-northeast1`、min 0、max 1、concurrency 1、1 vCPU、512 MiBを初期値とする。
- Cloud Run runtimeはApplication Default Credentialsを使い、サービスアカウントキーを作成・保存しない。
- Markdown本文はGCS、metadata・認可はFirestore、検索cacheは `/tmp` SQLiteとする。
- `main`と`develop`へは直接pushせず、featureブランチとPull Requestを使う。
- ローカルDocker buildは実施せず、Compose構文検証と静的確認を実施する。

---

### Task 1: CLIをdevcontainerへ追加する

**Files:**
- Modify: `.devcontainer/Dockerfile`
- Modify: `.devcontainer/compose.yaml`
- Modify: `.devcontainer/README.md`

- [x] Google Cloud CLIを公式APTリポジトリからインストールする。
- [x] Firebase CLIをグローバルnpmパッケージとしてインストールする。
- [x] 使用しないTurso CLIのインストール・PATH・手順を削除する。
- [x] gcloud/Firebase CLI認証をnamed volumeへ保存する。

### Task 2: gcloud/Firebaseによる初期設定手順を文書化する

**Files:**
- Create: `docs/google-cloud-cli-setup.md`
- Modify: `docs/cloud-run-production-deployment.md`
- Modify: `docs/reproduction-spec.md`
- Modify: `AGENTS.md`
- Modify: `README.md`

- [x] GCP API、GCS、Firestore、Firebase Authentication、サービスアカウント、IAM、Secret Managerをgcloudコマンドで設定する手順を書く。
- [x] GitHub WIFのprovider、repository/ref制限、deploy service account bindingを記録する。
- [x] Firebase CLIでFirestore Rules/Indexesを適用する手順を書く。
- [x] GitHub `production` Environmentのsecret/variable名と取得元を記録する。
- [x] 初回deploy、Cloud Run URL取得、smoke PAT発行、mainリリースの順序を記録する。

### Task 3: 構文・差分・CLI導入設定を検証する

**Files:**
- Verify: changed YAML/JSON/Markdown/Dockerfile files

- [ ] `docker compose -f .devcontainer/compose.yaml config --quiet`を実行する（現在の検証環境にDocker CLIがないため未実施）。
- [x] `git diff --check`を実行する。
- [x] Docker CLIが利用できないためDockerfile buildを未実施として記録する。
- [x] 認証情報、秘密値、実在`.env`が差分に含まれないことを確認する。

## 検証結果

- `pnpm test`: 67 files・193 tests passed（sandboxの子プロセスEPERMを権限付き再実行で解消）。
- `pnpm lint`: passed。
- JSON構文検証: `.devcontainer/devcontainer.json`、`firebase.json`、`firestore.indexes.json` passed。
- `git diff --check`: passed。
- Docker Compose/Dockerfile build: Docker CLIが検証環境にないため未実施。Dev Container rebuild後に `node`、`pnpm`、`codex`、`gh`、`gcloud`、`firebase`、`jq`のバージョン確認を行う。
