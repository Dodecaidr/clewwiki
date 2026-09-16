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

## Phase 1 — Data and auth

PostgreSQL schema for workspaces, users, and agent tokens; better-auth
wired up with TTL and rate limiting; a Docker skeleton that builds.

**Exit criteria**: `docker compose up` brings up an empty service; an
admin account can be created through the UI; an agent token can be
issued with a TTL, used once, and is rejected after expiry.

## Phase 2 — Wiki core

Pages, page tree, Markdown + Mermaid rendering, full-text search, and the
core REST endpoints for pages and search.

**Exit criteria**: a page can be created, read, updated, and deleted over
REST; search finds a created page by substring; a Mermaid block renders
client-side.

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
