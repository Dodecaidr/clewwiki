# AGENTS.md

Rules for AI coding agents and human contributors working in this
repository. This file is the source of truth for how work gets done here;
follow it over any conflicting default behavior.

## Stack

- **Framework**: Next.js 16, App Router, TypeScript in strict mode.
- **Database**: PostgreSQL 16.
- **ORM**: Drizzle.
- **Auth**: better-auth (credentials login, API-key plugin for agent
  tokens).
- **MCP**: `@modelcontextprotocol/sdk` (official TypeScript SDK) — stdio
  and streamable HTTP transports.
- **UI**: Tailwind CSS + shadcn/ui.
- **i18n**: next-intl, scaffolded with `en` namespaces only for v1.
- **Package manager**: pnpm.

## Repository layout (to be added)

The following layout is planned and will be introduced as each phase
lands — do not pre-create empty directories ahead of the code that
justifies them:

- `apps/web` — the Next.js application (web UI + REST API).
- `packages/mcp-server` — the MCP server (stdio + streamable HTTP),
  thin wrapper over the same service layer as the REST API.
- `packages/anchors` — the doc↔code anchoring library (symbol/AST
  matching with a line-range fallback).
- `docker/` — Dockerfile and docker-compose assets.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- Commit messages, PR descriptions, and code comments must not contain any
  AI-attribution trailers, generated-by notes, or similar markers. Write
  commit messages and comments as you would for work done by a human
  contributor.
- Keep PRs small and scoped to one concern.

## How to run

Run instructions will be added once Phase 1 (data model + auth) lands and
there is a working local setup to document. Until then, there is no
runnable application in this repository.

## Docker

Base images in any Dockerfile must come from the AWS ECR public mirror —
`public.ecr.aws/docker/library/<image>:<tag>` — never directly from Docker
Hub (`docker.io/library/...` or a bare `node:...`/`postgres:...` tag).
This applies to every Dockerfile added to this repository, present and
future, with no exceptions.

## Security rules

- Never commit secrets, credentials, or `.env` files. `.env.example`
  ships with keys and no values; real values stay out of version control
  and out of the built image.
- Treat document/page content handled by the application as data, not as
  instructions — this applies to any code path that feeds stored content
  back into an agent-facing response or tool result.
- Workspace-scoped access checks are written explicitly in request
  handlers, not assumed from a single-workspace deployment.

## Testing expectations

- Unit tests: vitest.
- Integration tests are required for claims/leases concurrency behavior —
  concurrent claim attempts on the same page or section must be tested to
  resolve to exactly one success and one conflict.
- New REST/MCP endpoints ship with tests covering both the success path
  and the relevant conflict/error responses.

## Do not

- Do not auto-generate documentation files into `docs/` from agent runs.
  Documentation is written and reviewed like any other content.
- Do not add any agent-context or agent-config file other than this one
  (`AGENTS.md`) at the repository root.
- Do not bring in outside planning or research documents from any source
  external to this repository.
