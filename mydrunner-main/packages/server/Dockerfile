# Production image for the mydrunner game server.
# Runs via tsx so we don't need a separate build step for the shared
# package - same code path as dev, just NODE_ENV=production.
#
# Build context = monorepo root:
#   docker build -f packages/server/Dockerfile -t mydrunner-server .

FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

# Install all workspace deps (shared + server). Cache-friendly because
# package.json files are copied before sources.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter '@mydrunner/server...'

# Sources.
COPY packages/shared packages/shared
COPY packages/server packages/server

ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:2567/health || exit 1

CMD ["pnpm", "--filter", "@mydrunner/server", "run", "start"]
