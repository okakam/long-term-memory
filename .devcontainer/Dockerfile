# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG PNPM_VERSION=11.1.3
ARG CODEX_VERSION=0.153.4

ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/pnpm/.corepack \
    CODEX_HOME=/home/node/.codex \
    PNPM_HOME=/pnpm \
    PATH=/home/node/.turso:/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1

# ネイティブ npm パッケージ（better-sqlite3 など）をビルドできる開発ツールを入れる。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash-completion \
      ca-certificates \
      curl \
      git \
      git-flow \
      g++ \
      gh \
      make \
      openssh-client \
      procps \
      python3 \
      jq \
      ripgrep \
      sqlite3 \
      sudo \
      xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack install --global pnpm@${PNPM_VERSION} \
    && npm install --global @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force

WORKDIR /workspace

# named volume を node ユーザーで書き込めるよう、マウント先を先に作る。
RUN mkdir -p /workspace/node_modules /workspace/.long-term-memory /home/node/.codex /pnpm/.corepack \
    && chown -R node:node /workspace /home/node/.codex /pnpm

USER node

# Turso CLI とローカル libSQL server を node ユーザーの領域へ導入する。
# 認証はイメージに含めず、コンテナ起動後に `turso auth login` で行う。
RUN curl --fail --silent --show-error --location https://get.tur.so/install.sh | bash

CMD ["sleep", "infinity"]
