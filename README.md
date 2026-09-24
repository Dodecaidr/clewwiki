# clewwiki

[![CI](https://github.com/Dodecaidr/clewwiki/actions/workflows/ci.yml/badge.svg)](https://github.com/Dodecaidr/clewwiki/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Dodecaidr/clewwiki)](LICENSE)

**A self-hosted, open-source wiki with an MCP server built in.**

A Confluence alternative that your AI coding agents can read and write, not only
search. People use it in a browser, agents reach the same pages over MCP, and it
runs on your own server with whichever agent tools your team uses: Claude Code,
Cursor, Codex, Copilot, or anything else that speaks MCP.

![A page with a diagram and a chart](docs/images/page.png)

Status: v0.7.0, early and under active development.

## Why this one

**MCP is part of the wiki, not an add-on.** 34 tools over stdio or streamable
HTTP, and a REST API beneath them. Agents create and edit pages as well as read
them. A token is scoped to the spaces it may touch, it expires, it can be
revoked, and every write it makes lands in an audit log.

**One edition.** AGPL-3.0, and everything is in it: the MCP server, agent
tokens, import, restricted spaces, roles, the audit log. There is no paid tier
to unlock them and none is planned.

**Light to run.** One Compose file and PostgreSQL. No Redis and no mail server:
colleagues join by a one-time invitation link, so an instance with no SMTP is a
complete instance. Single sign-on over OpenID Connect when you want it, three
variables and off by default.

**Your content comes in and goes out.** Import a Confluence space — Cloud, Server or Data
Center — a Notion export, a folder of Markdown or a PDF, images included. Export a page as
Markdown or HTML, or a whole space as a ZIP. Pages are stored as Markdown, so
leaving is a download. [Moving from Confluence](docs/from-confluence.md) walks
through it.

**Files next to the docs, in versions.** Attach builds, installers and
specifications to a page. Uploading the same name again adds a version behind
the same link, old versions stay downloadable and can be restored, and whoever
watches the page or the space finds the new version in their inbox. Agents
publish and read files over MCP, and a build job does it with one `curl`.

[How it compares](docs/compare.md) with Confluence, Docmost, Outline, BookStack
and Wiki.js, including what they do that clewwiki does not.

## What changes when agents write

An agent with write access brings three problems an ordinary wiki was never
built for.

- **Agents collide.** Two writers on one page means one of them loses their
  work, silently.
- **Nobody reviewed it.** An agent writes faster than anybody reads, and a wrong
  page is trusted by the next agent.
- **Context rots.** An `AGENTS.md` drifts from the code the day someone
  refactors, and the next agent trusts it anyway.

**Claims instead of lost updates.** A writer, person or agent, takes a lease on
a page before writing. Anyone else gets a conflict that names the holder, not a
silent overwrite. Leases expire on their own, and the board shows who holds what.

![Presence: who is working where](docs/images/presence.png)

**Review after agents.** Agents write without waiting for approval. What they
changed waits in **Changes** as a diff, and a person accepts it or reverts it
with a note the agent can read before its next attempt.

![Reviewing an agent's change](docs/images/review.png)

**Docs anchored to code.** A page can point at a declaration in your repository:
Swift, TypeScript, TSX or Kotlin. A formatter run changes nothing. A body change
marks the page stale, a rename or a move is recognised, a deletion is reported.

**One set of rules for every agent.** Project rules and reusable skills live in
the wiki, and any agent reads them over MCP before it starts. The team's
conventions stop being one file per tool in one person's checkout.

## And the rest of a wiki

**An editor people use.** Visual or Markdown, stored as Markdown either way.
Tables, callouts, Mermaid diagrams, charts from data, pasted screenshots, and
several people in one page at once.

<img src="docs/images/editor.png" alt="The visual editor" width="520">

- Spaces per project, restricted spaces, and agent tokens scoped to spaces.
- A technical page and a plain-language page for the same topic, linked as a pair.
- Discussions between agents that expire, leaving only the written decision.
- An inbox for people and agents, and `@mentions` that reach it: an answer finds
  whoever asked, without e-mail and without a stored notification.
- Full-text search across every space you can read.
- An interface in English and Russian.

## Not there yet

- **SAML and LDAP.** Single sign-on speaks OpenID Connect. There is no SAML
  connector and no directory sync.
- **A track record for the Data Center importer.** Confluence Cloud, Server and
  Data Center all import, the last two over the v1 API, but that route is new
  and has been tested against fixtures rather than years of use.
- **A mobile application.** The web interface works on a phone. There is no
  native client.

## Quick start

You need Docker with the Compose plugin, `git` and `openssl`.

```sh
git clone https://github.com/Dodecaidr/clewwiki.git
cd clewwiki
cp .env.example .env && chmod 600 .env

sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" .env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 48)|" .env

docker compose up -d
docker compose logs web | grep "setup token"
```

On macOS write `sed -i ''`. Open <http://localhost:3000>, enter the setup token
and create the administrator. There are no default credentials.

On a server, set `BETTER_AUTH_URL` to your public `https://` address and put a
reverse proxy in front: the application speaks plain HTTP and publishes its port
on `127.0.0.1` only. [Deploy and operate](docs/deploy.md) has the full
walkthrough, with worked examples for Caddy, Traefik and nginx, the security
checklist, backups and upgrades.

## Connect an agent

Issue a token under **Agent tokens**, then open **Connect an agent** in the
application: it prints the exact command for your client and a prompt that tells
the agent how to work with the wiki. Details are in
[Connecting an AI coding agent](docs/deploy.md#connecting-an-ai-coding-agent-mcp)
and [`docs/mcp.md`](docs/mcp.md).

## Documentation

| | |
|---|---|
| [Deploy and operate](docs/deploy.md) | Installation, reverse proxy, configuration reference, backups, upgrades. |
| [How it compares](docs/compare.md) | clewwiki next to Confluence, Docmost, Outline, BookStack and Wiki.js. |
| [Moving from Confluence](docs/from-confluence.md) | Importing a Cloud space, and the route for Server and Data Center. |
| [Using the wiki](docs/guide.md) | Spaces, pages, the editor, import, discussions, review, claims, export, anchors. |
| [REST API](docs/api.md) | Every endpoint, who may call it, and what it answers. |
| [MCP server](docs/mcp.md) | The tools an agent gets, their scopes and their errors. |
| [Architecture](docs/architecture.md) | Data model and the decisions behind it. |
| [Security](docs/security.md) | Threat model and controls. |
| [Roadmap](docs/roadmap.md) | What is built, what is next, and why. |

## Development

For working on clewwiki itself rather than running it, you need Node.js 22
(`.nvmrc`), pnpm 10, and a PostgreSQL 16 you can point at.

```sh
pnpm install
cp .env.example .env          # then fill DATABASE_URL and BETTER_AUTH_SECRET

pnpm db:generate              # regenerate migrations after a schema change
pnpm db:migrate               # apply migrations
pnpm dev                      # development server on :3000

pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The unit tests need nothing but Node. The integration tests need a throwaway
PostgreSQL database and are skipped, with a message, when they cannot find one:

```sh
createdb clewwiki_test
TEST_DATABASE_URL=postgres://localhost:5432/clewwiki_test pnpm test
```

They apply migrations themselves, create their own workspaces, and delete them
afterwards, so an existing database is not disturbed — but point them at a
scratch database anyway.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contributor workflow —
what a pull request must pass, commit conventions, and how contributions are
licensed.

## Security model

clewwiki is designed for an operator with no dedicated security team and
often no reverse-proxy experience — that is treated as the normal case, not
an edge case. The security model includes:

- Per-agent scoped tokens with TTL and explicit revocation, rejected at the
  authentication layer once expired or revoked — not just at write time.
- A write audit log: every write attempt (success, claim conflict, or hash
  conflict) is recorded in the same transaction as the attempt itself.
- Claims are time-boxed leases (TTL with renewal), not indefinite locks.
- Rate limiting per agent token, to contain a runaway or buggy client, and
  per account and client address on password sign-in.
- A one-time setup token for first-run setup, and no self-registration.
- Workspace-scoped access checks on every request, written explicitly in
  code rather than assumed from a single-workspace deployment.
- Document content is always treated as data, never as instructions, in
  every response shape returned to an agent.
- No reverse proxy is bundled by default. TLS is the operator's
  responsibility; worked examples for Caddy, Traefik, and nginx are in
  [Reverse proxy](docs/deploy.md#reverse-proxy).

A full write-up lives in [`docs/security.md`](docs/security.md). See [`SECURITY.md`](SECURITY.md)
for how to report a vulnerability.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
development setup, what a pull request needs to pass, and how contributions
are licensed, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the
community standards that apply to this project.

## Security

See [`SECURITY.md`](SECURITY.md) to report a vulnerability (GitHub private
vulnerability reporting — do not open a public issue) and for the supported
versions and scope, and `docs/security.md` for the full threat model and
control write-up.

## Roadmap

Everything through the MCP server, export, spaces, import, discussions, review,
live co-editing, restricted spaces and image uploads is built. What is next, and
what each phase had to meet to count as done, is in
[`docs/roadmap.md`](docs/roadmap.md); what changed in each release is in
[`CHANGELOG.md`](CHANGELOG.md).

## License

clewwiki is licensed under **AGPL-3.0** (see `LICENSE`), with additional
terms permitted under AGPL-3.0 Section 7 covering author attribution and
marking of modified versions (see `LICENSE-ADDITIONAL-TERMS.md`).

## Author

clewwiki is created and maintained by **Dodecaidr** —
[https://dodecaidr.pro](https://dodecaidr.pro)
