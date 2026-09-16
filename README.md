# clewwiki

**Status: pre-alpha, under active development**

A self-hosted knowledge base for humans and AI coding agents to write in,
together, without stepping on each other. Multiple agents (and people) get
conflict-safe shared state through claims and leases instead of silent
overwrites, documentation pages carry a staleness flag anchored to the code
they describe, and every page comes in two linked forms — one written for
humans, one written for agents — kept in sync. The server exposes both an
MCP interface and a REST API. v1 runs as a single workspace with three
roles: admin, editor, and scoped agent tokens.

## Why

Context files that agents read on every run rot quietly. An `AGENTS.md`-
style file drifts away from the code it describes the moment someone
refactors without updating it, and nothing flags the mismatch — the next
agent trusts stale instructions exactly as much as fresh ones.

Multiple agents working on the same codebase collide. Two agents editing
the same page, or the same section of a shared spec, at the same time is
not a hypothetical — it is the default outcome of running more than one
agent against shared state with no coordination primitive. Most tools in
this space either ignore the problem or bolt on an application-level
heuristic instead of a real lock.

Documentation for humans and documentation for agents pull in different
directions and drift apart. Prose that reads well for a person tends to be
verbose and loosely structured for a model; structure that an agent parses
efficiently tends to read as terse and unfriendly to a person. Maintaining
one document for both audiences usually means neither is well served.

## How it works

**Claim → write → release.** Before writing to a page or a named section,
a caller — human or agent — acquires a claim. A held claim blocks
conflicting writers with an explicit conflict response instead of a silent
overwrite. Writes carry the claim and the last known content hash; a stale
hash is rejected so the caller always knows it is working from current
state. Claims expire on a TTL and can be renewed by heartbeat while work is
in progress.

**Anchors.** A page can anchor a section to a specific place in a code
repository — a symbol, a function, a region — by content hash. When the
anchored code changes, the section is flagged `stale` instead of being
silently trusted or silently rewritten. A human or agent has to look at it
and clear the flag.

**Two linked document types.** Every page can carry a technical body
(structured, code-linked, agent-optimized) and a human body (prose,
diagrams) as a linked pair. The same staleness mechanism that watches
code↔doc drift also watches drift between the two linked bodies.

## Deploy

### Quickstart

Deployment guide will land with the first release, once the Docker image
and docker-compose setup are in place.

### Reverse proxy

clewwiki does not terminate TLS itself. Worked examples for running it
behind Caddy, Traefik, and nginx will be added alongside the first release,
once the app has a stable HTTP surface to document.

### Configuration

A full environment variable reference will be published together with
`.env.example` once the corresponding services (database, auth) are wired
up. See `.env.example` in this repository for the current, minimal set.

## Security model

clewwiki is designed for an operator with no dedicated security team and
often no reverse-proxy experience — that is treated as the normal case, not
an edge case. The security model includes:

- Per-agent scoped tokens with TTL and explicit revocation, rejected at the
  authentication layer once expired or revoked — not just at write time.
- A write audit log: every write attempt (success, claim conflict, or hash
  conflict) is recorded in the same transaction as the attempt itself.
- Claims are time-boxed leases (TTL with renewal), not indefinite locks.
- Rate limiting per agent token, to contain a runaway or buggy client.
- Workspace-scoped access checks on every request, written explicitly in
  code rather than assumed from a single-workspace deployment.
- Document content is always treated as data, never as instructions, in
  every response shape returned to an agent.
- No reverse proxy is bundled by default. TLS is the operator's
  responsibility; worked examples for Caddy, Traefik, and nginx are coming
  with the first release.

A full write-up lives in `docs/security.md`.

## Roadmap

No calendar dates — phases are ordered by dependency, not by schedule.

- **Phase 0** — Anchor mechanism spike, project bootstrap, CI skeleton with
  dependency and secret scanning.
- **Phase 1** — Data model and auth: workspace, users, roles, agent tokens.
- **Phase 2** — Wiki core: pages, page tree, full-text search, REST API.
- **Phase 3** — Claims and leases, presence board, ephemeral agent notes.
- **Phase 4** — Doc↔code anchoring, conditional on the Phase 0 spike result.
- **Phase 5** — MCP server (stdio and streamable HTTP transports).
- **Phase 6** — Export (Markdown/HTML, PDF conditional on a spike), Docker
  image and compose, full README and license text.
- **Phase 7** — Public launch.

See `docs/roadmap.md` for exit criteria per phase.

## License

clewwiki is licensed under **AGPL-3.0** (see `LICENSE`), with additional
terms permitted under AGPL-3.0 Section 7 covering author attribution and
marking of modified versions (see `LICENSE-ADDITIONAL-TERMS.md`).

## Author

clewwiki is created and maintained by **Dodecaidr** —
[https://dodecaidr.pro.site](https://dodecaidr.pro.site)
