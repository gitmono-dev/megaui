# apps/web/Dockerfile (SC-03)
#
# Multi-stage build for the megaui `web` Next.js app.
#
# Targets:
#   - deps     intermediate: install the full pnpm workspace (cached layer)
#   - builder  intermediate: `next build` (standalone output) for `web`
#   - runner   production image running the standalone Next server
#              (mega2 compose service: website-next)
#   - db-init  image that can run drizzle-kit / migrations against the
#              mega2-provided Postgres instance
#              (mega2 compose service: website-db-init)
#
# Build from the repo root so the whole pnpm workspace is in context.
# The default target is the production web server. Tag pushes publish that
# image to Docker Hub as ${DOCKER_USER}/megaui.
#   docker build -f apps/web/Dockerfile -t megaui-web:local .
#   docker build -f apps/web/Dockerfile --target db-init -t megaui-db-init:local .
#
# Reference: upstream apps/next-app/Dockerfile (REF-01), simplified (no mjml /
# nuxt / tanstack sibling copies — this workspace only ships apps/web +
# apps/collab-server).

# ---- base -------------------------------------------------------------
FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# ---- deps ---------------------------------------------------------------
# Copy manifests first so source edits do not invalidate the install layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/collab-server/package.json ./apps/collab-server/
COPY packages/auth/package.json ./packages/auth/
COPY packages/content/package.json ./packages/content/
COPY packages/core/package.json ./packages/core/
COPY packages/database/package.json ./packages/database/
COPY packages/email/package.json ./packages/email/
COPY packages/engine/package.json ./packages/engine/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/storage/package.json ./packages/storage/
COPY packages/ui/package.json ./packages/ui/
COPY apps/feishu-mock/package.json ./apps/feishu-mock/
RUN pnpm install --frozen-lockfile

# ---- builder ------------------------------------------------------------
FROM deps AS builder
COPY . .
# NEXT_PUBLIC_* is inlined at build time. Leave unset unless the builder
# passes --build-arg; do not bake a localhost default into the client bundle
# (runtime env cannot rewrite an already-inlined value).
ARG NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL
ENV NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL=$NEXT_PUBLIC_MEGA_COLLAB_PUBLIC_URL
RUN pnpm turbo run build --filter=@megaui/web

# ---- db-init ------------------------------------------------------------
# Image able to run drizzle-kit migrations against the mega2-provided
# Postgres instance (compose service: website-db-init). drizzle-kit is
# installed only inside this image layer — it is intentionally not added
# to the committed lockfile (Release write set = N/A for SC-03).
FROM deps AS db-init
COPY . .
RUN pnpm add -Dw drizzle-kit@0.31.10
RUN mkdir -p packages/database/drizzle && touch packages/database/drizzle/.gitkeep

# Default command is a stub until PK-05 lands drizzle.config.ts + real
# migrations; mega2's website-db-init service overrides the command
# with the actual `drizzle-kit migrate` invocation once schema exists.
CMD ["pnpm", "exec", "drizzle-kit", "--version"]

# ---- runner ---------------------------------------------------------------
# Standalone Next.js production server (compose service: website-next).
FROM base AS runner
# Port 7001 matches mega2 compose website-next publish/healthcheck
# contract (host 17001 → container 7001); DEP-01 will point that service here.
ENV NODE_ENV=production
ENV PORT=7001
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Writable cache for image optimizer / ISR under the non-root user.
RUN mkdir -p apps/web/.next/cache \
  && chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 7001

CMD ["node", "apps/web/server.js"]

