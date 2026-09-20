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

**Kotlin — added since.** It was what that paragraph said it would be: one
table in `declarations.ts` and the grammar from
`@tree-sitter-grammars/tree-sitter-kotlin`, which ships a prebuilt `.wasm`, with
nothing above the grammar touched. Three choices are Kotlin's own. A function's
identity carries its parameter *names* — `pay(items)` — because overloads are
everyday Kotlin and a name is one token where a type can be a line of generics;
two overloads that differ only by type share an identity. An extension carries
its receiver, `String.slug()`, since the same name on different receivers is
the normal case. And a companion object is looked through, so its members are
`Checkout.create(gateway)`, the way Kotlin code reaches them.
The grammar's package lists an update-checking tool among its runtime
dependencies; nothing here uses it, and an override leaves it out of the
install, as its native build is left out by `ignoredBuiltDependencies`.

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
launch-blocking is fixed. The review has reported and its findings are
addressed as recorded under *Security review* below; the phase closes with the
first green `docker-smoke` run on CI. Until then Phase 7 does not start.

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
  a space created through the space form, create → claim → write → release in
  it, Markdown and HTML export, the space ZIP export, and MCP `initialize` plus
  `tools/list` returning twelve tools. The forms are
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

**Security review.** The pre-release review against every control in
`docs/security.md` has reported. It found no critical issue, two high, eight
medium and twelve low. `docs/security.md` now states, control by control, what
is implemented.

Fixed:

- *Password sign-in was not rate limited.* The login form's server action
  called the authentication library directly and bypassed its HTTP limiter.
  Sign-in is now limited per account and per client address inside the action,
  answered like a wrong password, and audited (`auth.login_failed`,
  `auth.login_rate_limited`). The client address comes only from
  `TRUSTED_CLIENT_IP_HEADER` (`X-Real-IP` by default), which the documented
  proxies overwrite; the library's limiter reads the same header.
- *The repository token setting could name any environment variable* and send
  its value to any URL, so a workspace administrator could read the session
  secret or the database URL. The name is now restricted to
  `CLEWWIKI_GIT_TOKEN` / `CLEWWIKI_GIT_TOKEN_<NAME>` on save and on read, the
  credential goes only to the `https://` origin of the repository, and
  **Test connection** is audited. In the same pass, repository URLs with
  embedded credentials, `git://`, `ext::` or a leading `-` are refused, and
  `file://` needs `ALLOW_FILE_REPOSITORIES=true`.
- *Public self-registration* through the authentication library's sign-up
  route is disabled; `/setup` still creates the first account server-side, and
  every later account comes from an invitation (see Members).
- *First-run setup was first come, first served.* It now requires a one-time
  setup token, configured or generated at start-up and printed to the log.
  A setup that fails after the account is created removes the account again.
- *Any `pages:write` token could delete a whole subtree*, releasing other
  actors' claims, with no way back but SQL. Deleting needs the new
  `pages:delete` scope, is refused while another actor holds a live claim in
  the subtree unless the caller is an administrator, and administrators can
  restore a deleted subtree over REST.
- *The content-as-data statement covered three tools.* It now covers every tool
  whose result carries text written by others, and git's error output no longer
  reaches API responses or tool results.
- *Amplification.* `/mcp` refuses batches of more than ten messages; refusals
  of a known token are audited at most once per token per ten seconds.
- *Anchor checks had no resource budget and ran on a `GET` with `pages:read`.*
  A check now has a file, byte and time budget with an explicit partial
  result, oversized files are skipped before reading, and recomputing is a
  `POST` needing `pages:write`; `GET` returns the stored states. (This changes
  the Phase 4 and Phase 5 contracts: `wiki.check_anchors` now needs
  `pages:write`.)
- *Cookie-authenticated REST writes relied on `SameSite=Lax` alone.* They now
  need the instance's origin and a JSON content type.
- *CI.* The dependency audit is blocking, after an override moved `lodash-es`
  (a transitive dependency of the diagram renderer) to a patched release.
- *Smaller items.* The token form keeps "no expiry" as a deliberate last
  choice, and the stdio MCP server refuses to send a token to a plain `http://`
  instance that is not on loopback unless told to.

Accepted for v1, with the reasoning:

- *Unknown or wrong-secret tokens are not audited or limited per address.*
  Secrets are 256 bits, so guessing is not a threat; such a request has no
  workspace to attribute a row to, and a per-address limiter for failed
  lookups is a later hardening step.
- *Rate limits are per process, and a `/mcp` tool call counts against the token
  once per REST call it makes.* A single-container deployment is the supported
  shape; both effects are documented.
- *Search on the UI page does not cap the query length, and snippets are
  computed over full bodies.* Only signed-in members reach it, the page asks for
  at most twenty-five results, and the REST endpoint already caps the query.
- *The HTML export does not carry its own Content-Security-Policy*, so opening
  a file that embeds remote images contacts those hosts. No script path exists
  in the sanitised output; exports are opened deliberately by their reader.
- *No cap on how many claims one actor holds.* Claims expire, and an
  administrator can force-release them.
- *Compose does not drop capabilities or mount the root filesystem read-only,
  and the app and migrator share one database role.* The image already runs as
  a non-root user with read-only application files; the remaining hardening
  is deployment-specific and left to operators.
- *A moderate advisory in the build tool of the migration generator* affects a
  development server that clewwiki never runs, and no fixed release of that
  tool exists yet.
- *The queue of anchor checks waiting for one workspace's repository lock is
  unbounded.* Each queued check is bounded by its own budget and by the
  per-token rate limit.
- *No automated anomaly detection on the audit log.* The signal is recorded and
  documented; alerting is outside a single-team self-hosted instance's scope
  for v1.

**Exit criteria status.** Markdown and HTML export open without error: the
unit tests assert a standalone document with its print stylesheet, and the
smoke test fetches both from the running container. PDF is deferred without
changing the export contract. `docker compose up` on a clean machine bringing
up a working instance from the README alone is exercised by `docker-smoke` on
every push; its first green run on CI is part of closing this phase, along
with the security review.

## Spaces — **complete**

Confluence-style areas per project: a workspace holds spaces, a space holds a
page tree, top-level pages act as sections.

**Exit criteria**: an existing database migrates with its pages, history,
claims, anchors and repository setting intact; the same path can exist in two
spaces and not twice in one; a token limited to one space gets `404` for pages,
claims, anchors and exports in another and sees only its space in listings,
search and presence; anchors are checked against the repository of their
page's space; agents can list spaces over MCP and pass a space to search, the
tree, presence and path lookups; old page URLs keep working.

**Status**: met.

- `spaces` and `agent_tokens.space_ids` ship in migration `0004_spaces`, which
  also moves existing data: a `MAIN` space per workspace that had pages or a
  repository, every page assigned to it, path uniqueness moved from
  `(workspace_id, path)` to `(space_id, path)`, and the repository setting
  copied onto the space and removed from the workspace. There is no fallback
  read of the old location — the migration is the transition. An integration
  test applies `0000`–`0003`, seeds a tree, a deleted page, a revision, a live
  claim with a note, an anchor, a pair, a token and a workspace repository, then
  applies `0004` and checks each of them.
- REST: `GET`/`POST /api/v1/spaces`, `GET`/`PATCH /api/v1/spaces/{key}`,
  `POST /api/v1/spaces/{key}/archive` and `…/unarchive`, and
  `GET /api/v1/spaces/{key}/export` (a ZIP of Markdown files mirroring the
  tree, written by a small stored-entry ZIP writer rather than a new
  dependency). `POST /api/v1/pages` requires `space`; `GET /api/v1/pages`,
  search and presence take it; a path lookup needs it. Pages, hits, tree nodes
  and claims carry `space: {key, name}`; `/api/v1/me` carries `space_access`.
- MCP: `wiki.list_spaces` is the twelfth tool; `wiki.search`,
  `wiki.list_pages` and `wiki.get_presence` take `space`, and `wiki.get_page`
  by path requires it. The onboarding prompt on `/connect` tells an agent to
  list spaces first and work inside its project's space.
- UI: the home page lists spaces; each space has an overview (its home page, or
  its description and recent changes), its page tree, "New page" with a parent
  picker and a preview of the resulting path, "Add child page" on every page,
  breadcrumbs, and settings for administrators — name, description, icon, home
  page, repository, archive. Old `/pages/{id}` URLs redirect. Presence and
  search filter by space. The token form offers "All spaces" or a selection.

Three decisions worth recording. Roles stay workspace-wide: an editor edits in
every space, and only agent tokens can be limited to spaces — per-space
permissions for people are the next step. A token limited to some spaces cannot
read the audit log, because the log is workspace-wide and would describe the
other spaces. And archiving hides a space and stops new pages in it but does
not freeze existing pages; a read-only archive is a later refinement if it is
wanted.

**Restricted spaces — built.** A space can be restricted to its members; to
everybody else it does not exist (`404` everywhere), and workspace
administrators see all. `spaces.restricted` and `space_members` (migration
`0011_space_members`), `GET`/`PUT /api/v1/spaces/{key}/members`, **Settings →
Access**. REST enforces it through the allowlist handlers already checked for
space-limited tokens; the interface through guarded lookups, with a test that
fails when one is bypassed.

**Moving pages between spaces — built.** `POST /api/v1/pages/{id}/move` and
**Move** on a page take a subtree to another space the caller can see. It
follows the rules of a subtree delete rather than of a write — `pages:delete`,
no claim of its own, refused under anybody else's live claim — writes no
revision, carries comments and reviews along, breaks a pair it would split, and
refuses a page the source space still designates as its home, rules or
decisions page. No administrator override: a move under a writer would answer
them `404` in the middle of an edit.

**Image uploads — built.** PNG, JPEG, GIF and WebP, from the editor's Image
dialog, a pasted screenshot or a dropped file, and over REST. Stored in the
database (migration `0012_images`, `page_images`), so one backup still restores a
wiki whole and the container keeps its read-only filesystem; bounded per image,
per workspace and per actor. An image belongs to a page and is exactly as
visible as the page, which is what makes restricted spaces and moves between
spaces need no special case. The HTML export carries the page's own images
inline, since it has to open from disk. A page lists its images under
**Images**, marks the ones its current text no longer shows, and removes one
for good — the screenshot that should not have been uploaded is a person's
problem, not an API client's. Not built: an MCP tool (agents have Mermaid and
chart blocks, and REST) and re-encoding to strip metadata. Images in imports
came later; see Documentation import.

**Deliberately not yet: roles inside a space** (viewer, editor, admin). Membership
of a space is visibility only. A read-only role exists for the *workspace* — see
Members — and a role that differs from space to space is the step after it, if
it is wanted.

## Documentation import — **complete**

Bringing existing documentation in, so a team's first hour with clewwiki is not
retyping what it already wrote. Four sources: a Confluence Cloud space, a Notion
"Export as Markdown & CSV" ZIP, a ZIP of Markdown files, and a PDF.

**Exit criteria**: each source produces a page tree with the structure it had,
in the Markdown this project renders; nothing a converter cannot carry across is
dropped silently; an import is reviewed by a person before any page exists; a
path that is taken and a page somebody is holding are never overwritten by
accident; Confluence credentials are used once and stored nowhere; every created
page is audited; and the Confluence API is mocked in tests.

**Status**: met.

- `packages/import` is the pipeline, pure and framework-free: source adapters
  produce a normalised tree, converters emit GFM with callouts as GitHub alerts,
  a placement step assigns paths with the application's own slug generator, and
  a link rewriter resolves intra-import links. `pages/paths.ts` and
  `pages/slug.ts` moved into `@clewwiki/content` so both sides call one
  generator; `apps/web` re-exports them from the paths it always used.
- Migration `0006_imports` adds `imports` and `import_items`. An import stops at
  `needs_review` and writes nothing to `pages` until `POST
  /api/v1/imports/{id}/apply`.
- REST: `POST` and `GET /api/v1/spaces/{key}/imports`, `GET` and `DELETE
  /api/v1/imports/{id}`, `PATCH /api/v1/imports/{id}/items/{itemId}`, `POST
  /api/v1/imports/{id}/apply` and `…/cancel`. Administrators and editors, human
  session only.
- UI: `/spaces/{KEY}/import` chooses a source and takes its input; the run page
  shows the tree with editable target paths, per-item warnings, conflicts and
  claim holders, checkboxes to leave items out, and the result afterwards —
  every page created with a link, everything skipped with the reason. Entry
  points on the space overview and in space settings, in both languages.
- `unpdf` 1.8.1 is the one new runtime dependency, pinned exactly.

Four decisions worth recording. **Staging rather than writing**: every source
produces a guess about structure, a PDF most of all, and the first reading of a
guess must not be after five hundred pages exist. **Nothing dropped silently**:
an unsupported Confluence macro becomes a visible note naming it, and every
lossy conversion attaches a typed warning to its page. **No uploads** — at
first: an imported image kept pointing at the system it came from and said so,
because an attachment store is a different threat surface and belonged to its
own decision. That decision was image uploads, and imports followed it (below).
**Agent tokens cannot import**: the human review is the safety property, and a
token cannot perform it.

**Images carried across — built (0.3.0).** A Notion export and a Markdown
archive bring the PNG, JPEG, GIF and WebP files their documents show; a
Confluence import downloads the ones attached to the pages it reads. They are
judged when the import is *staged* — type from the bytes, the instance's size
limit, room in the workspace's store — so what will not be carried is a warning
the reviewer reads before applying, not a broken picture found afterwards. What
passes waits in the database (`import_images`, migration `0013_import_images`)
and becomes the page's own image when the page is written, one copy per page,
because an image is exactly as visible as its page. Confluence Cloud serves
attachments through a redirect to its media host, so image downloads — and no
other request — follow redirects: three at most, `https` and public hosts only,
and the credential goes to the origin that was typed and to no other host. That
path is tested against a simulated site and **not yet against a live one**.

**Next, if it is wanted**: Confluence Server/Data Center, whose API is v1 and is
untested here; images inside a PDF, which are not extracted; and optical
character recognition for scanned PDFs, which today are refused outright.

## Agent discussions and durable decisions — **complete**

Somewhere for agents working in parallel to talk to each other about
cross-cutting work — "I am changing the auth contract, does anything of yours
depend on it?" — without that chatter becoming permanent clutter in the wiki
everything else is read out of.

**Exit criteria**: the conversation is ephemeral and is cleaned up; the outcome
is promoted to an ordinary page and kept; both are auditable; agents reach all
of it over MCP and people over the web; the server never writes a decision
nobody typed; and deleting a thread can never take its decision page with it.

**Status**: met.

- Migration `0007_discussions` adds `discussions` and `discussion_messages`.
  `expires_at` is a single `not null` deadline meaning "when this thread is next
  acted on" — closed for inactivity while open, deleted once resolved — so the
  sweep is one indexed scan and the interface can always name the date.
- Lifecycle: an open thread with no activity for `discussion_idle_days` (14) is
  closed automatically with no decision; a resolved thread and its messages are
  deleted `discussion_retention_days` (7) after resolution. Both are per space,
  clamped to 1–365. A periodic sweep in `instrumentation.ts` follows the claims
  sweep exactly (`DISCUSSION_SWEEP_INTERVAL_SECONDS`, default 300, `0` to turn
  it off), and expiry is applied lazily on every read as well.
- Resolving requires a decision and writes a **decision page**: one page per
  decision, titled from the thread, under the space's `decisions_page_id` or a
  `/decisions` page created on first use, with an ADR-shaped body and a footer
  naming the participants and the dates. It is an ordinary page from that moment
  — versioned, searchable, exportable, linkable.
- REST: `GET` and `POST /api/v1/spaces/{key}/discussions`, `GET` and `DELETE
  /api/v1/discussions/{id}`, `POST /api/v1/discussions/{id}/messages`, `POST
  /api/v1/discussions/{id}/resolve`. `pages:read` to read, `pages:write` to
  write; deletion additionally requires an administrator or the opener.
- MCP gains five tools — `wiki.list_discussions`, `wiki.get_discussion`,
  `wiki.open_discussion`, `wiki.post_discussion_message`,
  `wiki.resolve_discussion` — bringing the surface to twenty-two. Their
  descriptions teach the protocol, not just the signature: look before starting
  cross-cutting work, open a thread instead of guessing, always resolve with a
  decision.
- UI: `/spaces/{KEY}/discussions` and `/spaces/{KEY}/discussions/{id}`, an
  "Open a discussion" entry point on the space overview and a prefilled one on
  every page, a count of open threads in the space sidebar, and the retention
  settings in space settings. Both languages. No real-time updates — a
  discussion moves at the speed of the work it is about, and the thread says
  plainly that a reload is how new messages arrive.

Three decisions worth recording. **The chat is deleted on purpose**: the value
of this wiki is that an agent can read it and act without asking, and a space
carrying last quarter's half-finished threads costs every reader the work of
deciding which were ever settled. **The server never summarises a thread**: a
decision page invented out of a conversation the writer did not take part in is
a plausible, wrong record that the next agent will believe, so the four ADR
blocks are the caller's own prose and `buildDecisionPageBody` is a pure function
that only arranges them. **No new scope**: a discussion is content of the space,
and a `discussions:read` scope would have forced every operator to re-issue
every token before an agent could talk about pages it may already rewrite.

**Next, if it is wanted**: searching across open discussions, which today is a
listing per space. Notifying an agent that somebody answered its thread was the
other item here; it is the inbox, below.

## Review after agents — **built**

Agents write without asking, so a person needs to see afterwards what was done
and be able to undo it.

- The baseline of a page is the newest version a person wrote or accepted; agent
  revisions after it are pending. Derived from `page_revisions` and the new
  `page_reviews` table (migration `0008_reviews`), never stored as a flag.
- `@clewwiki/content/diff`: a bounded Myers line diff with changed words marked
  inside rewritten lines.
- REST: `GET /api/v1/spaces/{key}/reviews`, `GET /api/v1/spaces/{key}/changes`,
  `GET /api/v1/pages/{id}/versions/{version}`, `GET /api/v1/pages/{id}/diff`,
  `GET` and `POST /api/v1/pages/{id}/review`. Reads need `pages:read`; deciding
  is for signed-in people only.
- Accept records the decision; revert writes the baseline back as a new version
  under a claim. Both refuse a stale version, both take a note agents can read.
- UI: **Changes** in every space's sidebar with a count, a "Needs review" queue,
  an "All changes" feed, a banner on a pending page, a version history and a
  comparison view for any two versions. Both languages.

Two decisions worth recording. **The review is after the write, not before it**:
a queue in front of the write would make agents as slow as their approver, and
claims already prevent lost updates. **A review covers a range of versions, not
one revision**: what a person compares is the page as they last knew it with the
page as it stands, however many times an agent wrote in between.

**Comments on paragraphs — built.** `page_comments` (migration `0009_comments`),
anchored by a fingerprint of the paragraph's text: a comment follows its
paragraph through edits elsewhere and is reported as outdated once the paragraph
is rewritten, never re-attached to something similar. REST under
`/api/v1/pages/{id}/comments`, `/api/v1/comments/{id}` and
`/api/v1/spaces/{key}/comments`; a gutter of comment buttons on every page and
the threads beneath it. A person may resolve any thread, an agent only an
agent's.

**MCP — built.** `wiki.list_changes`, `wiki.get_review`, `wiki.diff_page`,
`wiki.list_comments`, `wiki.post_comment`, `wiki.resolve_comment`, bringing the
surface to twenty-eight (thirty since the inbox), and two steps in the onboarding prompt, so the feedback
reaches the agent without anybody pasting it.

**Next, if it is wanted**: comments on a selection inside a paragraph rather than
the whole of it. Telling a reviewer that an agent answered is the inbox, below.

## Members — **built**

Until this, `/setup` was the only way an account came into existence — and it
closes after the first one. A wiki for a team had no way to let the team in,
while restricted spaces, live co-editing and mentions all assumed more than one
person. **Members** closes that: an administrator invites by e-mail address and
role and gets a one-time link to hand over (no mail is sent, deliberately); the
person who opens it chooses a name and a password and is signed in. Roles can be
changed and members removed, and a workspace can never be left without an
administrator. `invitations`, migration `0016_invitations`; the security notes
say what the link is and is not.

**Accounts — built.** Members left two things open, and both were found by
using it: nobody could change their own name or password, and a lost password
meant removing the person and inviting them again — a new account, so their
space memberships, their inbox and every mention of them went with the old one.
**Your account** (behind your name in the header) changes the name, and the
password against the current one, signing every other session out. A forgotten
password is an administrator's **Reset link** on Members: the invitation
mechanism again — shown once, hashed, good once — for 24 hours, setting the
password and ending the account's sessions. `password_resets`, migration
`0017_password_resets`. The last administrator's own lost password is the
operator's to recover from the database; `docs/deploy.md` says how.

**A read-only role — built.** A team is not only the people who write. A
**viewer** reads everything they can see — pages, discussions, comments,
history, search, exports — and has an inbox and an account, and changes nothing.
It is enforced where a read-only token already was: a person's role stands in
for a scope list in `requireScopes`, so a viewer has `identity:read` and
`pages:read` and no list of "write endpoints" exists to fall out of date; server
actions ask for the session through `getWriterSession`. Two tests keep it true:
one finds every writing REST route on disk and calls it as a viewer, the other
fails on a server action that takes the plain session. Migration
`0018_viewer_role` adds the enum value. The known cost: a viewer can be
mentioned and cannot answer. That is what read-only means, and the way out is
the editor role — a "may comment" role in between is the next step if it is
wanted.

**Deliberately not built**: self-service "forgot password" (there is nowhere to
send the proof), self-registration, SSO. **Next, if it is wanted**: a role that
reads and comments; a supported way back in for an instance whose only account
is locked out.

## Inbox — **built**

Two sections above ended on the same sentence: the answer exists, and the one
who asked has no way to find out. An agent that opened a discussion had to list
every space's threads to learn it had been answered; a reviewer had to reopen
every page to learn an agent had replied. That is the delivery channel, and it
is pull, not push: `/inbox` and a count in the header for people,
`wiki.check_inbox` and `wiki.mark_inbox_read` for agents (thirty tools), `GET
/api/v1/inbox` and `POST /api/v1/inbox/read` beneath both.

**It is a query, not a table of notifications.** What an actor should hear about
— a message in a discussion they opened or spoke in, that discussion being
resolved, a reply in a comment thread they are in, a comment on a page as they
left it, a review of changes that include theirs — is already in the tables
those things live in. Reading it from there, when asked, under the caller's
current `spaceIds`, means there is no copy to go stale: discussions are
ephemeral and their notifications would have outlived them; membership of a
restricted space changes and a stored title would have stayed readable. The one
thing stored is a read mark per actor (`inbox_marks`, migration
`0014_inbox_marks`) — a single timestamp, because "everything up to here" is
what a person clicking **Mark all read** and an agent finishing a turn both
mean. It goes back 30 days; an actor with no mark is treated as having read
everything older than 14.

**Mentions — built.** The inbox reached people already in a thread; a mention
reaches somebody who is not. `@name` or `@[Name With Spaces]` in a discussion
message or a comment is resolved, when it is posted, against the workspace's
members and live tokens, stored (`mentions`, migration `0015_mentions`) and
shown in the inbox as its own kind. It is the one inbox item that is stored
rather than derived — who a name meant cannot be recomputed later — and it keeps
the inbox's rules anyway: the row dies with its message or comment, and the
reader's visibility is applied when it is read. The write answers with who was
reached, so an agent can tell that a name missed. No new tool: the three tools
that post text describe the syntax.

**Deliberately not built**: e-mail, webhooks, or any push. A self-hosted
instance has no mail server it can be assumed to reach, and an outbound channel
is a surface of its own; an agent has no address to push to at all. **Next, if
it is wanted**: a webhook per token for hosts that can receive one, and
per-thread muting.

## Editing together — **built**

Several people in one page at once, with cursors, over a CRDT (Yjs) bound to the
visual editor.

- A room holds **one claim** for everybody in it (`collab:<pageId>`), so agents
  see a single writer and their protocol does not change.
- The server relays and stores the shared document as opaque bytes; the browser
  that saves serialises it to Markdown through the ordinary write path. Unchanged
  blocks keep their bytes, verified over the agent-page corpus through a second
  browser's copy.
- Server-sent events and `POST`s, not a WebSocket: no second process or port.
- Idle sessions give the page back; unsaved text is persisted
  (`page_collab_states`, migration `0010_collab`) and survives a restart.

**Known limits.** One application process per instance. With somebody else in
the session the Markdown tab is read-only. Title, parent, kind and summary are
ordinary form fields, not shared: whoever saves the form sets them.

**Next, if it is wanted**: carrying updates between processes with
`LISTEN`/`NOTIFY`; shared form fields; following another person's cursor.

## Phase 7 — Launch

Public launch of the repository.

**Exit criteria**: the repository is public with a complete README,
license, and documentation set; the Phase 6 security review pass is
complete.

**Release checklist**, in order:

- [ ] UI design pass.
- [x] Community files done: `SECURITY.md`, `CONTRIBUTING.md`,
      `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, issue and pull request
      templates.
- [x] Release workflow done: `.github/workflows/release.yml` builds and
      publishes the container image to GHCR, publishes
      `@clewwiki/mcp-server` to npm, and creates the GitHub Release, all on
      a `v*.*.*` tag push.
- [x] The `npm` job publishes through npm Trusted Publishing: the owner
      registered this repository's `release.yml` as the package's trusted
      publisher on npmjs.com, so there is no npm secret in the repository. The
      first version had to be published with a token, because a publisher can
      only be attached to a package that exists.
- [x] Owner sets the `ghcr.io/dodecaidr/clewwiki` package to public after
      the first successful push from the release workflow — a newly
      created GHCR package defaults to private, and `docker compose pull`
      against a private package fails for anyone without registry access.
- [x] Tag `v0.1.0`.
- [ ] Verify `docker compose pull && docker compose up -d` and `npx -y
      @clewwiki/mcp-server` both work from a clean machine, against the
      just-published image and package — not a local build. The `Install
      check` workflow does exactly this on a clean runner, on every release and
      weekly; the box is ticked by its first green run.
- [x] A README that opens with what people look for — a self-hosted wiki with
      MCP built in, one edition, PostgreSQL only — and a comparison page and a
      Confluence migration page to link to.
- [ ] Listings: the open-source-alternative and MCP server directories.
- [ ] Launch posts.

**What the launch is for.** Everything up to here was built on what its author
needed. The launch is how that gets tested against people who are not him, and
what comes back decides the order below. **Next, if it is wanted**, by what
people moving off other wikis ask for: an importer proven against Confluence
Server and Data Center, whose end of life in March 2029 is why many of them are
moving; single sign-on (OIDC first); an interface in German.
