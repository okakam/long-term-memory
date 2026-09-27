# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/pnpm/.corepack \
    CODEX_HOME=/home/node/.codex \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1

# ネイティブ npm パッケージ（better-sqlite3 など）とGoogle Cloud CLIを使える開発ツールを入れる。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash-completion \
      ca-certificates \
      curl \
      git \
      git-flow \
      g++ \
      gh \
      gnupg \
      make \
      netcat-openbsd \
      openssh-client \
      openssh-server \
      procps \
      python3 \
      jq \
      ripgrep \
      sqlite3 \
      sudo \
      xz-utils \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl --fail --silent --show-error --location https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor --yes --output /etc/apt/keyrings/google-cloud.gpg \
    && chmod a+r /etc/apt/keyrings/google-cloud.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/google-cloud.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      google-cloud-cli \
    && rm -f /etc/ssh/ssh_host_* \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack install --global pnpm \
    && npm install --global @openai/codex \
    && npm install --global firebase-tools \
    && npm cache clean --force

COPY .devcontainer/start-devcontainer-sshd /usr/local/bin/start-devcontainer-sshd

RUN chmod 0755 /usr/local/bin/start-devcontainer-sshd \
    && mkdir -p /etc/ssh/sshd_config.d \
    && printf '%s\n' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'PermitRootLogin no' \
      > /etc/ssh/sshd_config.d/99-devcontainer.conf

WORKDIR /workspace

# named volume を node ユーザーで書き込めるよう、マウント先を先に作る。
RUN mkdir -p /workspace/node_modules /workspace/.long-term-memory /home/node/.codex /home/node/.config /pnpm/.corepack \
    && chown -R node:node /workspace /home/node/.codex /home/node/.config /pnpm

EXPOSE 22

CMD ["sleep", "infinity"]
