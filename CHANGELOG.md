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
  its tools over the same service layer as the REST API, with both
  stdio and streamable HTTP (`/mcp`) transports.
- Spaces: Confluence-style areas per project, each with its own page tree,
  overview, home page and linked source repository. Paths are unique per
  space. Migration `0004_spaces` moves existing pages and the workspace
  repository setting into a `MAIN` space per workspace.
- Space REST endpoints (`/api/v1/spaces`, `/api/v1/spaces/{key}`, archive and
  unarchive) and a space export as a ZIP of Markdown files mirroring the tree
  (`/api/v1/spaces/{key}/export`). Pages, search results, tree nodes and
  claims carry their space; search, the page tree and presence take `space`.
- Agent tokens limited to selected spaces (`agent_tokens.space_ids`), enforced
  on every page, claim, note, anchor, search, presence and export endpoint,
  and reported by `/api/v1/me`.
- MCP tool `wiki.list_spaces`, and a `space` argument for `wiki.search`,
  `wiki.list_pages`, `wiki.get_presence` and path lookups in `wiki.get_page`.
- Web UI for spaces: the space list on the home page, space overview and
  settings, a parent picker with a path preview for new pages, "Add child
  page", breadcrumbs, a space switcher, space filters on presence and search,
  and a "Spaces" section in the guide. Old `/pages/{id}` links redirect.
- Docker image and `docker-compose.yml` for a two-container deployment
  (application + PostgreSQL 16), plus a `docker-smoke` CI job that builds
  the image and walks the full first-run path over HTTP.
- Packaging for `@clewwiki/mcp-server` as a standalone npm package
  (`publishConfig`, `bin`, `files`), ready for its first publish.
- MCP tool `wiki.create_page` (`pages:write`): agents create a missing page
  inside a space and section instead of adding it to an existing page, with
  an optional pairing (`link_to_page_id`) made in the same transaction. The
  `/connect` onboarding prompt tells agents to use it.
- `POST /api/v1/pages` accepts `slug`, `parent_path` and `link_to_page_id`;
  an explicit path that is taken answers `conflict` with `existing_page_id`.

- Visual page editor, stored as Markdown: a Visual tab with a toolbar,
  keyboard shortcuts and a "/" block menu (headings, lists, task lists, quotes,
  callouts, code blocks with a language, tables with row, column and alignment
  controls, images by address, Mermaid diagrams from twelve templates with a
  live drawing, and charts edited as a data table with a live preview), and a
  Markdown tab over the same text. A page opened and saved without edits is
  stored byte for byte; an edit rewrites only the blocks it touched; a page the
  editor cannot keep exactly opens in the Markdown tab with a notice. HTML pasted
  from word processors, Google Docs or Confluence keeps its structure and loses
  its fonts and colours. Unsaved changes are guarded on navigation.
- Callouts written as GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
  `[!WARNING]`, `[!CAUTION]`), styled in the page view and the HTML export.
- Chart blocks: a ```` ```chart ```` fence holding JSON for a bar, stacked bar,
  line, area, pie, donut or scatter chart, drawn as accessible SVG on the server
  in the page view, the editor and the HTML export (so exported and printed
  pages show charts with no script). An invalid block renders as an error box
  naming the problem.
- `packages/content` (`@clewwiki/content`): the chart schema and renderer, the
  Mermaid keywords and templates, callout kinds, block validation and the
  format guide, shared by the server, the editor and the guide endpoint.
- Validation of chart and Mermaid blocks on every write (`POST /api/v1/pages`,
  `PATCH /api/v1/pages/{id}`, the MCP tools and the web form): an invalid block
  is refused with `validation` and `block_index`, `line`, `language` and
  `errors` (`path`, `message`) for each invalid block. Mermaid is checked
  structurally only and never run on the server.
- `GET /api/v1/format-guide` (`pages:read`) and the MCP tool
  `wiki.format_guide`: every supported construct with an example, the Mermaid
  keywords and a template per diagram type, the chart block JSON Schema, limits
  and an example per chart type, page conventions and the validation error
  shape, generated from the rules the server enforces. The MCP server now has
  fourteen tools, and the `/connect` onboarding prompt asks agents to read the
  guide before writing and to use tables, callouts, diagrams and charts.
- A "Formatting, diagrams and charts" section in the guide.
- `ALLOW_EXTERNAL_IMAGES` to let pages show images hosted on other `https://`
  sites; off by default.

### Changed

- Page path segments generated from titles transliterate Russian, Ukrainian
  and Belarusian Cyrillic (ICAO Doc 9303), strip Latin diacritics, fall back
  to `page-<hash>` when nothing is left, and are numbered `-2`, `-3`, … on the
  server when the path is taken. A title without Latin letters no longer
  needs a typed segment, and the page form previews the generated path.

### Security

- The sanitiser allowlist gains only the SVG elements and presentation
  attributes the chart renderer emits; no element or attribute that can load,
  link or run anything. Script, event handlers, `foreignObject`, styles,
  animations and `javascript:` links in SVG stay stripped, and are tested.

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
