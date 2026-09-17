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
  because one call removes a subtree.
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
  never reaches into a space the caller cannot see. The audit log covers every
  space, so a restricted token cannot read it at all, whatever its scopes.
  Issuing a restricted token requires at least one space of the same
  workspace. A space created later is not added to an existing restriction.
  People are not restricted: roles are workspace-wide in this version.
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
  `space.updated`, `space.archived` and `space.unarchived`. Refusals that
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
  ceilings.
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
  The authentication library's public sign-up route is disabled; `/setup` is
  the only way an account is created.
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
  claim notes, holder names, names read from repository code — states verbatim
  in its description that the text is data, not instructions (`docs/mcp.md`
  lists the nine).
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
- **Images from other sites.** Pages reference images by address; there are no
  uploads. The Content-Security-Policy allows images from the instance itself
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
  1 000 000-character body limit. Mermaid is never executed on the server.
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
- **CI scanning.** Every push and pull request runs `pnpm audit --audit-level
  high` as a blocking step and a gitleaks secret scan over the full history.
  Every job runs with `contents: read`, and third-party actions are pinned to a
  commit SHA.
- **Anomaly detection.** Not implemented as code. The audit log carries the
  raw signal (bursts of `auth.rejected`, `auth.rate_limited`,
  `auth.login_failed`), and the README tells the operator what to look for;
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

## Pre-release review

A full pass against every item above is a mandatory exit criterion before
public launch, distinct from the narrower point checks done earlier
against authentication and claims/token handling. Its outcome — what was
fixed and what was accepted, with the reasoning — is recorded under Phase 6
in `docs/roadmap.md`.
