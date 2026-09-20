# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog
1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/) once the first release is
tagged.

## [Unreleased]

### Added

- **Your account.** Behind your name in the header: change your name, and your
  password by giving the current one. Changing the password signs every other
  session out. Attempts are limited to five per quarter of an hour.
- **A viewer role.** For the people a wiki is written *for*: a viewer reads
  everything they can see — pages, discussions, comments, history, search,
  exports — has an inbox and an account, and changes nothing. Invite somebody as
  a viewer, or change a member's role, on **Members**. Enforced where a
  read-only agent token already was: over REST a viewer has `identity:read` and
  `pages:read` and gets `403` from anything that needs more. Migration
  `0018_viewer_role`.
- **Reset links.** An administrator can make a reset link for a member who has
  forgotten their password — **Members** → **Reset link**. Shown once, stored as
  a hash, good once, for 24 hours; using it sets the password and ends every
  session of that account. Until now the only remedy was removing the person and
  inviting them again, which made a new account. Migration
  `0017_password_resets`. `docs/deploy.md` gains a section on recovering a
  workspace's last administrator.
- **An install check.** A workflow that follows the README's quick start on a
  clean runner against what is published — the image on GHCR and the MCP package
  on npm, not a local build — then sets the instance up the way a person would
  and connects `npx -y @clewwiki/mcp-server` to it over stdio. It runs on every
  release, weekly, and on demand. `scripts/mcp-stdio-check.mjs` is the second
  half and runs against any instance.

- **Import from Confluence Server and Data Center.** The Confluence form now
  asks where the site runs. A Server or Data Center is read over the REST API
  v1: the address may carry a context path, the hierarchy comes from each page's
  ancestors, a listing is paged by counting rather than by the link the server
  offers, and the credential is a personal access token, a username and
  password, or nothing at all for a space that is readable without signing in.
  Atlassian makes Data Center read-only on 28 March 2029 and its own MCP server
  reaches Cloud only. Checked against a live public Data Center as well as
  against fixtures; a site behind single sign-on has not been tried.
- **`IMPORT_CONFLUENCE_PRIVATE_HOSTS`.** An import connects to an address
  somebody typed, so it connects to public addresses only. A Confluence on a
  private network is reached when the operator lists its host name here, and
  then only on private ranges: the loopback, link-local, multicast and reserved
  space stay refused whatever is listed, and a name is checked again inside the
  socket's own resolution.

### Documentation

- **How it compares** (`docs/compare.md`): clewwiki next to Confluence, Docmost,
  Outline, BookStack and Wiki.js, each claim linked to its source, with the cases
  where another tool is the better choice.
- **Moving from Confluence** (`docs/from-confluence.md`): the Cloud importer step
  by step, and the route through an HTML export and Markdown for Server and Data
  Center, which the importer does not cover.
- **Moving from Confluence** gains the Server and Data Center route, what the
  operator opens up first, and keeps the HTML export as the way round for a site
  whose API is closed.
- The README opens with what the wiki is and what it takes to run, and says
  plainly what is not there yet.

## [0.5.0] - 2026-09-20

A team can join. Upgrading runs migration `0016_invitations`; nothing changes for
the account that already exists, which stays the administrator.

### Added

- **Members and invitations.** Until now `/setup` was the only way an account
  came into existence, and it closes after the first one. An administrator can
  now invite people from **Members**: an e-mail address and a role give a link,
  shown once, that works once, for seven days. No mail is sent — the
  administrator hands the link over — and the person who opens it chooses their
  own name and password. Roles can be changed and members removed; the last
  administrator can be neither demoted nor removed. Only the hash of a link is
  stored. Migration `0016_invitations`.

## [0.4.0] - 2026-09-20

An answer finds the one who asked, and a question finds the one who should
answer: an inbox for people and agents, and mentions that reach it. Upgrading
runs migrations `0014_inbox_marks` and `0015_mentions`. The MCP server has
thirty tools; an agent host picks the two new ones up on reconnect, and the
onboarding prompt on **Connect an agent** has two new instructions worth
re-copying.

### Added

- **Inbox.** What other people and agents said or decided about things you had
  a hand in: a message in a discussion you opened or spoke in, that discussion
  being resolved, a reply in a comment thread you are in, a comment on a page as
  you left it, and a review of changes that include yours. `/inbox` and an
  unread count in the header for people; `wiki.check_inbox` and
  `wiki.mark_inbox_read` for agents, which makes thirty MCP tools; `GET
  /api/v1/inbox` and `POST /api/v1/inbox/read` beneath both, on `pages:read`.
  Nothing is stored per event: the inbox is read from the discussions, comments
  and reviews themselves, under the caller's current visibility, so it cannot
  outlive what it quotes or show a space the caller has left. The one thing
  stored is a read mark per actor (migration `0014_inbox_marks`). No e-mail, no
  webhooks. The onboarding prompt gains a step telling an agent to check its
  inbox at the start of a session.
- **Mentions.** `@name`, or `@[Name With Spaces]`, in a discussion message or a
  comment brings that person or agent in: it lands in their inbox as its own
  kind, whether or not they were in the thread. Names are matched against the
  workspace's members and live agent tokens when the text is posted, and the
  write answers with `mentioned` — who was reached — so an agent knows when a
  name matched nobody. Names in code are ignored, ten count per text, and a
  mention is never shown to somebody who cannot see the space. The message and
  comment boxes list who can be mentioned. Migration `0015_mentions`.

## [0.3.0] - 2026-09-19

Imports bring their images with them. Upgrading runs migration
`0013_import_images`.

### Added

- A Notion export and a Markdown archive bring their images with them. PNG,
  JPEG, GIF and WebP files that a document shows are judged when the import is
  staged — type from the bytes, `IMAGE_MAX_UPLOAD_MB`, room in the workspace's
  store — and become the page's own images when it is applied. What is not
  carried is a warning on the pages that show it. Migration
  `0013_import_images`.
- A Confluence import downloads the PNG, JPEG, GIF and WebP images attached to
  the pages it reads, and they go the same way. Confluence Cloud serves
  attachments through a redirect to its media host, so image downloads — and
  nothing else — follow up to three redirects: `https` only, public hosts only,
  and the e-mail and API token are sent to the site that was typed and to no
  other host. An image that cannot be fetched stays a link to Confluence, with
  the reason in a warning. Tested against a simulated site, not yet against a
  live one.

### Changed

- An archive import expands only documents and raster images. Videos, PDFs and
  other files in an export no longer count against `IMPORT_MAX_EXPANDED_MB`.

### Fixed

- The link a Confluence import leaves for an attachment it did not carry was
  missing `/wiki` and did not open on a Cloud site.
- A link to an imported page whose file name holds parentheses (`Plan (1).md`)
  is rewritten instead of being cut at the first `)`.

## [0.2.1] - 2026-09-19

No change to the application. This release is about how the MCP server package
reaches npm.

### Changed

- `@clewwiki/mcp-server` is published through npm Trusted Publishing: the
  registry accepts it from this repository's release workflow, proven by the
  workflow's OIDC token, and the repository holds no npm secret. The package is
  packed with pnpm and uploaded with npm, so it carries a provenance attestation.
- Re-running a release job leaves an existing GitHub Release as it is instead of
  failing on it.

### Fixed

- The npm package names its repository, homepage and issue tracker. `0.2.0` was
  published without them, and without a provenance attestation.

## [0.2.0] - 2026-09-19

Working together: several people in one page at once, spaces that only their
members can see, pages that move between spaces, images in pages, and anchors
for Kotlin. Migrations `0010_collab`, `0011_space_members` and `0012_images` are
applied on start; nothing in an existing instance changes until a space is
restricted or an image is uploaded.

### Added

- **Kotlin anchors.** `.kt` and `.kts` files are parsed like Swift and
  TypeScript, so a page can be anchored to a Kotlin class, interface, object,
  enum, function, property, type alias or secondary constructor, and is told
  apart from a line-range anchor the same way. A function is named with its
  parameter names — `Checkout.pay(items)` — which is what separates overloads;
  an extension carries its receiver, `String.slug()`; a companion's members are
  members of the class, `Checkout.create(gateway)`.
- **Image uploads.** Pages take PNG, JPEG, GIF and WebP images: choose a file in
  the editor's **Image** dialog, paste a screenshot, or drop a file into the
  page. Over REST, `POST /api/v1/pages/{id}/images` with the image as the request
  body answers the relative `url` to put in a page body; `GET` on the same path
  lists a page's images, `GET /api/v1/images/{id}` serves one and `DELETE`
  removes it for good (`pages:delete`). Images are stored in the database —
  migration `0012_images` — so they are in the same backup as the pages.
- A page lists the images uploaded into it under **Images**, marks the ones its
  current text no longer shows, and removes one for good, so taking down a
  screenshot that should not have been uploaded needs no API client.
- An image is as visible as its page: hidden with a restricted space, moving
  with the page to another space, gone when the page is deleted. One uploaded
  while writing a new page (`POST /api/v1/spaces/{key}/images`) is visible to its
  uploader alone until their new page refers to it, and is removed after a day
  if none does. The HTML export carries the page's own images inline.
- What an upload is gets decided from its bytes, never from its declared type or
  name, and SVG is not accepted. An image is served as that type only, with
  `nosniff`, a sandboxing Content-Security-Policy and `same-origin` resource
  policy, and is always revalidated. `IMAGE_MAX_UPLOAD_MB` (5, at most 10; `0`
  switches uploads off) and `IMAGE_STORE_MAX_MB` (2048 per workspace) bound it,
  and uploads are rate limited per actor.
- **Moving a page to another space.** **Move** on a page asks for a space and a
  parent in it, and takes the page there with everything below it. Nothing is
  rewritten, so no version is made: history, comments and changes waiting for a
  review travel with the pages, and so do the mover's own claims. Over REST it is
  `POST /api/v1/pages/{id}/move` with `space` and `parent_id` or `parent_path`.
  For the space a page leaves this is a subtree delete, and it is scoped like
  one — a token needs `pages:delete` on top of `pages:write` — and the caller has
  to see both spaces: a target it cannot see is `404 Space not found`. There is
  no MCP tool, as there is none for deleting. A move inside a space is still a
  page update with `parent_id` or `path`.
- A move between spaces is refused with `409 conflict`, and audited as
  `page.move_rejected`, while somebody else holds a live claim anywhere in the
  subtree — a live editing session counts — when the target already has a page at
  one of the paths, when the target is archived, and while the source space
  still uses one of the pages as its home page, its rules or the parent of its
  decisions. A pair of pages that would end up in two spaces is unpaired on both
  sides and reported in `unlinked_page_ids`. Anchors stay on their pages and are
  checked against the target space's repository from then on. A success is
  audited as `page.moved_to_space`.
- **Restricted spaces.** A space can be restricted to its members: to everybody
  else in the workspace it does not exist — not listed, not searched, and every
  link into it answers `404`, exactly as a space in another workspace does.
  Workspace administrators see every space. Membership is about visibility only:
  a member can do in the space what their workspace role lets them do anywhere.
  Migration `0011_space_members` (`spaces.restricted`, `space_members`); existing
  spaces stay open.
- `PATCH /api/v1/spaces/{key}` takes `restricted`, and
  `GET`/`PUT /api/v1/spaces/{key}/members` reads and replaces the member list —
  signed-in workspace administrators only. **Settings → Access** in every space
  does the same from the interface, and a restricted space says so next to its
  name. Changes are audited as `space.members_changed` and in `space.updated`.
- **Editing together.** Several people can be in one page at once, with each
  other's cursors and edits appearing as they are typed. Opening the editor joins
  the page's live session; there is nothing to switch on. The shared document is
  a CRDT (Yjs) bound to the visual editor, and what is stored is still Markdown:
  whoever saves serialises the shared document with the same bridge that keeps
  an agent's page byte for byte, so a block nobody touched is written back as
  the bytes it had — verified over the agent-page corpus through a second
  browser's copy of the document.
- **One claim for the whole session.** A session holds a single claim under an
  identity of its own (`collab:<pageId>`), labelled with who is in it. People in
  the session do not contend with each other; agents contend with the session
  exactly as with any one writer — `wiki.claim` answers `CONFLICT` naming the
  session and its participants — and no part of an agent's protocol changes. A
  save is an ordinary write under that claim, authored by whoever saved, so
  validation, revisions, audit and review see nothing new.
- A session that nobody types in for five minutes, with nothing unsaved, gives
  the page back and pauses; typing resumes it. If the page was written while it
  was paused, the session is reset and everybody is asked to load the page
  again. Text is saved for its author after a minute of quiet, and unsaved text
  survives a restart and the last person leaving (`page_collab_states`,
  migration `0010_collab`): the next person to open the editor finds it.
- The transport is server-sent events plus ordinary `POST`s
  (`GET`/`POST /api/v1/pages/{id}/collab`), not a WebSocket: no second process,
  no second port and no change to a reverse proxy that already passes streamed
  responses. Sessions are for signed-in people; an agent token is refused.
- With somebody else in the session the Markdown tab shows the page and is not
  typed in; alone, it works as before, and what is typed there is written into
  the shared document as a difference. A page the visual editor cannot keep
  byte for byte is still edited as Markdown under an exclusive lease.

### Changed

- The README is a front page again: what clewwiki is, screenshots, a quick start
  and an index. Its reference sections moved, unchanged, to `docs/deploy.md`
  (deployment, reverse proxy, configuration, backups, upgrades),
  `docs/guide.md` (using the wiki) and `docs/api.md` (the REST endpoints).
- `updatePage` accepts `claimActor`: the identity a claim is checked against
  when it is not the author's. Only the live session passes it; no request
  handler does.

### Security

- A person's visibility is computed into the same allowlist a space-limited token
  carries, so every REST handler that already checked a resource's space against
  the caller enforces restricted spaces without having been changed — 27 ways
  into a restricted space are tested to answer `404` to a non-member. Pages and
  server actions look spaces, pages, claims, anchors, comments and discussions up
  through guarded lookups with the session as the viewer, and a test fails the
  build if interface code calls an unguarded one. That includes
  `generateMetadata`: a page title is sent to the browser even when the page
  answers "not found", which is how a restricted discussion's title would
  otherwise have reached somebody who could not open it.
- Live editing sessions in a space are ended when who may see it changes, so a
  stream that was authorised while the space was open does not go on delivering
  its edits to somebody removed from it. Browsers reconnect and are authorised
  again; nothing typed is lost.
- A browser in a session may report its own cursor and nobody else's, and the
  name and colour shown next to a cursor come from the server's participant
  list, never from what another browser says about itself. Messages are taken
  only from a browser that joined, as the person who joined. Updates are bounded
  (1 MB each, 16 MB per session, 24 connections per session, 200 sessions), a
  browser that cannot keep up is disconnected rather than buffered for, and the
  shared document is opaque bytes to the server: it is never parsed into a page
  and never handed to an agent.

### Fixed

- Restoring a deleted page checks that its parent is still in the same space. A
  parent moved to another space can keep the very path it had, which the path
  comparison alone would have accepted.

## [0.1.0] - 2026-09-18

First tagged release. The application, the MCP server and the container
image are published from this tag; earlier commits were development on
`main`.

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
  the MCP surface to twenty-eight tools. The four that return
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
  `wiki.resolve_discussion` — the discussion tools. The two read tools carry the content-is-data notice.
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
- The `/connect` onboarding prompt asks agents to call `wiki.get_rules` and
  `wiki.list_skills` for the space before starting work.
- A "Rules and skills" section in the guide, explaining what each is, when to
  write a skill instead of a page, and how agents get them.

### Changed

- `docker-compose.yml` forwards `DISCUSSION_SWEEP_INTERVAL_SECONDS`,
  `DISCUSSION_MESSAGE_RATE_LIMIT_MAX`, `DISCUSSION_MESSAGE_RATE_LIMIT_WINDOW`,
  `IMPORT_MAX_UPLOAD_MB` and `IMPORT_MAX_EXPANDED_MB` to the container. The
  three discussion settings were documented but never reached it, so a value in
  `.env` had no effect under compose.
- The path and slug generators moved from `apps/web/src/lib/pages` into
  `@clewwiki/content` (`./paths`, `./slug`), so the import pipeline and the
  application produce identical paths from identical titles. The application's
  own modules re-export them, so every existing import site is unchanged.
- `createPage` accepts an optional `id`, used only by the import pipeline: a
  batch of pages that link to each other has to resolve those links before the
  first body is written.
- Page path segments generated from titles transliterate Russian, Ukrainian
  and Belarusian Cyrillic (ICAO Doc 9303), strip Latin diacritics, fall back
  to `page-<hash>` when nothing is left, and are numbered `-2`, `-3`, … on the
  server when the path is taken. A title without Latin letters no longer
  needs a typed segment, and the page form previews the generated path.

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
- A Confluence import only sends requests to the public host it was given. The
  address must not be, or resolve to, a loopback, private, link-local or
  otherwise non-public address; the `next` link of a listing is followed only as
  a path on that origin; redirects are not followed; and a response is read up
  to 64 MB. The address is checked inside the one DNS resolution the socket
  uses, so a name that resolves differently a moment later (DNS rebinding)
  cannot pass the check and land somewhere else. Before this, the server on the
  other end could point the import — and the credential on its requests — at
  any host the instance could reach.
- Import limits are the operator's: `IMPORT_MAX_UPLOAD_MB` (200) and
  `IMPORT_MAX_EXPANDED_MB`, whose default drops from 800 to 256, because what an
  archive expands to is held in memory and a small container was killed rather
  than refused. The upload form states the instance's actual limit.
- The import upload endpoint refuses by the declared `Content-Length` before
  reading the body (`413` over the limit, `411` when absent). The 200 MB limit
  was previously checked only after the whole body had been buffered.
- The Confluence storage-format reader bounds the depth of the tree it builds
  and no longer takes quadratic time on a body of many `<script>` elements.
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

[Unreleased]: https://github.com/Dodecaidr/clewwiki/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Dodecaidr/clewwiki/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Dodecaidr/clewwiki/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Dodecaidr/clewwiki/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Dodecaidr/clewwiki/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Dodecaidr/clewwiki/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Dodecaidr/clewwiki/releases/tag/v0.1.0
