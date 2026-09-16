# Roadmap

Phases are ordered by dependency, not by calendar date. Each phase has a
testable exit criterion — a phase is not "done" until its criterion is
met, regardless of how much code exists.

## Phase 0 — Bootstrap

Anchor mechanism spike (measuring false-positive/false-negative rate of
symbol/AST anchoring with a line-range fallback against real historical
refactor commits), project naming and repository bootstrap, CI skeleton
with dependency and secret scanning.

**Exit criteria**: the anchor spike's FP/FN numbers are measured and
recorded against a fixed threshold; the CI workflow passes on the empty
repository skeleton.

## Phase 1 — Data and auth — **complete**

PostgreSQL schema for workspaces, users, memberships, agent tokens, and the
audit log; credential login wired up; agent tokens with scopes, TTL,
revocation and per-token rate limiting; a Docker image and compose stack
that build and run.

**Exit criteria**: `docker compose up` brings up an empty service; an
admin account can be created through the UI; an agent token can be
issued with a TTL, used once, and is rejected after expiry.

**Status**: met.

- `docker compose up` starts PostgreSQL 16 and the application; the app
  applies its own migrations before serving, and `GET /api/v1/health`
  reports both.
- The first visit to a fresh instance creates the administrator account
  and the single workspace at `/setup`. No credentials ship in any
  migration or fixture, and `/setup` answers 404 once an account exists.
- An admin issues agent tokens from `/tokens`. The secret is displayed
  once and stored only as a SHA-256 digest, compared in constant time.
- Expiry, revocation and scope are all decided at the authentication
  layer, before handler logic runs. Every agent-token request writes an
  audit row, rejections included.
- Workspace scoping is an explicit check in each handler, not an
  assumption about there being one workspace.
- `GET /api/v1/me` and `GET /api/v1/health` are covered by unit and
  integration tests, the latter skipping cleanly with no database.

One deviation from the original plan: agent tokens live in a first-party
`agent_tokens` table with their own bearer verifier, rather than in an
authentication-library plugin. The plugin that was expected to cover this
has since moved out of the auth library's core package, and its table
carries no workspace column, no revocation timestamp and no issuing user —
all three of which the threat model in `docs/security.md` depends on.
Credential login and sessions are still library-managed.

## Phase 2 — Wiki core — **complete**

Pages, page tree, Markdown + Mermaid rendering, full-text search, and the
core REST endpoints for pages and search.

**Exit criteria**: a page can be created, read, updated, and deleted over
REST; search finds a created page by substring; a Mermaid block renders
client-side.

**Status**: met.

- `pages` and `page_revisions` ship in migration `0001_pages`. A page
  carries a body, a kind (`technical` or `human`), a nullable link to its
  counterpart of the other kind, a SHA-256 content hash, and a version.
  Deletion is a soft delete, so a page's history outlives it.
- The tree is stored as both `parent_id` and a materialised path
  (`/backend/auth`). Moving a page rewrites its descendants' paths inside
  the same transaction as the move, so the two never disagree.
- `GET/POST /api/v1/pages`, `GET/PATCH/DELETE /api/v1/pages/{id}`,
  `GET /api/v1/pages/{id}/tree`, `GET /api/v1/pages/{id}/versions`,
  `POST /api/v1/pages/{id}/link`, `GET /api/v1/search` and
  `GET /api/v1/export/{id}?format=md|html` are served by the same service
  layer the web UI renders from — the layer the MCP server wraps in
  Phase 5.
- Search is a PostgreSQL `tsvector` generated column over title, summary
  and body, with a GIN index, `ts_headline` snippets and rank ordering. A
  query that matches no whole word is retried as a prefix query, so a
  partial word still finds its page.
- Every read returns the page's content hash, and `PATCH` refuses a write
  whose `base_content_hash` no longer matches. That is the half of the
  Phase 3 write protocol that does not need claims, available now.
- Every handler is workspace-scoped in its SQL predicate, scope-checked
  (`pages:read` / `pages:write`) for agent tokens, and every write appends
  its audit row in the same transaction as the write itself.
- The UI serves a page tree, a Markdown view with client-rendered Mermaid
  diagrams, a plain-Markdown editor with a preview that goes through the
  same server-side renderer, search results, and Markdown/HTML export.

Two deviations from the plan as written. Pages carry `linked_page_id`
rather than a separate `page_links` table: v1 pairs one technical page with
one human page, which a column expresses exactly and a join table only
expresses loosely. The link's staleness flag, which is what would justify
its own row, arrives with the anchor mechanism in Phase 4 and can be added
then without moving the pairing. Authorship columns are stored as an actor
type plus an id (`created_by_type`/`created_by_id`), because a page may be
written by an agent token, whose id is not a row in `user`.

## Phase 3 — Claims and presence

Claims implemented as row-level locks, a presence endpoint, ephemeral
agent notes, and the write audit log covering both successful and
conflicting attempts.

**Exit criteria**: two concurrent claim requests on the same page resolve
to exactly one success and one conflict; TTL expiry is covered by a test;
the presence board reflects an active claim live; the audit endpoint
returns both outcomes of a conflict test.

## Phase 4 — Anchoring

Anchor creation, anchor checking, and the stale badge in the UI.

**Exit criteria**: re-running the Phase 0 spike dataset through the
shipped anchoring implementation reproduces the same FP/FN numbers within
tolerance.

## Phase 5 — MCP server

The MCP server over the same service layer as REST, both transports, and
authentication plus CORS/Origin validation on the HTTP transport.

**Exit criteria**: a real MCP client can run the full
claim → write → release sequence end to end; an unauthenticated
streamable HTTP request is rejected by a test.

## Phase 6 — Export, packaging, docs

Markdown and HTML export (required); PDF export conditional on an
image-size spike; the final Docker image and docker-compose setup,
including a no-built-in-proxy profile; the finished README, LICENSE, and
additional-terms text.

**Exit criteria**: Markdown and HTML export both open without error; PDF
export opens without error if the size spike passes, or is deferred
without changing the export contract if it does not; `docker compose up`
on a clean machine brings up a working instance using only the README.

**Pre-release gate**: a full security review pass against every control
in `docs/security.md`, not a subset, is a named exit criterion of this
phase and must complete before Phase 7 starts.

## Phase 7 — Launch

Public launch of the repository.

**Exit criteria**: the repository is public with a complete README,
license, and documentation set; the Phase 6 security review pass is
complete.
