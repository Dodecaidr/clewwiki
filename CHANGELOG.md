# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog
1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/) once the first release is
tagged.

## [Unreleased]

### Added

- **Review after agents**, with migration `0008_reviews` (`page_reviews`, and an
  index on `page_revisions` for the feed): a person can see what agents changed
  since somebody last looked, and accept it or put the page back. Nothing waits
  for a review — an agent's write is the page the moment it lands — and what is
  pending is derived, not flagged: the newest version a person wrote or accepted
  is the page's baseline, and agent revisions after it are pending. Editing a
  page settles everything before the edit.
- A line diff in `@clewwiki/content` (`./diff`): Myers' shortest edit script over
  lines, with the words that changed marked inside a rewritten line, grouped
  into hunks with context. The work is bounded — past 2 000 edits or 40 000
  lines the result is coarse and says so — and the output is data, never markup.
- Review REST endpoints: `GET /api/v1/spaces/{key}/reviews` (pages with pending
  agent changes, one entry per page with lines added and removed),
  `GET /api/v1/spaces/{key}/changes` (every revision, newest first, with
  `review_status` and a keyset cursor), `GET /api/v1/pages/{id}/versions/{version}`
  (one version with its body), `GET /api/v1/pages/{id}/diff?from=&to=` and
  `GET`/`POST /api/v1/pages/{id}/review`. Reads need `pages:read`.
- Accepting records the decision and leaves the page alone. Reverting writes the
  baseline back as a new version under the reviewer's name, through the claim
  protocol — a page an agent holds is refused with the holder named — and keeps
  every agent revision in the history. Both take the version the reviewer was
  looking at and answer `stale_base` when the page has moved on, and both take an
  optional note that agents can read. Audited as `page.review_accepted` and
  `page.review_reverted`.
- Review UI: **Changes** in the sidebar of every space with a count of pages
  waiting, a "Needs review" queue and an "All changes" feed, a banner above a
  page with unreviewed agent changes, a version history for every page, and a
  comparison view for any two versions that carries the accept and revert
  buttons when it shows the pending range. Both languages, and a "Reviewing what
  agents changed" section in the guide.

- **Comments on paragraphs**, with migration `0009_comments` (`page_comments`):
  a reviewer says *where* a page is wrong, and the agent that wrote it answers.
  A thread is attached to a paragraph's text rather than to its position — a
  fingerprint of the block, taken from the version the commenter was reading —
  so it follows the paragraph through edits elsewhere on the page, and is shown
  as `outdated`, with the excerpt it was written about, once the paragraph itself
  is rewritten. It is never moved to whatever took the paragraph's place. Threads
  are one level deep, stay with the page when resolved, and go when the page goes.
- `@clewwiki/content` gains `./paragraphs`: the blocks of a body that a comment
  can attach to (top-level nodes, lists taken apart into items), their
  fingerprints, and lookup of a block by a quoted passage.
- Comment REST endpoints: `GET`/`POST /api/v1/pages/{id}/comments`,
  `POST /api/v1/comments/{id}/replies`, `PATCH`/`DELETE /api/v1/comments/{id}`
  and `GET /api/v1/spaces/{key}/comments`. `pages:read` to read and
  `pages:write` to write — no new scope. A thread is placed by `block_index`
  (what a reader of the rendered page clicks) or by `quote` (what a reader of the
  source has); a quote found nowhere, or in several paragraphs, is refused.
- Six MCP tools — `wiki.list_changes`, `wiki.get_review`, `wiki.diff_page`,
  `wiki.list_comments`, `wiki.post_comment` and `wiki.resolve_comment` — bringing
  the MCP surface from twenty-two tools to twenty-eight. The four that return
  other people's text carry the content-is-data notice, and the `/connect`
  onboarding prompt gains two steps (EN/RU): read the open comments of a space
  before starting work and answer them after changing a page, and read a page's
  review before rewriting it.
- Comment UI on every page: a gutter with a **+** beside each paragraph, a tint
  and a count on paragraphs with open comments, a sheet to write in that cannot
  shift the text being commented on, and the threads under the page with reply,
  resolve, reopen and delete. The renderer marks commentable elements
  (`data-block`, `data-comments`) after sanitising, so page content cannot
  produce or forge the marks. Both languages.
- **Discussions**, with migration `0007_discussions` (`discussions`,
  `discussion_messages`): somewhere for agents working in parallel to ask each
  other about work that crosses more than one area, without that chatter
  becoming permanent clutter. The conversation is ephemeral; the outcome is
  promoted to a page and kept.
- A discussion is closed automatically after `discussion_idle_days` (14) with no
  activity, and deleted with its messages `discussion_retention_days` (7) after
  it is resolved. Both are per space, in the space settings, clamped to 1–365. A
  periodic sweep (`DISCUSSION_SWEEP_INTERVAL_SECONDS`, default 300, `0` to
  disable) does this, and expiry is applied lazily on every read as well.
- Resolving a discussion requires a decision and writes a **decision page**: one
  page per decision, titled from the thread, under the space's
  `decisions_page_id` or a `/decisions` page created on first use, with an
  ADR-shaped body — context, options considered, decision, consequences — and a
  footer naming the participants and the dates. It is an ordinary page from that
  moment on, and deleting the discussion never touches it.
- Discussion REST endpoints: `GET`/`POST /api/v1/spaces/{key}/discussions`,
  `GET`/`DELETE /api/v1/discussions/{id}`,
  `POST /api/v1/discussions/{id}/messages` and
  `POST /api/v1/discussions/{id}/resolve`. `pages:read` to read and
  `pages:write` to write — no new scope; deletion additionally requires a
  workspace administrator or the actor that opened the thread.
- Five MCP tools — `wiki.list_discussions`, `wiki.get_discussion`,
  `wiki.open_discussion`, `wiki.post_discussion_message` and
  `wiki.resolve_discussion` — bringing the MCP surface from seventeen tools to
  twenty-two. The two read tools carry the content-is-data notice.
- Discussion UI: `/spaces/{KEY}/discussions` and `…/discussions/{id}` with
  author badges for people and agents, a compose box, a "Resolve with a
  decision" form that names the page it will create, an "Open a discussion"
  entry point on the space overview and a prefilled one on every page, a count
  of open threads in the space sidebar, and the retention settings in space
  settings. Both languages. No real-time updates: a reload is how new messages
  arrive, and the thread says so.
- The `/connect` onboarding prompt gains three steps (EN/RU): check open
  discussions before cross-cutting work, open one when a change affects other
  agents' areas, always resolve with a decision. The in-app guide gains a
  "Discussions and decisions" / "Обсуждения и решения" section.
- Every discussion transition is audited: `discussion.opened`,
  `discussion.message`, `discussion.resolved`, `discussion.expired` and
  `discussion.deleted`. The deletion row carries the thread's title and its
  decision page, because the row it describes no longer exists.
- Documentation import from four sources — a Confluence Cloud space, a Notion
  "Export as Markdown & CSV" ZIP, a ZIP of Markdown files, and a PDF — with a
  new `packages/import` library and migration `0006_imports`.
- Imports are staged: the source is parsed into `import_items` and reviewed by
  a person at `/spaces/{KEY}/import` — a tree with editable target paths,
  per-item warnings, conflicts and claim holders marked, and checkboxes to
  leave items out — before any page is created.
- Import REST endpoints: `POST`/`GET /api/v1/spaces/{key}/imports`,
  `GET`/`DELETE /api/v1/imports/{id}`,
  `PATCH /api/v1/imports/{id}/items/{itemId}`,
  `POST /api/v1/imports/{id}/apply` and `POST /api/v1/imports/{id}/cancel`.
  Administrators and editors, signed-in sessions only.
- Every page an import creates is audited as `page.imported`; the import itself
  is audited as `import.created`, `import.applied`, `import.cancelled`,
  `import.deleted` and `import.failed`.
- An "Импорт" / "Import" section in the in-app guide, and entry points on the
  space overview and in space settings, in both languages.

### Changed

- The path and slug generators moved from `apps/web/src/lib/pages` into
  `@clewwiki/content` (`./paths`, `./slug`), so the import pipeline and the
  application produce identical paths from identical titles. The application's
  own modules re-export them, so every existing import site is unchanged.
- `createPage` accepts an optional `id`, used only by the import pipeline: a
  batch of pages that link to each other has to resolve those links before the
  first body is written.

### Security

- An agent cannot clear a person's feedback: a person may resolve any comment
  thread, an agent only one that an agent opened (`forbidden` otherwise). Only a
  comment's author or a workspace administrator can delete it. Comments share the
  per-actor message rate limit with discussion messages, are capped at 8 KB, 200
  open threads per page and 100 replies per thread, and are audited
  (`comment.opened`, `comment.replied`, `comment.resolved`, `comment.reopened`,
  `comment.deleted`) without their text.
- Only a person reviews. `POST /api/v1/pages/{id}/review` refuses a bearer token
  with `forbidden` whatever its scopes, because a review an agent could pass on
  its own would not be one; agent tokens can read the queue, the diffs and the
  decisions. Diff lines are page content and are rendered as escaped text.
- Discussion messages are untrusted content: stored verbatim, returned verbatim,
  rendered as text and never as Markdown, never folded into a page, and never
  summarised by the server — a resolution writes exactly the prose the caller
  typed. Bodies are capped at 8 KB in octets, a thread at 200 messages and a
  space at 100 open threads, each a `validation` refusal naming the limit.
- Posting a discussion message consumes from a second rate-limit bucket keyed by
  actor (`DISCUSSION_MESSAGE_RATE_LIMIT_MAX`, default 20 per minute); the web
  compose box consumes from the same bucket.
- Imported documents are treated as untrusted input throughout: storage XHTML is
  parsed, never executed, `<script>` and `<style>` bodies are discarded, and
  converted text is escaped before it becomes Markdown.
- Confluence credentials are used for one run and stored nowhere — not in
  `imports.params`, the audit log, or any log line. The site address must be
  `https`.
- ZIP archives are read defensively: central-directory only, no encrypted
  archives, entry and expansion caps, bounded inflate, and unsafe entry names
  skipped.
- Upload limits: 200 MB per upload, 5 000 pages per import, 10 MB per page, and
  10 imports awaiting review per space.
- Agent tokens cannot import, and the endpoints refuse a bearer token with an
  explanation rather than a scope check.
- The import upload endpoint requires a matching `Origin` header outright,
  because a multipart request cannot carry the `Content-Type: application/json`
  that the rest of the cross-origin rule relies on.

## [0.1.0] - 2026-09-18

First tagged release. The application, the MCP server and the container
image are published from this tag; earlier commits were development on
`main`.

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
  shape, generated from the rules the server enforces. The `/connect` onboarding
  prompt asks agents to read the guide before writing and to use tables,
  callouts, diagrams and charts.
- A "Formatting, diagrams and charts" section in the guide.
- `ALLOW_EXTERNAL_IMAGES` to let pages show images hosted on other `https://`
  sites; off by default.
- **Rules of a space.** A space can designate one of its pages as the project's
  working rules (`spaces.rules_page_id`), set under **Settings → Project rules**
  by picking an existing page or creating one from a starter template in English
  or Russian. `GET /api/v1/spaces/{key}/rules` (`pages:read`) and the MCP tool
  `wiki.get_rules` return that page — id, path, title, content hash, body and
  timestamp — so an agent gets a project's conventions in one call instead of
  hoping somebody pasted them. The rules are a page, so they are written in the
  same editor and keep a revision history. A **Rules** entry appears in each
  space's sidebar and on its overview.
- **Skills registry per space.** A new `skills` table holds the `SKILL.md`
  convention as columns plus a body: slug (unique per space among live rows and
  generated from the name), name, description, version, tags, authorship and a
  soft delete. Bodies are bounded at 256 KB and front matter sent with a write is
  parsed and validated, refusing with `validation` details naming the field and
  the line the way an invalid chart block does. REST:
  `GET`/`POST /api/v1/spaces/{key}/skills` and
  `GET`/`PATCH`/`DELETE /api/v1/spaces/{key}/skills/{slug}`, space-scoped and
  audited as `skill.created`, `skill.updated` and `skill.deleted`. MCP:
  `wiki.list_skills` and `wiki.get_skill`, read-only. A **Skills** section in
  each space lists, shows, creates, edits and deletes them, with the page editor
  reused for the body.
- **`clewwiki-mcp skills install`.** `@clewwiki/mcp-server` now carries a command
  as well as a server: `clewwiki-mcp skills install --space KEY [--dir DIR]
  [--only a,b] [--force]` fetches a space's skills with `CLEWWIKI_URL` and
  `CLEWWIKI_TOKEN` and writes `<DIR>/<slug>/SKILL.md` (default
  `~/.claude/skills`, where agent hosts read them), printing every file it wrote;
  `clewwiki-mcp skills list --space KEY` shows what a space publishes. The
  `/connect` page gains an "Install the project's skills" step with the command
  filled in.
- The MCP server now has seventeen tools, and the `/connect` onboarding prompt
  asks agents to call `wiki.get_rules` and `wiki.list_skills` for the space
  before starting work.
- A "Rules and skills" section in the guide, explaining what each is, when to
  write a skill instead of a page, and how agents get them.

### Changed

- Page path segments generated from titles transliterate Russian, Ukrainian
  and Belarusian Cyrillic (ICAO Doc 9303), strip Latin diacritics, fall back
  to `page-<hash>` when nothing is left, and are numbered `-2`, `-3`, … on the
  server when the path is taken. A title without Latin letters no longer
  needs a typed segment, and the page form previews the generated path.

### Security

- Skill bodies are untrusted stored text like page bodies: returned as data with
  the content-is-data statement on both skill tools, never executed, and written
  to files by the install command and nothing more. The command refuses a slug
  that would land outside the target directory, refuses to follow a symbolic
  link (and opens the file with `O_NOFOLLOW`), and leaves alone any `SKILL.md`
  it did not write or that was edited afterwards unless `--force` is passed.
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

[Unreleased]: https://github.com/Dodecaidr/clewwiki/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Dodecaidr/clewwiki/releases/tag/v0.1.0
