# apps/collab-server/Dockerfile (CS-01)
#
# Build from the repo root:
#   docker build -f apps/collab-server/Dockerfile -t megaui-collab:local .
#
# Compose service name (DEP-01): megaui-collab (host 17002 → container 7002).

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat wget
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/collab-server/package.json ./apps/collab-server/
COPY packages/core/package.json ./packages/core/
# Remaining workspace package.json files keep pnpm install --frozen-lockfile happy.
COPY apps/web/package.json ./apps/web/
COPY packages/auth/package.json ./packages/auth/
COPY packages/content/package.json ./packages/content/
COPY packages/database/package.json ./packages/database/
COPY packages/email/package.json ./packages/email/
COPY packages/engine/package.json ./packages/engine/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/storage/package.json ./packages/storage/
COPY packages/ui/package.json ./packages/ui/
COPY apps/feishu-mock/package.json ./apps/feishu-mock/
RUN pnpm install --frozen-lockfile

FROM deps AS runner
COPY packages/core ./packages/core
COPY apps/collab-server ./apps/collab-server
COPY tsconfig.base.json ./

ENV NODE_ENV=production
ENV MEGA_COLLAB_PORT=7002
ENV MEGA_COLLAB_BIND=0.0.0.0
ENV MEGA_COLLAB_QUIET=1

EXPOSE 7002
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7002/health || exit 1

CMD ["pnpm", "--filter", "@megaui/collab-server", "start"]
