# Security

clewwiki is built for an operator running it themselves, typically
without a dedicated security team and often without prior reverse-proxy
experience. The threat model below treats that as the normal deployment
case, not an edge case.

## Threat model

| Actor | Vector | Impact | Primary control |
|---|---|---|---|
| A looping or buggy agent (not malicious — a retry storm, duplicate claim requests, a runaway script) | A burst of `claim`/`write` calls from one token in a short window | Database exhaustion, aggressive re-claiming that starves other writers once a TTL lapses | Per-token rate limiting, short default claim TTL, an audit log and version history to reconstruct and roll back after the fact |
| A leaked agent token (committed to a public repo, left in CI logs, taken from a compromised developer machine) | The token is used by a third party to read or write under the legitimate agent's identity until revoked | Confidential content exposed; malicious content written under a trusted identity | Scoped tokens (not full workspace access by default), TTL with expected rotation, explicit revocation, workspace binding, and audit-log anomaly detection (a sudden burst from a normally quiet token) |
| Malicious page content (written by a compromised agent, an untrusted collaborator, or pulled in from an external source) | Another agent reads the page and interprets embedded text as an instruction rather than data | Escalation to a further malicious write or exfiltration, if the reading agent holds other active claims or has outside tool access | Page content is always returned as data with separate provenance metadata, never as instructions; this is a documented response-shape contract, not something the server can force a calling agent to respect |
| A network attacker, or an instance accidentally exposed without TLS, or a browser-based MCP client vulnerable to DNS rebinding | Unauthenticated access to REST/MCP, traffic interception, token theft over plaintext | Full workspace compromise up to the exposed role's privileges | The streamable HTTP MCP transport requires authentication on every request with no anonymous endpoint; CORS/Origin allowlisting defaults to empty; TLS termination is the operator's responsibility, documented explicitly rather than silently assumed |
| A compromised dependency, or a secret accidentally committed to the product repository | Supply-chain compromise via a vulnerable dependency update, or a leaked credential in git history | Compromise of every instance that updates to the vulnerable version, or exposure of one operator's credentials | Dependency and secret scanning in CI on every change; secrets are environment-only, and `.env.example` ships with keys and no values |

## Controls

Each control below states what the code does today. Where a control is only
partly in place, the gap is named rather than implied away.

- **Scoped tokens.** Agent tokens carry a list of `resource:action` scopes —
  `identity:read`, `pages:read`, `pages:write`, `pages:delete`, `audit:read` —
  checked per endpoint at the authentication layer (`lib/scopes.ts`,
  `requireScopes`). There is no token role: anything that needs a role
  (force-releasing a claim, restoring a deleted page, creating, changing or
  archiving a space and its repository settings, token issuance) is reserved to
  a human administrator, and no scope set
  reaches it. Deleting a page needs `pages:delete` on top of `pages:write`,
  because one call removes a subtree; moving a page to another space needs the
  same, because for the space it leaves that is what it is.
- **Token TTL.** Tokens past `expires_at` are rejected at the authentication
  layer, before any handler runs. The token form preselects a 30-day lifetime;
  "no expiry" is still available, as the last choice, and has to be picked
  deliberately.
- **Token revocation.** Revoking a token invalidates it for the next request.
  There is no token cache.
- **Token secrecy.** Only a SHA-256 digest of the 256-bit secret is stored, and
  it is compared in constant time. A bearer header is never allowed to fall
  back to a session cookie.
- **Workspace binding.** Every query carries the caller's workspace in its SQL
  predicate, and handlers additionally compare the resource's workspace with
  the caller's where they read a row some other way; a mismatch answers `404`.
- **Space restriction for tokens.** An agent token can be limited to some of
  the workspace's spaces (`agent_tokens.space_ids`; `null` means every space,
  which is what tokens issued before spaces have). Every handler that reaches a
  page, a claim, a note, an anchor, an export, search or presence checks the
  space of the resource next to the workspace check — for a claim or an anchor,
  the space of the page it is on — and answers `404` outside the list, the same
  answer as another workspace. A `space` parameter naming a space outside the
  list is `404` too, and lists, the tree, search and presence are filtered by
  the list in their queries. Pages cannot be paired across spaces, so a pairing
  never reaches into a space the caller cannot see. A page moves to another
  space only when the caller can see both, and an unseen target is `404`; its
  comments and reviews change space in the same transaction, since their
  visibility is decided on their own `space_id`, and a pair the move would
  split is broken rather than left spanning two spaces. The audit log covers every
  space, so a restricted token cannot read it at all, whatever its scopes.
  Issuing a restricted token requires at least one space of the same
  workspace. A space created later is not added to an existing restriction.
  People are not restricted: roles are workspace-wide in this version. A
  space's rules page and its skills are on the same footing: both endpoints
  answer `404` outside the list, and a space with no rules page answers `404`
  too, so the response does not distinguish "there are none" from "not for you".
- **Skills are content, not code.** A skill body is untrusted stored text, the
  same as a page body: `wiki.list_skills` and `wiki.get_skill` carry the
  content-is-data statement, nothing on the server parses a skill body for
  anything but its front matter, and nothing executes one. `clewwiki-mcp skills
  install` writes them to files and stops there — it runs no script, no hook and
  no post-install step. The front matter it does parse is a flat mapping of four
  known keys; anything else is refused with a `validation` error naming the
  field and the line, so a crafted document cannot reach a fuller YAML parser.
- **The install command writes only inside its target directory.** A slug is
  held to lowercase words joined by single hyphens (the same pattern a CHECK
  constraint enforces on the column), the joined path is resolved and compared
  with the resolved target afterwards so nothing lands outside it even if a slug
  passed the pattern, and a path component that is a symbolic link is refused
  rather than followed — the final file is opened with `O_NOFOLLOW` as well, so
  a link created between the check and the write does not win. A `SKILL.md` the
  command did not write, or wrote and somebody edited afterwards, is left alone
  and reported unless `--force` is passed; the hash it compares against lives in
  a `.clewwiki-skill.json` written beside each file. Tests cover the escape
  refusal directly: `..`, `../evil`, `a/b`, an absolute path, a dotted name and
  an over-long slug are each refused, and a symlinked skill directory is refused
  with nothing written through it.
- **Discussion messages are untrusted content.** A message is text another
  person or another agent wrote, stored verbatim and handed back verbatim. It is
  never rendered as Markdown in the interface, never merged into a page, and
  never summarised by the server — resolving a discussion writes exactly the
  prose the caller typed, so no decision page can contain a claim the server
  invented about a conversation. Bodies are capped at 8 KB measured in octets
  (a CHECK constraint as well as a service check, because a body of Cyrillic is
  twice its character count), a thread holds at most 200 messages, and a space
  holds at most 100 open threads; each cap is a `validation` refusal naming the
  limit, never a silent truncation.
- **Discussions are space-scoped like everything else.** Listing, reading,
  writing, resolving and deleting all go through `requireWorkspace` and
  `requireSpace`, so a thread in a space an agent token is not allowed into
  answers `404`, exactly as a page there does — the response never confirms that
  it exists. Reading needs `pages:read` and writing needs `pages:write`; no new
  scope was invented, because a discussion is content of the space and a new
  scope would invalidate every token already issued for a conversation about
  pages the token may already rewrite.
- **Who may delete a discussion.** A workspace administrator, or the actor that
  opened the thread — not every writer. A thread is other people's conversation,
  and the two legitimate reasons to remove one before its retention window runs
  out are housekeeping and the opener withdrawing their own question. Every
  other writer is refused with `forbidden`. Deletion removes the thread's
  messages and **never** the decision page it produced: the foreign key points
  from `discussions` to `pages` and not the other way round. The audit row for a
  deletion carries the thread's title and its decision page, because the row it
  describes is gone and the log would otherwise record that something was
  removed and nothing about what.
- **Discussions expire by policy, and the policy is bounded.** Per space,
  `discussion_idle_days` (default 14) and `discussion_retention_days` (default
  7) are clamped to 1–365 whatever the settings JSON says, so a value written by
  an older release or a mistaken administrator cannot make a sweep delete a
  thread the moment it is created or keep one forever. Every transition is
  audited: `discussion.opened`, `discussion.message`, `discussion.resolved`,
  `discussion.expired` and `discussion.deleted`. Message bodies are deliberately
  absent from the audit metadata — the log records who spoke and when; the words
  belong to the thread and go with it.
- **Reviews are recorded by people only.** `POST /api/v1/pages/{id}/review`
  refuses any bearer token with `forbidden`, before scopes are looked at and
  whatever they are, and the interface reaches the same service through a server
  action that exists only behind a session cookie. The review is how a person
  learns what agents wrote; a token that could accept would let an agent clear
  the list it is on, and one that could revert would let agents undo each other
  outside the claim protocol. Agent tokens can *read* the queue, the feed, the
  diffs and the decisions with `pages:read`, space-restricted like every other
  read. A decision names the version the reviewer saw and is refused as
  `stale_base` if the page has changed since, so nobody accepts content they
  were not shown. A revert takes a claim like any write and never overrides a
  live one. Diff lines and review notes are rendered as escaped text; a note is
  a person's words to agents and is returned to them as data. Both decisions are
  audited (`page.review_accepted`, `page.review_reverted`) with the version
  range, never the content.
- **A restricted space does not exist for somebody who is not in it.** Not
  listed, not searched, not shown on the presence board, and `404` — never `403`
  — on every endpoint, page and server action that names it or anything in it,
  so a refusal does not confirm there was something to refuse. Over REST this is
  the allowlist check every handler already made for space-limited tokens, now
  fed a person's visibility as well. In the interface it is guarded lookups, and
  a test that fails the build when interface code bypasses them, when a
  cross-space listing is not scoped to the session, or when an action takes an
  id without checking it; `generateMetadata` is held to the same rule, because a
  title is delivered even when the page answers "not found". **Workspace
  administrators see every space**, deliberately: they can issue a token that
  does. **A token with no space list reaches restricted spaces** — limit tokens
  to spaces. The member list names people, so reading and changing it is for a
  signed-in administrator and for no token. Only people of the workspace can be
  listed, an unknown id is refused rather than dropped, and changes are audited
  with who was added and removed. Changing access ends the space's live editing
  sessions so that an already-open stream cannot outlive a removal. Membership
  grants visibility and nothing else; there is no read-only role.
- **Live editing sessions are for people, and a browser speaks only for itself.**
  `GET` and `POST /api/v1/pages/{id}/collab` refuse any bearer token with
  `forbidden`; a session is joined with a session cookie by somebody who can see
  the page's space, and cookie-authenticated `POST`s pass the same origin check
  as every other mutation. A message is taken only from a connection that
  joined, and only as the person who joined it: another person presenting that
  connection's id is answered `404`, the same as a connection that does not
  exist. A browser may report its own cursor and no other — the awareness update
  is decoded and refused with `forbidden` if it names any client id but the
  sender's — and the name and colour beside a cursor are read from the server's
  participant list, never from what a browser says about itself; they reach the
  DOM as text and as a colour checked against `#rrggbb`. The shared document is
  opaque bytes to the server: relayed, merged and stored, never parsed into a
  page, never returned to an agent. What becomes a page is Markdown sent through
  the ordinary write path, with its validation. Everything is bounded: 1 MB per
  update, 16 MB of updates per session, 24 connections per session, 200
  sessions per process, and a connection that falls too far behind is closed
  rather than buffered for. A session's claim is an ordinary claim: an
  administrator can force-release it, it expires by TTL, and a session that is
  idle gives it back by itself.
- **Comments: who may do what.** Reading needs `pages:read` and writing
  `pages:write`, space-restricted, with no new scope. A person may resolve any
  thread; an agent token only a thread an agent opened, and is otherwise refused
  with `forbidden` — a reviewer's request is not met because the agent under
  review says so. Deleting a comment is for its author or a workspace
  administrator. Bodies are capped at 8 KB (a column check as well), a page at
  200 open threads, a thread at 100 replies, and posting draws on the same
  per-actor bucket as discussion messages, so a loop cannot fill a page's margin.
  Comment bodies and review notes are rendered as escaped text, never as
  Markdown, and the tools that return them say they are data. The `data-block`
  and `data-comments` attributes the interface relies on are written by the
  renderer after sanitising; a page body cannot produce them. Audit rows record
  who commented on which page and never the words.
- **Write audit log.** Every write attempt — success, claim conflict, content-
  hash conflict, a refused subtree delete — is recorded. A successful write
  commits its audit row in the same transaction as the write itself. A refused
  one cannot: the transaction that would carry the row is the one being rolled
  back, so the record follows immediately on its own connection instead.
  Authentication events are recorded too: `auth.rejected` (revoked or expired
  token), `auth.rate_limited`, `auth.login_failed`, `auth.login_rate_limited`,
  and `space.repository_set` / `space.repository_tested` (before spaces:
  `workspace.repository_set` / `workspace.repository_tested`). Creating,
  changing and archiving a space is audited as `space.created`,
  `space.updated`, `space.archived` and `space.unarchived`; a space's skills as
  `skill.created`, `skill.updated` and `skill.deleted`, each in the transaction
  that performed the write. Designating a space's rules page is a
  `space.updated` naming `rules_page_id` among its fields. Refusals that
  arrive in bursts (`auth.rejected`, `auth.rate_limited`,
  `auth.login_rate_limited`) are written at most once per key per ten seconds,
  carrying a `suppressed` count, so a flood is visible without becoming a
  write load on the table. Not yet recorded: a token whose prefix is unknown
  or whose secret is wrong (there is no workspace to attribute it to), logout,
  and refused page creations. There is no retention policy; the operator
  prunes `audit_log` if they need to.
- **Claims are administrator-recoverable, not agent-recoverable.** A lease
  that outlives the client holding it expires on its own, and until then
  only a workspace administrator can take it away. Force-release is a role
  check rather than a scope: an agent token carries scopes but no role, so
  no token can release another actor's claim however broadly it is scoped.
  Each force-release is audited under its own action, with the holder it
  was taken from. Deleting a subtree in which another actor holds a live
  claim is refused with `conflict` for everyone but an administrator.
- **Deletion is recoverable.** Pages are soft-deleted with their revision
  history. An administrator restores a deleted subtree with
  `POST /api/v1/pages/{id}/restore`, which refuses rather than guesses when a
  live page has taken one of its paths or its parent is gone or has moved.
- **Rate limiting.** Agent tokens are rate-limited per token (not per IP,
  since an agent may sit behind a shared address), 60 requests per minute by
  default. Browser use of the API is not rate limited, but password sign-in
  is: ten attempts per account and thirty per client address per fifteen
  minutes, enforced inside the login server action (which the authentication
  library's own HTTP limiter never sees) and answered exactly like a wrong
  password. The client address is read only from `TRUSTED_CLIENT_IP_HEADER`
  (`X-Real-IP` by default), which the reverse proxy must overwrite;
  `X-Forwarded-For` is never trusted, and without the header all clients share
  one bucket. The library's limiter on `/api/auth/*` reads the same header. All
  counters live in the application process, so several replicas multiply the
  ceilings. Posting a discussion message consumes from a second, tighter bucket
  keyed by actor — 20 per minute by default
  (`DISCUSSION_MESSAGE_RATE_LIMIT_MAX`, `DISCUSSION_MESSAGE_RATE_LIMIT_WINDOW`) —
  because a message is the cheapest write in the API to repeat and a thread
  flooded by one agent is useless to everyone else long before the general limit
  would notice. The server action behind the web compose box consumes from the
  same bucket, so the interface is not a way around the limit an agent is held
  to.
- **Request amplification.** `/mcp` accepts at most ten JSON-RPC messages per
  request. An anchor check reads at most 2 000 files, 32 MB of source and 30
  seconds of parsing, skips files over 1 MB from the tree listing before
  reading them, yields to the event loop between parses, and reports a partial
  result (`complete: false`) instead of truncating silently. Recomputing
  anchors is a `POST` that needs `pages:write`. Not yet bounded: the queue of
  checks waiting for one space's repository lock, and a `/mcp` tool call
  still counts against the token's limit once for the outer request and once
  per REST call it makes.
- **First-run setup.** No account or credential ships in any migration or
  fixture. `/setup` requires a one-time setup token — `CLEWWIKI_SETUP_TOKEN`
  when set, otherwise a random token generated at start-up, printed once to the
  server log and kept only in memory — compared in constant time. The routine
  runs under a database advisory lock, and if the membership or audit write
  fails after the account was created, the account is deleted again, so a
  failed setup cannot leave an instance with an account and no administrator.
  The authentication library's public sign-up route is disabled; `/setup`
  creates the first account and an invitation creates every one after it.
- **Invitations.** There is no self-registration and no mail transport, so a
  person joins the way an agent does: an administrator makes a secret and hands
  it over. An invitation is for one e-mail address and one role; its link
  carries 256 bits of randomness, is shown exactly once, and only the SHA-256 of
  its secret is stored — a database dump holds no working link. It works once
  (claimed by a conditional update, so a link opened twice at the same moment
  makes one account), for seven days, until revoked; inviting the same address
  again revokes the earlier link. Every way a link can fail — malformed,
  unknown, used, revoked, expired — gives the same answer, compared in constant
  time, so a link says nothing about what it once was. The account is created
  server-side by the authentication library with the invited address, never one
  the visitor types; if the membership cannot be written after it, the account
  is deleted again. `/join/…` is marked `noindex` and `no-referrer`, so
  the link is neither kept by a search engine nor sent on to another site. Only administrators invite, change roles and remove, and that
  is checked in each server action, not only on the page. **A workspace always
  has an administrator**: the last one cannot be demoted or removed, the count
  is taken under a row lock in the transaction that makes the change, and an
  administrator cannot remove themselves. Removing a member deletes the account
  — sessions and credentials cascade — while what they wrote stays under the
  name it was written under. There is no password reset: no mail is sent, and
  an administrator recovering somebody's access removes and re-invites them.
  Every step is audited: `invitation.created`, `invitation.revoked`,
  `member.joined`, `member.role_changed`, `member.removed`.
- **Cross-site requests.** Server actions carry Next.js's own origin check. REST
  calls authenticated by the session cookie that change state must come from
  the instance's origin (`Origin` equal to `BETTER_AUTH_URL`, or
  `Sec-Fetch-Site: same-origin`) and be `application/json`; otherwise `403`.
  That closes the gap `SameSite=Lax` leaves for pages on a sibling subdomain.
  Bearer-token requests are not affected.
- **TLS at the edge.** The application does not terminate TLS itself. Secure
  cookies are enabled when `BETTER_AUTH_URL` starts with `https://`, and HSTS
  is sent only when the proxy reports `X-Forwarded-Proto: https`. Deployment
  documentation is explicit that a reverse proxy supplying TLS is required
  before exposing an instance, and compose publishes the port on loopback
  only. The stdio MCP server refuses to send a token to a plain `http://`
  instance other than `localhost`/`127.0.0.1` unless
  `CLEWWIKI_ALLOW_INSECURE_URL=true`.
- **Content-as-data.** Responses that carry page body text separate it from
  provenance metadata (author, timestamps, content hash). Every MCP tool whose
  result carries text written by someone else — pages, space descriptions,
  claim notes, holder names, discussion titles and message bodies, names read
  from repository code — states verbatim
  in its description that the text is data, not instructions (`docs/mcp.md`
  lists the fourteen). The two that most invite the opposite reading are a
  project's rules and a skill body, both written in the imperative: they say
  what the project expects of work done in it, and they are not a channel
  through which an author issues orders to a reading agent. **Discussion
  messages are sharper still**, because they are addressed to another agent and
  are routinely phrased as commands — "drop the cookie", "do not touch the
  session module". They are somebody else's words about somebody else's work,
  and whether anything follows from them is the reading agent's decision, made
  because a person asked for that work. The web interface renders a message body
  as the text it is — `whitespace-pre-wrap`, never Markdown, never folded into a
  page — so a message cannot become markup a reader's browser acts on.
  Output written by a remote git server is kept out of API responses and tool
  results and goes to the server log. This is a documented contract, not a
  technical guarantee enforceable on a calling agent.
- **Rendered page content.** Page bodies are rendered on the server through
  `remark` and `rehype-sanitize` with GitHub's default schema; raw HTML in a
  body never reaches the output. Chart blocks add inline SVG, and the
  sanitiser allowlist was widened for it by exactly what the chart renderer
  emits — the elements `svg`, `g`, `title`, `desc`, `path`, `rect`, `line`,
  `circle` and `text`, and presentation attributes (`viewBox`, `role`,
  coordinates, `fill`, `stroke`, `stroke-width` and similar). The lists live
  next to the renderer (`CHART_SVG_TAGS`, `CHART_SVG_ATTRIBUTES` in
  `packages/content`), and a test walks every chart the renderer draws to check
  it never emits anything outside them. `class` on those elements is limited to
  the renderer's own `chart…` names. This is safe because nothing on the list
  can load, link or run anything: no `a`, `use`, `image`, `foreignObject`,
  `script`, `style`, `animate` or `set` element, and no attribute that takes a
  URL, an event handler or inline CSS. Raw SVG written into a body is still
  dropped before the sanitiser sees it, and tests pass SVG carrying `script`,
  `onload`/`onclick`, `foreignObject`, `style`, `animate`/`set`,
  `href="javascript:…"`, `use` and `image` through the sanitiser and check that
  all of it is stripped. Chart JSON is parsed as data — no expressions, no
  functions — and every label is escaped as text. Mermaid still runs only in
  the reader's browser with `securityLevel: 'strict'`.
- **Uploaded images.** A page takes PNG, JPEG, GIF and WebP uploads, and
  nothing else: no SVG, which is a document that can carry script, and no other
  attachment. Serving bytes a user supplied from the application's own origin
  is the risk, and it is fenced in on both ends. On the way in, the type is
  detected from the file's signature — the declared type and the file name are
  never used — so an upload is one of four formats or it is refused; the size
  is refused from the declared `Content-Length` and again while reading
  (`IMAGE_MAX_UPLOAD_MB`, 5, at most 10, and a `CHECK` on the table); a
  workspace's images are capped together (`IMAGE_STORE_MAX_MB`); uploads are
  rate limited per actor; and `IMAGE_MAX_UPLOAD_MB=0` switches the whole
  surface off. On the way out, an image is served as its detected type only,
  with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
  'none'; sandbox` and `Cross-Origin-Resource-Policy: same-origin`, so bytes
  that are also a valid HTML document reach a browser as a picture or not at
  all. A cookie-authenticated upload needs a matching `Origin` outright and an
  `image/*` content type, which no plain HTML form can send. An image is
  visible to whoever can see its page — in whichever space the page is now,
  and not at all once the page is deleted — and is always revalidated, so a
  browser's copy stops being used when its page moves out of the reader's
  sight. One uploaded from the new-page form is visible to its uploader alone
  until that same actor's new page claims it. Known limits: images are not
  re-encoded, so metadata inside a file (a photograph's location, for one)
  stays in it, and pixel dimensions are not bounded separately from bytes.
- **Images carried by an import.** A Notion export and a Markdown archive bring
  the pictures their documents show, a Confluence import downloads the ones
  attached to the pages it reads (at most 1 000 per import, under the redirect
  rules described with the import transport below), and all of them go through
  the same door as an upload: the type is read from the bytes, never from the extension the archive
  gave them; `IMAGE_MAX_UPLOAD_MB` and `IMAGE_STORE_MAX_MB` apply; SVG is not
  taken; and `IMAGE_MAX_UPLOAD_MB=0` switches this off with the rest. They are
  judged when the import is *staged*, so an image that will not be carried is a
  warning the reviewer reads before applying. What passes waits in the database
  (`import_images`) — never on a filesystem — and is removed when the import is
  applied, cancelled or deleted. Applying stores one copy per page that shows
  the image, each audited as `image.uploaded`, so an imported image is visible
  to exactly whoever can see its page. Only images a document refers to are
  staged; the rest of an archive's pictures are not kept.
- **The inbox leaks nothing a listing would not.** What came back to a person or
  an agent — answers, replies, reviews — is not stored as notifications. It is a
  query over discussions, comments and reviews, run when the inbox is opened and
  held to the caller's `spaceIds` at that moment, the same allowlist every other
  read is held to. So there is no copy of a title or an excerpt that could
  outlive the thing it quotes or the membership that made it visible: leaving a
  restricted space empties the inbox of it, a deleted discussion is gone from
  it, a deleted page takes its comments with it. The endpoint has no parameter
  naming another actor; the only row it writes is the caller's own read mark
  (`inbox_marks`). Mentions are the one stored item (`mentions`): who a name
  meant has to be decided when it is written. A row is deleted with the message
  or comment it belongs to, names only members and live tokens of the *same*
  workspace, and is shown under the reader's visibility like everything else —
  mentioning somebody who cannot see a restricted space tells them nothing, not
  even that it happened. Ten names per text count, so a mention is not a
  broadcast, and the list of names a form offers is the list of authors every
  member already sees. `tests/space-visibility-guard.test.ts` fails if interface
  code reads an inbox without passing `spaceIds`.
- **Images from other sites.** Pages can also reference images by address.
  The Content-Security-Policy allows images from the instance itself
  only, so a page cannot make every reader's browser contact a third-party
  server that learns who read it and when (a tracking pixel). An operator who
  accepts that can set `ALLOW_EXTERNAL_IMAGES=true`, which adds `https:` to
  `img-src` and nothing else; scripts stay on a nonce with no `unsafe-eval`
  outside development. The editor accepts only `http(s)` or relative addresses
  for images and links, never `data:` or `javascript:`.
- **Structured blocks are validated on write.** Chart and Mermaid blocks are
  checked by the page service for every writer — REST, MCP and the web form —
  and an invalid block refuses the write, which is audited like any other
  refused write. The check is bounded: 100 KB of JSON per chart, eight series,
  1 000 points per series, 50 000 characters per diagram, inside the existing
  1 000 000-character body limit. Mermaid is never executed on the server. A
  skill body is bounded at 256 KB of octets, by a CHECK constraint as well as by
  the service, and its front matter is refused unless it is a flat mapping of
  the four keys this instance stores.
- **Secrets from environment only.** No secret value is baked into a built
  image or committed to source; `.env.example` documents required keys with
  empty values, and the container refuses to start on a placeholder secret.
- **Repository access.** The repository URL is administrator input that
  reaches a `git` subprocess: it runs without a shell, with `--` before the
  URL, with system and user git configuration and hooks disabled, and with
  `GIT_ALLOW_PROTOCOL` limited to `https`, `http` and `ssh` (plus `file` when
  `ALLOW_FILE_REPOSITORIES=true`). URLs with embedded credentials, `git://`,
  `ext::` and anything starting with `-` are refused when saved and again when
  read. The access-token setting may only name `CLEWWIKI_GIT_TOKEN` or
  `CLEWWIKI_GIT_TOKEN_<NAME>` — checked on save and again when the value is
  read — so it cannot point at another secret of the process; the credential
  is sent only to the `https://` origin of the repository, never over plain
  HTTP and not along a redirect to another host. **Test connection** is
  audited.
- **Streamable HTTP exposure.** Every streamable HTTP MCP request requires a
  valid agent token; there is no anonymous MCP HTTP endpoint, and a session
  cookie is not accepted. The endpoint is off unless `MCP_HTTP_ENABLED=true`.
  The CORS/Origin allowlist defaults to empty as a direct mitigation against
  DNS rebinding, a known risk class for locally or network-exposed MCP HTTP
  servers.
- **Imported documents are untrusted input.** An import carries somebody else's
  files into this instance, and every stage treats them as data. Confluence
  storage XHTML is read by a parser that builds a tree and nothing else — it
  executes nothing, and `<script>` and `<style>` bodies are read to their
  closing tag and discarded rather than becoming content. Converted bodies are
  Markdown and go through the same renderer as anything else, which drops raw
  HTML and sanitises what is left. Text that came out of a document is escaped
  before it is emitted, so a heading containing `[x](javascript:…)` becomes
  those characters rather than a link. Nothing in an imported document is ever
  read as an instruction, however it is phrased — the rule the rest of the
  product already applies to stored page content applies here at the door.
- **Archives are read defensively.** The ZIP reader walks the central directory
  rather than trusting local headers, refuses encrypted archives, caps entries
  (20 000) and expanded size (256 MB by default, `IMPORT_MAX_EXPANDED_MB`), and passes `maxOutputLength` to inflate
  so an entry that under-reports itself cannot exhaust memory. Entry names that
  are absolute, contain `..`, a backslash, a null byte or a drive letter are
  skipped; no import writes to the filesystem at all, so a traversal name could
  at worst have been a map key.
- **Import credentials are used once and never stored.** The Confluence import
  asks for an Atlassian account e-mail and an API token. They live in the
  request handler's scope, are turned into a single `Authorization` header
  inside the client, and are written nowhere: not to `imports.params`, not to
  the audit log, not to a log line, not into an error message — the client's
  own errors name neither the address nor the account, and a rejected
  credential answers "Confluence refused the e-mail and API token" and stops
  there. What is recorded is the site origin and the space key. The address
  must be `https`, refused otherwise, because an API token sent over plain HTTP
  is a token handed to the network. Operators should use a token belonging to
  an account that can read the space and nothing more, and revoke it once the
  migration is done. This is the same principle as the repository setting,
  which stores the *name* of an environment variable and never a token; the
  import differs only in that it needs no persistence at all.
- **An import only talks to the public host it was given.** The Confluence
  address is typed by a person, and after that the server at that address
  decides what is requested next — through redirects and through the `next` link
  of every listing — on a request that carries a credential. Left alone that is
  server-side request forgery: a way for any editor to make the instance probe
  its own loopback, its private network or a cloud metadata endpoint, reading
  the outcome from the error. So the address must be `https` and must not be, or
  resolve to, a loopback, private, carrier-grade NAT, link-local, multicast or
  reserved address, in IPv4, IPv6 or IPv4-mapped form, and every address a name
  resolves to must pass (`assertPublicHost`); a `next` link is followed only as
  a path on the origin that was given, and one naming any other origin ends the
  import; an API request follows no redirect; and a response is read up to 64 MB
  and no further. **One kind of request does follow redirects: an image
  download.** Confluence Cloud serves every attachment by redirecting to its
  media host, so there is no fetching a picture without it. Those requests are
  held to their own rules: at most three hops; every hop `https`; every host
  other than the origin checked to be public before it is dialled, and checked
  again inside the socket's lookup; an image read up to `IMAGE_MAX_UPLOAD_MB`
  and no further; and **the `Authorization` header is sent to the origin that was
  typed and to no other host** — a server that redirects the import somewhere
  gets a request there, never a credential. A download that breaks any of these
  costs the import that picture, which stays a link to Confluence with a
  warning; it never costs the pages. **The check is not raceable.** Checking an address and then
  connecting to its name would be two resolutions, and a name server that says
  "public" to the first and `127.0.0.1` to the second — DNS rebinding — would
  pass one and land the other. The import's transport therefore gives the socket
  a `lookup` of its own that resolves the name, refuses unless every address is
  public, and returns what it checked: the address validated is the address
  dialled, and there is no second lookup to answer differently. TLS still
  verifies the certificate against the host name. Restricting the container's
  egress to outbound `443` remains good practice, and is no longer what this
  control depends on.
- **What one import can cost is bounded, and the bound is the operator's.** An
  import holds its upload and everything a ZIP expands to in memory until it is
  staged. Both are capped — `IMPORT_MAX_UPLOAD_MB` (200) and
  `IMPORT_MAX_EXPANDED_MB` (256) — only Markdown, CSV and raster image entries
  (PNG, JPEG, GIF, WebP) are expanded at all, and importing is for signed-in
  people. On a host with less memory than
  the two together, lower them: a process that runs out is killed, not refused.
- **Imported markup cannot exhaust the reader.** The storage-format reader is
  iterative, recognises no DOCTYPE and therefore no entity definitions, bounds
  the depth of the tree it builds (256) because everything that walks the tree
  recurses, and reads a body in linear time.
- **Upload limits are enforced at the edge and while parsing.** 200 MB per
  upload, refused from the declared `Content-Length` before a byte is read —
  `413` when it is over the limit, `411` when it is absent, since a body of
  unknown length cannot be bounded without buffering it — and checked again from
  `File.size` once parsed; 5 000 pages and 10 MB
  of Markdown per page, checked inside the adapters; 10 imports waiting for
  review per space, so staged copies of other people's documents cannot
  accumulate unbounded. Anything over a limit is `400 validation` naming it.
  Finished imports can be purged (`purgeFinishedImports`), because staged
  Markdown is a copy of somebody else's documentation and there is no reason to
  keep it once the import is over.
- **Agent tokens cannot import.** The import endpoints refuse a bearer token
  outright, with `forbidden` and a message saying why, rather than checking
  scopes. The reason is structural: the safety of an import is the human review
  in the middle of it — a person looks at the tree, the paths and the warnings
  and decides what becomes pages. A token has no way to perform that judgement,
  so a scope that let one import would either skip the review, which is the
  whole protection, or stage something no one ever looks at. It would also hand
  a leaked token a way to write hundreds of pages in one call and, for
  Confluence, a place to have credentials for another system typed in. The
  refusal is the feature.
- **The upload endpoint has its own cross-origin check.** A multipart request
  cannot carry `Content-Type: application/json`, which is half of the CSRF rule
  everywhere else, and `multipart/form-data` is exactly what a cross-origin HTML
  form can send without a preflight. So the origin half is tightened instead: a
  matching `Origin` header is required outright, rather than being one of two
  ways to pass. A browser sends `Origin` on every cross-origin form POST, so a
  forged submission is refused whether or not it also sets `Sec-Fetch-Site`.
- **CI scanning.** Every push and pull request runs `pnpm audit --audit-level
  high` as a blocking step and a gitleaks secret scan over the full history.
  Every job runs with `contents: read`, and third-party actions are pinned to a
  commit SHA.
- **Anomaly detection.** Not implemented as code. The audit log carries the
  raw signal (bursts of `auth.rejected`, `auth.rate_limited`,
  `auth.login_failed`), and `docs/deploy.md` tells the operator what to look for;
  nothing alerts on its own.

## Explicitly out of scope for v1

- Per-page or per-path token scope — `resource:action` scopes, the space
  restriction, TTL, revocation and workspace binding already bound the blast
  radius of a leaked token without per-object access lists.
- Per-space roles for people — accounts are admin or editor across the whole
  workspace in this version; per-space permissions are the next step on the
  roadmap.
- A WAF, IDS, or full SIEM — excessive for a single-team self-hosted
  instance; the audit log, rate limiting, and reverse-proxy TLS already
  cover this threat model.
- SSO/OIDC — a scope decision, not a security gap; credential-based login
  already satisfies the self-hosted-without-a-cloud-provider requirement.
- Attachments other than images. Pages take raster images — uploaded, or
  carried in by an import — under the controls described
  above; any other file type is a wider surface (content sniffing, active
  documents served from this origin) and stays closed. A Confluence attachment
  that is not a raster image keeps pointing at the site it came from, and is
  reported as a warning. Images inside a PDF are not extracted.
- Optical character recognition for scanned PDFs — a PDF with no extractable
  text is refused rather than passed to an external service.

## Pre-release review

A full pass against every item above is a mandatory exit criterion before
public launch, distinct from the narrower point checks done earlier
against authentication and claims/token handling. Its outcome — what was
fixed and what was accepted, with the reasoning — is recorded under Phase 6
in `docs/roadmap.md`.
