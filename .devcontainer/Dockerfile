# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE}

ARG PNPM_VERSION=11.1.3

ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/pnpm/.corepack \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
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
      make \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      sqlite3 \
      sudo \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack install --global pnpm@${PNPM_VERSION}

WORKDIR /workspace

# named volume を node ユーザーで書き込めるよう、マウント先を先に作る。
RUN mkdir -p /workspace/node_modules /workspace/.long-term-memory /home/node/.codex /pnpm/.corepack \
    && chown -R node:node /workspace /home/node/.codex /pnpm

USER node

CMD ["sleep", "infinity"]
