# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm build

FROM deps AS prod_deps
RUN pnpm prune --prod

FROM base AS runner
ENV NODE_ENV=production \
    LTM_STORAGE_DRIVER=cloud \
    AUTH_REQUIRED=1 \
    LTM_HOME=/tmp/long-term-memory \
    PORT=8080
COPY --from=prod_deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder  /app/src/lib/db/schema.sql ./src/lib/db/schema.sql
COPY --from=builder /app/src/lib/security/content-security-policy.ts ./src/lib/security/content-security-policy.ts
COPY package.json next.config.ts ./
RUN mkdir -p /tmp/long-term-memory
EXPOSE 8080
EXPOSE 3939
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0 -p \"${PORT:-8080}\""]
