# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog
1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/) once the first release is
tagged.

## [Unreleased]

Nothing has been tagged yet. This section describes what exists in the
repository today, ahead of the first release, `v0.1.0`, which will be
tagged after the UI design pass.

### Added

- Workspace, user, membership, and agent-token data model, with credential
  login and scoped, TTL-bound agent tokens.
- Wiki core: pages, page tree, revision history, full-text search, and the
  page REST API, including Markdown and HTML export.
- Claims and leases: page- and section-level claims, a presence board,
  ephemeral agent notes, and a write audit log covering both successful
  and conflicting attempts.
- Doc↔code anchoring with staleness detection: symbol/AST matching with a
  line-range fallback, anchor states (`fresh`, `stale`, `moved-renamed`,
  `lost`), and a `confirm` action to clear a flag after review.
- MCP server (`packages/mcp-server`, `@clewwiki/mcp-server`) exposing
  eleven tools over the same service layer as the REST API, with both
  stdio and streamable HTTP (`/mcp`) transports.
- Docker image and `docker-compose.yml` for a two-container deployment
  (application + PostgreSQL 16), plus a `docker-smoke` CI job that builds
  the image and walks the full first-run path over HTTP.
- Packaging for `@clewwiki/mcp-server` as a standalone npm package
  (`publishConfig`, `bin`, `files`), ready for its first publish.

### Security

- Password sign-in rate limiting, keyed per account and per client
  address, with the client address read only from a configurable trusted
  proxy header.
- A one-time setup token required by first-run `/setup`, generated at
  start-up and printed once to the log when not configured explicitly.
- Public self-registration disabled; `/setup` is the only way an account
  is created, and it answers 404 once one exists.
- Repository credential restrictions: a workspace's access-token setting
  may only name `CLEWWIKI_GIT_TOKEN` or `CLEWWIKI_GIT_TOKEN_<NAME>`, the
  token is sent only to the `https://` origin of the repository, and
  repository URLs with embedded credentials, `git://`, `ext::`, or a
  leading `-` are refused.
- A separate `pages:delete` scope for subtree deletion, refused while
  another actor holds a live claim in the subtree unless the caller is an
  administrator, with an administrator-only restore endpoint.
- CSRF hardening: cookie-authenticated REST writes must carry the
  instance's own origin and a JSON content type, closing the gap
  `SameSite=Lax` leaves on its own.
- MCP batch limits: the streamable HTTP endpoint refuses more than ten
  JSON-RPC messages per request.
- Anchor-check resource budgets: a file, byte, and time budget per check,
  with an explicit partial result instead of silent truncation, and
  recomputation moved to a `POST` requiring `pages:write`.

[Unreleased]: https://github.com/Dodecaidr/clewwiki/commits/main
