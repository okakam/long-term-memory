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
    LTM_HOME=/data \
    PORT=3939
COPY --from=prod_deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder  /app/src/lib/db/schema.sql ./src/lib/db/schema.sql
COPY package.json next.config.ts ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3939
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3939"]
