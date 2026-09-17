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

## Phase 3 — Claims and presence — **complete**

Claims implemented as row-level locks, a presence endpoint, ephemeral
agent notes, and the write audit log covering both successful and
conflicting attempts.

**Exit criteria**: two concurrent claim requests on the same page resolve
to exactly one success and one conflict; TTL expiry is covered by a test;
the presence board reflects an active claim live; the audit endpoint
returns both outcomes of a conflict test.

**Status**: met.

- `claims` and `claim_notes` ship in migration `0002_claims`. A claim is a
  lease on a page or on a named section of it, carrying its holder, a
  snapshot of the holder's display name, the page's content hash at the
  moment it was granted, and a deadline.
- Acquiring one runs inside a transaction that holds `select … for update`
  on the *page* row. That is what makes the overlap rule enforceable: a
  page-level claim excludes every section claim on that page and the other
  way round, which two partial unique indexes cannot compare on their own.
  The indexes — one active claim per page when no section is named, one per
  (page, section) otherwise — are the net under the check, not the
  mechanism. An integration test fires two claim requests at one page
  concurrently, twenty times over, and asserts one `201` and one `409`
  every round; a second test does the same for a page claim racing a
  section claim on the same page. Removing the row lock makes the second
  test fail and leaves the first one passing, which is the reason both
  exist.
- A lease past its deadline is *released*, not merely ignored: expiry is
  applied lazily inside whichever transaction needs the answer, and by a
  background sweep (`CLAIM_SWEEP_INTERVAL_SECONDS`, 60 s by default) for
  the leases nobody asked about. So "active" means one thing to the
  service, to the unique indexes and to the presence board alike. TTL
  defaults to ten minutes, is bounded to between one second and one hour,
  and can be set per workspace.
- `PATCH /api/v1/pages/{id}` now requires both halves of the protocol: a
  `claim_id` the caller holds on that page, and a `base_content_hash` that
  still matches. The claim says nobody else may write; the hash proves
  nobody did. Both are checked inside the transaction that holds the page
  row locked.
- `POST /api/v1/pages/{id}/claims`, `PATCH`/`DELETE /api/v1/claims/{id}`,
  `GET /api/v1/claims`, `POST`/`GET /api/v1/pages/{id}/notes` and
  `GET /api/v1/audit` are served by the same service layer the UI renders
  from. `GET /api/v1/pages/{id}` carries the claim and tree nodes carry
  `claimed`.
- The presence board at `/presence` lists every live claim with its holder,
  target, timestamps and notes, refreshed every ten seconds; badges appear
  in the page tree and in the page header. An administrator can
  force-release a claim from there, which is audited under its own action.
- The editor takes a claim when it opens, heartbeats three times per lease
  while the form is open, and releases on save or on leaving. A page held
  by someone else is offered read-only with the holder's name and the time
  they took it.
- Every claim action is workspace-scoped in its SQL predicate,
  scope-checked (`pages:read` for presence and notes, `pages:write` for
  claims, notes and writes) and audited — refusals included, so a conflict
  leaves both a `claim.acquired` and a `claim.rejected` row.

Four deviations from the plan as written. The notes table is
`claim_notes` rather than `agent_notes`: notes are bound to a claim and die
with it, and humans leave them too, so naming them after the claim says
what they are. The per-workspace claim TTL lives in a `settings` JSON
column on `workspaces` rather than in a settings table — it is read with
the workspace row, queried on its own by nothing, and a second knob must
not be a migration; anything that ever needs an index graduates to a
column. And a rejected attempt's audit row is written on its own
connection immediately after the failure rather than inside the
transaction it describes: that transaction is being rolled back, and a row
written inside it would roll back with it. Finally, a section claim
controls who may write rather than which bytes they may write — the server
has no section boundaries to check a body against until anchors land in
Phase 4, so two holders of different sections writing at once are
separated by the content hash, and the second is refused as `stale_base`.
`docs/architecture.md` states that limitation where a reader will meet it.

One behaviour was added rather than deviated from: claiming a target you
already hold extends your lease and returns the same claim instead of
conflicting with yourself. Without it an agent restarted mid-edit could
not get back to its own lease until the TTL ran out. `docs/mcp.md` records
it, along with the one REST condition the MCP tool cannot produce — a
write arriving with no claim at all, answered as `conflict`.

## Phase 4 — Anchoring — **complete**

Anchor creation, anchor checking, and the stale badge in the UI.

**Exit criteria**: an anchor can be created for a page section pointing at
a declaration in a linked repository; checking recomputes and returns
per-anchor state with details; stale, moved-renamed and lost are visible
on the page and counted in the tree; a formatting-only change does not
flag; a body change does; a rename or a move is reported as
moved-renamed; the line-range fallback works for blocks with no
declaration, and its share is exposed.

**Status**: met.

- `packages/anchors` is the mechanism, and it is a library rather than a
  module of the web app: it takes source text in and returns
  declarations, hashes and resolution states, with no dependency on the
  database, on Next.js or on a running instance. Its unit tests are
  fixtures, which is what makes "a reformat is silence, a body edit is
  not" a thing that can be asserted rather than argued about.
- Grammars are loaded as WebAssembly through `web-tree-sitter`. A native
  tree-sitter binding would put a compiler toolchain, Python and
  `node-gyp` into the runtime image and a rebuild into every Node
  upgrade; a `.wasm` file is one file the runtime reads. TypeScript and
  TSX come from the grammar's own package, which publishes WebAssembly
  builds; Swift comes from a prebuilt-WebAssembly distribution, because
  its own package ships C sources only. The image copies all of them into
  one directory and points `CLEWWIKI_GRAMMARS_DIR` at it, the same
  arrangement `CLEWWIKI_MIGRATIONS_DIR` uses for the SQL.
- Identity is `{kind, qualified_name}`; the file is a hint. The hash
  covers the parser's token sequence with comments dropped, so
  re-indenting a function, wrapping its arguments or rewriting its
  documentation comment changes nothing the checker looks at.
- Resolution is a ladder: same file and identity → another file, same
  identity (*moved*) → the same body under a new name in the same
  container (*renamed*) → the same body anywhere (*moved and renamed*) →
  `lost`. The rename stages match on the body's token hash rather than on
  the declaration's full token hash, because the full hash covers the
  name and a rename changes it by definition. A body shorter than eight
  tokens is not matched at all: `{ return nil }` is not evidence, and a
  confident wrong answer is worse than an honest `lost`.
- The line-range fallback exists for blocks with no declaration —
  configuration, prose, a table of constants. It normalises indentation
  and blank lines and hashes what is left. Its share of a workspace's
  anchors rides along on every check response and is shown under the
  anchors panel, because a line range does not survive an edit above it
  and a rising share is the first sign that the badges are becoming
  noise.
- `anchors` ships in migration `0003_anchors`. A workspace's repository is
  a `settings` entry — URL, default ref, and the *name* of an environment
  variable holding the access token. The token itself never enters the
  database, a backup or an API response.
- The server keeps a bare mirror per workspace under `REPOS_DIR`, fetches
  it under a per-workspace lock, and reads blobs with `git show`. It
  never creates a working tree and never runs a build, an install script
  or a hook: repository content is data, the same rule page bodies are
  held to.
- `POST`/`GET /api/v1/pages/{id}/anchors`,
  `GET /api/v1/pages/{id}/anchors/check`,
  `POST /api/v1/anchors/{anchorId}/confirm` and
  `DELETE /api/v1/anchors/{anchorId}` are served by the same service
  layer the UI renders from. `GET /api/v1/pages/{id}` carries `anchors`
  and tree nodes carry `stale_anchor_count`, as `docs/mcp.md` says.
- Every handler is workspace-scoped in its SQL predicate, scope-checked
  (`pages:read` to check, `pages:write` to create, confirm or delete) and
  audited under `anchor.created`, `anchor.checked`, `anchor.confirmed`,
  `anchor.deleted` and `workspace.repository_set`.
- Nothing clears itself. A flag is cleared by `confirm`, which
  re-baselines the anchor onto what is there now and says who did it — a
  badge that disappeared on its own would make the silence of every other
  badge worthless.

Three deviations from the plan as written. The exit criterion in the
original plan was "re-running the Phase 0 spike dataset reproduces the
same FP/FN numbers within tolerance"; that dataset is the history of a
private repository that is not part of this project and cannot be
committed to it, so the criterion was restated as the behavioural one
above — each of the mechanism's promised outcomes is asserted on
fixtures in `packages/anchors` and end to end against a temporary git
repository in the integration suite. Second, the rename stages of the
ladder key on the body-token hash rather than on the full token hash the
plan named: the full hash includes the declaration's name, so it cannot
by construction be what recovers a rename. Third, Kotlin is not in this
phase. Swift and TypeScript are, the pipeline above the grammar is
language-independent, and adding Kotlin is a declaration table plus a
`.wasm` file rather than a change to the mechanism.

A fourth thing is worth stating as a limitation rather than a deviation:
the repository-wide stages of the ladder read at most four thousand
source files per check. Past that ceiling a move out of the indexed
prefix reads as `lost`. That loses recall on very large repositories; it
never invents a match.

## Phase 5 — MCP server

The MCP server over the same service layer as REST, both transports, and
authentication plus CORS/Origin validation on the HTTP transport.

**Exit criteria**: a real MCP client can run the full
claim → write → release sequence end to end; an unauthenticated
streamable HTTP request is rejected by a test.

**Status: complete.**

- `packages/mcp-server` registers the eleven tools of `docs/mcp.md` on the
  official MCP SDK (1.30) and calls the REST API with the agent's token;
  it has no path to the database.
- stdio: an MCP client spawns the built entry point and runs
  get_page → claim → write_page → release_claim end to end; a stale base
  hash surfaces as `STALE_BASE`, a token without `pages:write` as
  `FORBIDDEN`, an unreachable repository as `REPOSITORY_UNAVAILABLE`.
- Streamable HTTP is mounted at `/mcp` inside the web app, stateless, off
  unless `MCP_HTTP_ENABLED=true`. Tests assert `404` while off, `401` with
  no token and with only a session cookie, `403` for an origin not on the
  allowlist, `405` for `GET`, `401` for a revoked token, and a full
  initialize → tools/list for a valid one.
- Invalid tool arguments are refused as `VALIDATION` before any REST call.

Two things differ from the plan. The HTTP transport is stateless rather
than session-based: a route handler is not a long-lived connection, and a
session map held in module memory would exist on one replica and not the
next. And the package is not yet published to npm, so agent hosts run the
built entry point from a checkout; publishing is a release step, not a
code change.

## Phase 6 — Export, packaging, docs — **built, pending the security review gate**

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

**Status: built; not complete.** Everything below is in the repository. The
phase closes when the pre-release security review — run as a separate pass,
not as part of this work — has reported, and every finding it marks as
launch-blocking is fixed. Until then Phase 7 does not start.

- **Image.** `docker/Dockerfile` is two stages on
  `public.ecr.aws/docker/library/node:22-slim`. The build stage installs the
  workspace, compiles the standalone server and gathers the grammar `.wasm`
  files; the runtime stage receives only the standalone output, its static
  assets, the migration SQL, the grammars and the licence files. No pnpm, no
  package store, no source tree and no compiler reach it, and the npm, npx,
  corepack and yarn that ship with the base image are removed, since nothing
  installs packages at run time. git and ca-certificates are the only
  packages added — the anchor checker needs git, and git needs certificates to
  reach an https remote. There is no SSH client: private repositories are
  reached over https with a token named in the workspace settings.
- **Size choices.** `slim` rather than `alpine`: the test suite, CI and every
  development machine run on glibc, and musl would be a second, untested
  platform under the tree-sitter runtime to save a few megabytes. The copy of
  the grammars that Next's trace pulls into the standalone output is dropped
  (it would ship twice), and so is the image optimizer's native library,
  sharp with libvips — tens of megabytes that nothing loads, because nothing renders
  `next/image`. The build-time placeholders for `DATABASE_URL` and
  `BETTER_AUTH_SECRET` are scoped to the one `RUN` that compiles, so they are
  recorded in no image configuration. The size of the final image is written
  to the `docker-smoke` job summary on every run.
- **Runtime hardening.** The process runs as `clewwiki`, UID and GID 1001,
  fixed so a bind mount can be chowned without guessing. The application files
  belong to root; the service user can write only to `/data/repos` and Next's
  cache directory. The image carries a `HEALTHCHECK` that calls
  `/api/v1/health` with Node rather than curl, `STOPSIGNAL SIGTERM`,
  `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1` and OCI labels for
  source, licence (`AGPL-3.0-or-later`), title and description.
- **Compose.** PostgreSQL 16 from the same mirror, with a healthcheck and a
  named volume, not published to the host; the app waits for it to be healthy,
  keeps repository mirrors on a second named volume, and is published on
  `127.0.0.1:3000` by default. `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET` and
  `BETTER_AUTH_URL` have no defaults: compose refuses to start and names the
  missing one. There is no bundled proxy — shipping none is the default rather
  than a separate compose profile, and the README carries the Caddy, Traefik
  and nginx configurations. Compose now passes the MCP-over-HTTP, migration
  and claim-sweep settings through to the app; before, setting
  `MCP_HTTP_ENABLED` in `.env` had no effect in a compose deployment. Two
  variables nothing reads, `APP_BASE_URL` and `LOG_LEVEL`, were removed from
  the compose file, `.env.example` and the README.
- **The database password is generated as hex.** compose places it inside the
  connection URL, and the `/`, `+` and `=` that `openssl rand -base64` produces
  break URL parsing. The README and `.env.example` previously recommended
  base64 for it.
- **Continuous verification.** A `docker-smoke` CI job builds the image with
  `docker compose up -d --build --wait`, then `scripts/smoke-test.mjs` walks
  the first-run path over plain HTTP: the health endpoint, the `/setup` form
  and its 404 afterwards, the login form, the agent-token form, `/api/v1/me`,
  create → claim → write → release, Markdown and HTML export, and MCP
  `initialize` plus `tools/list` returning eleven tools. The forms are
  submitted the way a browser without JavaScript submits them — the hidden
  server-action fields React rendered are sent back with the visible ones —
  so no test-only endpoint and no seeded account exist. The job then checks
  that the container runs as a non-root user, that git, the grammars and the
  migrations are present and npm is not, that neither generated secret appears
  in the image history or configuration, and that compose refuses to start
  with no `.env` at all. Every job in the workflow runs with
  `contents: read`, and every third-party action is pinned to a commit SHA.
- **README.** The Deploy section runs in order on a clean Linux server:
  prerequisites, clone, `.env` with a generated value for each secret,
  `docker compose up -d`, creating the administrator over an SSH tunnel before
  the instance is reachable, the reverse proxy, the first agent token, and
  connecting an agent over MCP; followed by the security checklist, the
  configuration reference, backup and restore commands for both volumes,
  upgrading and uninstalling.

**PDF export: deferred.** The plan made PDF conditional on measuring what it
adds to the image. Rendering Mermaid diagrams into a PDF needs a headless
browser, and the published sizes settle the question without a build:

| Headless browser path | Published size |
|---|---|
| Debian bookworm `chromium` package (152.0.7977.82, amd64) | 77 MB download, 282 MB installed |
| … plus its `chromium-common` dependency | 29 MB download, 65 MB installed |
| Playwright 1.63 Chromium (Chrome for Testing 153.0.8010.12, linux64) | 196 MB zip |
| … plus Chrome Headless Shell, which Playwright installs by default | 120 MB zip |

That is roughly 350 MB installed for the Debian route before the X11, GTK,
font and sound libraries a slim base does not have — against a
`node:22-slim` base whose compressed amd64 layers total 80 MB. It would
multiply the image several times over for one convenience, and put a
full browser, with its own patch cadence, into the process that holds the
database credentials. So Markdown and HTML are the supported export formats.
The HTML export carries its own print stylesheet, and printing it to PDF from
any browser is the documented path. The export contract is unchanged:
`format` accepts `md` and `html`, and a `pdf` value can be added later without
breaking a caller, if a renderer that does not need a browser in the image
turns up.

**Exit criteria status.** Markdown and HTML export open without error: the
unit tests assert a standalone document with its print stylesheet, and the
smoke test fetches both from the running container. PDF is deferred without
changing the export contract. `docker compose up` on a clean machine bringing
up a working instance from the README alone is exercised by `docker-smoke` on
every push; its first green run on CI is part of closing this phase, along
with the security review.

## Phase 7 — Launch

Public launch of the repository.

**Exit criteria**: the repository is public with a complete README,
license, and documentation set; the Phase 6 security review pass is
complete.
