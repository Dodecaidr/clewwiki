# Base images come from the AWS ECR public mirror, never Docker Hub directly:
# anonymous Hub pulls are rate-limited per source IP, which makes an unrelated
# project on the same host able to break this build.
FROM public.ecr.aws/docker/library/node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app


# ---------------------------------------------------------------------------
# Dependencies: cached independently of the source tree.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile


# ---------------------------------------------------------------------------
# Build: produces the standalone server bundle.
# ---------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY . .

# The build must not depend on a reachable database or on real secrets. These
# values exist only so module initialisation succeeds while routes are
# compiled; every route is server-rendered on demand, so nothing here is baked
# into a page, and the runtime stage does not inherit them.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
ENV BETTER_AUTH_SECRET=build-time-placeholder-value-replaced-at-runtime
ENV BETTER_AUTH_URL=http://localhost:3000

RUN pnpm --filter @clewwiki/web build


# ---------------------------------------------------------------------------
# Runtime: the standalone output, its static assets, and the migration SQL.
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# The bundled application cannot resolve the workspace package layout any more,
# so it is told where the SQL files landed.
ENV CLEWWIKI_MIGRATIONS_DIR=/app/migrations

RUN groupadd --system --gid 1001 clewwiki \
 && useradd --system --uid 1001 --gid clewwiki clewwiki

# Next's standalone output already contains the pruned node_modules it needs,
# including the migrator, which `src/instrumentation.ts` pulls into the trace.
COPY --from=builder --chown=clewwiki:clewwiki /app/apps/web/.next/standalone ./
COPY --from=builder --chown=clewwiki:clewwiki /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=clewwiki:clewwiki /app/packages/db/drizzle ./migrations

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER clewwiki
EXPOSE 3000

# No secret is baked in: DATABASE_URL and BETTER_AUTH_SECRET are supplied at run
# time, and the entrypoint refuses to start without them.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
