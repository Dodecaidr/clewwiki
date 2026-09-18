# Base images come from the AWS ECR public mirror, never Docker Hub directly:
# anonymous Hub pulls are rate-limited per source IP, which makes an unrelated
# project on the same host able to break this build.
#
# Both stages use the same tag, so the runtime's glibc and Node match what the
# build ran on. The tag is not pinned by digest — a pinned digest also freezes
# out the base image's security updates — but for the record, when this file
# was last reviewed `node:22-slim` resolved to
#   sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
# (multi-arch index; Node 22.23.2, Debian bookworm).


# ---------------------------------------------------------------------------
# Build: install the workspace, compile the standalone server, gather the files
# the server reads at run time. Nothing from this stage ships except what the
# runtime stage copies out of it by name.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:22-slim AS build
# digest at last review: sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# Manifests first, so the dependency layer is reused until one of them changes.
# Every workspace package must be listed: the lockfile names all of them, and a
# frozen install refuses a workspace that does not match it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/anchors/package.json ./packages/anchors/
COPY packages/content/package.json ./packages/content/
COPY packages/import/package.json ./packages/import/
COPY packages/mcp-server/package.json ./packages/mcp-server/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# The build must not depend on a reachable database or on real secrets. These
# values exist only so module initialisation succeeds while routes are
# compiled; every route is server-rendered on demand, so nothing here is baked
# into a page. They are scoped to this one command rather than set with ENV, so
# they are not recorded in the image configuration of any stage.
RUN DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    BETTER_AUTH_SECRET=build-time-placeholder-value-replaced-at-runtime \
    BETTER_AUTH_URL=http://localhost:3000 \
    pnpm --filter @clewwiki/web build

# The tree-sitter grammars are WebAssembly files nothing imports statically.
# They are gathered into one directory here — dereferencing pnpm's symlinks in
# the process — and the runtime stage is told where they landed, the same
# arrangement the migration SQL uses. The copy the build step leaves beside the
# app ends up in the standalone trace as well; it is removed so the image does
# not carry the same 8 MB twice.
RUN pnpm --filter @clewwiki/anchors export-grammars /app/grammars \
 && rm -rf /app/apps/web/.next/standalone/apps/web/grammars

# The trace also pulls in the image optimizer's native library (sharp and
# libvips, tens of megabytes). Nothing in the application renders `next/image`, and
# Next only loads that library when an image is optimised, so it is dropped.
RUN cd /app/apps/web/.next/standalone/node_modules/.pnpm \
 && rm -rf sharp@* @img+* node_modules/sharp node_modules/@img


# ---------------------------------------------------------------------------
# Runtime: Node, git, the standalone output, its static assets, the migration
# SQL and the grammars. No pnpm, no package store, no compiler, no source tree.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:22-slim AS runtime
# digest at last review: sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

LABEL org.opencontainers.image.title="clewwiki" \
      org.opencontainers.image.description="Self-hosted knowledge base where people and coding agents write together: claims instead of silent overwrites, pages anchored to the code they describe, REST and MCP." \
      org.opencontainers.image.source="https://github.com/Dodecaidr/clewwiki" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# The bundled application cannot resolve the workspace package layout any more,
# so it is told where the SQL files landed.
ENV CLEWWIKI_MIGRATIONS_DIR=/app/migrations
# Same idea for the tree-sitter grammars the anchor checker parses with.
ENV CLEWWIKI_GRAMMARS_DIR=/app/grammars
# Where the read-only mirrors of workspace repositories live. Mount a volume
# here, or every check re-clones after a restart.
ENV REPOS_DIR=/data/repos

# git is a runtime dependency of the anchor checker: it clones each workspace's
# repository as a bare mirror and reads blobs out of it. No working tree is
# ever created, so nothing from a repository is laid out on disk in a form
# anything could execute. ca-certificates is what lets it talk to https remotes.
# No SSH client is installed: private repositories are reached over https with
# an access token named in the workspace settings.
#
# The package managers that ship with the Node image are removed. The server
# never installs anything at run time, so npm, npx, corepack and yarn are only
# size and scanner findings here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# A fixed, unprivileged UID/GID, so a bind-mounted directory can be chowned to
# it on the host (`chown -R 1001:1001 <dir>`) without guessing. It stays 1001
# because volumes created by earlier images already belong to that id.
RUN groupadd --system --gid 1001 clewwiki \
 && useradd --system --uid 1001 --gid clewwiki --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin clewwiki \
 && mkdir -p /data/repos \
 && chown -R clewwiki:clewwiki /data

WORKDIR /app

# The application files belong to root and are only readable by the service
# user: a compromised process cannot rewrite the code it is running. The only
# places it may write are /data/repos and Next's own cache directory.
# Next's standalone output already contains the pruned node_modules it needs,
# including the migrator, which `src/instrumentation.ts` pulls into the trace.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/packages/db/drizzle ./migrations
COPY --from=build /app/grammars ./grammars
# The licence travels with the binary: AGPL-3.0 and its additional terms apply to
# whoever runs or redistributes this image, not only to readers of the source.
COPY LICENSE LICENSE-ADDITIONAL-TERMS.md NOTICE ./
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /app/apps/web/.next/cache \
 && chown clewwiki:clewwiki /app/apps/web/.next/cache

USER clewwiki:clewwiki
EXPOSE 3000

# Node rather than curl, so the probe adds nothing to the image. A database
# that cannot be reached makes the endpoint answer 503, which fails the probe.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The Next server shuts down cleanly on SIGTERM. `docker stop` sends it, and the
# entrypoint `exec`s, so the signal reaches Node rather than a waiting shell.
STOPSIGNAL SIGTERM

# No secret is baked in: DATABASE_URL and BETTER_AUTH_SECRET are supplied at run
# time, and the entrypoint refuses to start without them.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
