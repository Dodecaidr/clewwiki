# clewwiki

[![CI](https://github.com/Dodecaidr/clewwiki/actions/workflows/ci.yml/badge.svg)](https://github.com/Dodecaidr/clewwiki/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/Dodecaidr/clewwiki)](LICENSE)

**Status: v0.1.0, first tagged release. Early, under active development.**

A self-hosted knowledge base that AI coding agents write and people read,
on your own server and across whichever agent tools your team runs. Agents
reach it over MCP; people read and edit the same pages in a browser, with
a visual editor, diagrams, charts and export. Pages come in two linked
forms, one written for agents and one written for people, and a page
section can be anchored to a symbol in your repository so it is flagged
when the code moves on. Concurrent writers — a person and an agent, or
several agents — take claims instead of overwriting each other silently.
One workspace, divided into spaces (one per project), with admin, editor
and agent tokens that can be scoped to particular spaces.

Agent vendors now keep their own memory and project context inside their
products. This is the other half: your instance, your data, every tool in
one place, and a documentation layer a person can actually read and edit.

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

**Spaces.** The wiki is divided the way Confluence is: a **space** per
project or product area, each with its own page tree, its own linked source
repository and its own overview; inside it, top-level pages act as
**sections** (Architecture, Backend, Runbooks…) with subsections below them.
An agent starts by listing the spaces and then works inside its project's
one, and a token can be limited to the spaces it needs.

**Discussions that clean themselves up.** Agents working in parallel need
somewhere to ask each other about work that crosses more than one area — "I am
changing the auth contract, does anything of yours depend on it?" A **discussion**
is that place, and it is deliberately temporary: a thread nobody writes in for
two weeks closes itself, and a resolved one is deleted a week later. Resolving
it requires writing down what was decided, and that becomes a **decision page** —
an ordinary page of the space, versioned and searchable like every other. The
conversation goes; the outcome stays.

**Two linked document types.** Every page can carry a technical body
(structured, code-linked, agent-optimized) and a human body (prose,
diagrams) as a linked pair. The same staleness mechanism that watches
code↔doc drift also watches drift between the two linked bodies.

## Deploy

clewwiki runs as two containers — the application and PostgreSQL 16 — started
by one `docker compose` command, with no reverse proxy bundled. This section
takes a clean Linux server with Docker to a working instance with an agent
connected, in order. Every command is meant to be pasted as it is.

### Prerequisites

- **Docker Engine 24 or newer with the Compose plugin, v2.24 or newer.**
  Check with `docker version` and `docker compose version`. Docker's own
  install instructions for your distribution are the right way to get both.
- **git** and **openssl** on the host. Nothing else: no Node.js, no
  PostgreSQL, no package manager. Those are only needed for development.
- **About 2 GB of RAM and 5 GB of free disk.** The image is built on the
  server the first time, and the build is the hungriest thing the instance
  ever does. Running, it needs far less.
- **A domain name and a reverse proxy** for anything reachable beyond the
  machine itself. The application speaks plain HTTP only; see
  [Reverse proxy](#reverse-proxy).

### Quick start

**1. Clone the repository.**

```sh
git clone https://github.com/Dodecaidr/clewwiki.git
cd clewwiki
```

**2. Create `.env` and generate the secrets.**

```sh
cp .env.example .env
chmod 600 .env

sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" .env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 48)|" .env
```

(`sed -i` as written is GNU sed, which is what Linux has. On macOS use
`sed -i ''`.)

- `POSTGRES_PASSWORD` is the database password. It is generated as hex because
  compose places it inside a connection URL, where the `/`, `+` and `=` of
  base64 would break parsing. It takes effect when the database volume is first
  created; editing it afterwards does not change the password PostgreSQL has
  already stored.
- `BETTER_AUTH_SECRET` signs session cookies. Changing it later signs everyone
  out.

Then set `BETTER_AUTH_URL` to the address a browser will use. `.env.example`
ships with `http://localhost:3000`, which is right for a trial on your own
machine. On a server, use the public HTTPS address the reverse proxy will serve:

```sh
sed -i "s|^BETTER_AUTH_URL=.*|BETTER_AUTH_URL=https://wiki.example.com|" .env
```

It has to match what the browser sees, or sign-in cookies are issued for the
wrong origin and silently dropped. Secure cookies switch on automatically when
it starts with `https://`.

Check that none of the three is empty:

```sh
grep -E '^(POSTGRES_PASSWORD|BETTER_AUTH_SECRET|BETTER_AUTH_URL)=.+' .env
```

All three lines must print. If one is missing, compose refuses to start and
names it — there is no default to fall back on. Keep a copy of `.env` in your
password manager: it is not in any backup the commands below make.

**3. Start it.**

```sh
docker compose up -d
```

The first run pulls the published image
(`ghcr.io/dodecaidr/clewwiki:latest`), starts PostgreSQL, waits for its
healthcheck, and starts the application, which applies its own database
migrations before serving the first request. **Pin a version in production**
rather than tracking `latest` — set `CLEWWIKI_VERSION` in `.env` to a specific
release tag (e.g. `0.1.0`) so an upgrade is a deliberate `docker compose pull`
rather than whatever `latest` happens to point at that day. Images and the npm
package are published starting with the first tagged release; before that,
[build from source](#build-from-source) instead.

```sh
docker compose ps          # both services should reach "healthy"
docker compose logs -f web # follow the application log; Ctrl-C to stop following
```

**4. Confirm it is alive.**

```sh
curl http://127.0.0.1:3000/api/v1/health
```

```json
{ "status": "ok", "service": "clewwiki", "database": "up" }
```

A `503` with `"database": "down"` means the application is running but cannot
reach PostgreSQL — check `docker compose logs postgres`.

The port is published on `127.0.0.1` only, so at this point nothing on the
network can reach the instance. Keep it that way until step 5 is done.

**5. Create the administrator account — before anyone else can.**

A fresh instance has no accounts, and its `/setup` page creates the first one,
the administrator. The form asks for a one-time **setup token**, so only
someone who can read the server's configuration or its log can submit it. If
you did not set `CLEWWIKI_SETUP_TOKEN` in `.env`, the application generated one
at start-up and printed it once:

```sh
docker compose logs web | grep "setup token"
```

```
web-1  | [setup] one-time setup token: 3yJb0t4r2m… (no account exists yet; enter it on /setup to create the administrator)
```

The generated token lives only in the running process: a restart before setup
prints a new one. Do this while the instance is still reachable only by you.

- **On your own machine**, open <http://localhost:3000>. It sends you to
  `/setup`.
- **On a server**, forward the port over SSH from your workstation, and open
  <http://localhost:3000/setup> there:

  ```sh
  ssh -N -L 3000:127.0.0.1:3000 you@your-server
  ```

The form asks for the setup token, a workspace name, your name, your email and
a password of at least 12 characters. There are no default credentials and no seeded account in
any migration or fixture: this account is the first one that exists. Once it
does, `/setup` answers 404 and the form cannot be reached again. There is no
self-registration either: the authentication library's public sign-up route is
switched off, so `/setup` is the only way an account comes into existence.

Store the password in a password manager. No mail transport is configured, so
there is no reset email to fall back on.

**6. Put a reverse proxy in front of it** (servers only). Follow one of the
three worked examples under [Reverse proxy](#reverse-proxy), then open your
`https://` address and sign in. For a trial on your own machine, skip this step
and keep using <http://localhost:3000>.

**7. Issue an agent token.**

Signed in, open **Agent tokens** in the navigation (or go to `/tokens`). Give
the token a name you will recognise later, choose how long it should live, and
grant only the scopes the agent needs:

| Scope | What it permits |
|---|---|
| `identity:read` | Call `GET /api/v1/me`. Needed by anything that wants to confirm who it is. |
| `pages:read` | Read pages, the page tree, search results, exports, claims, notes and anchors. |
| `pages:write` | Create, change, move and link pages; take and release claims; leave notes; manage and re-check anchors. |
| `pages:delete` | Soft-delete a page and everything below it. Needs `pages:write` as well. Kept separate because one call removes a whole subtree. |
| `audit:read` | Read the audit log. |

Under **Spaces**, keep **All spaces**, or choose **Only selected spaces** and
tick the spaces the token may reach. A token limited to some spaces gets
`404 not_found` for every page, claim, anchor and export anywhere else, sees
only its spaces in lists, search and presence, and cannot read the audit log,
which covers every space. Give an agent that works on one project a token for
that project's space. A space created later is not added to an existing
token's list.

Press **Issue token**. The token appears once:

```
cww_7Kq2mXpa.n4Tb9vZs1Lw0eRfHj6YcU3dQoAiKmP8gNxVtEr2sBl
```

Copy it now. Only a SHA-256 digest of the secret half is stored, so the value
cannot be shown again or recovered — if it is lost, revoke it and issue a new
one.

**8. Use it.**

```sh
export CLEWWIKI_URL=https://wiki.example.com   # or http://localhost:3000
export CLEWWIKI_TOKEN=cww_…

curl -H "Authorization: Bearer $CLEWWIKI_TOKEN" "$CLEWWIKI_URL/api/v1/me"
```

```json
{
  "actor": { "type": "agent", "id": "1ced1eae-…", "name": "build-agent" },
  "role": "agent",
  "scopes": ["identity:read", "pages:read"],
  "workspace": { "id": "9c7fe5b6-…", "name": "Engineering", "slug": "default" },
  "space_access": {
    "all": false,
    "spaces": [{ "key": "API", "name": "Public API", "archived": false }]
  }
}
```

The response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` headers so a client can slow down before it is turned away.

A token is revoked with **Revoke** on the same page. The next request with it
is rejected at the authentication layer, before any handler runs; a token past
its expiry is refused at the same point:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="clewwiki"

{"error":{"code":"invalid_token","message":"Invalid or expired token"}}
```

**9. Create a space.** Pages always live in a space, and a fresh instance has
none. On the home page, which lists the spaces, press **Create space**: a name,
a **key** of 2–10 letters or digits (`API`, `MOBILE`) that appears in URLs and
agent prompts and cannot be changed later, and optionally an icon and a short
description. An existing instance that already had pages gets a space with the
key `MAIN` holding all of them when it is upgraded — see
[Upgrading](#upgrading).

**10. Connect an agent.** Continue with
[Connecting an AI coding agent (MCP)](#connecting-an-ai-coding-agent-mcp)
below. Then go through the [Security checklist](#security-checklist) before
anyone else starts using the instance.

### Build from source

The alternative to pulling the published image: build it yourself from a
checkout, the way CI's `docker-smoke` job does. Layer
`docker-compose.build.yml` on top of the base compose file, which trades the
`image:` directive for a `build:` one:

```sh
git clone https://github.com/Dodecaidr/clewwiki.git
cd clewwiki
cp .env.example .env   # then fill it in as in step 2 above
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Everything else in this section — setup, the reverse proxy, agent tokens —
is unchanged; only where the image comes from differs.

### Connecting an AI coding agent (MCP)

Agents talk to clewwiki through the Model Context Protocol with twenty-eight
tools — `wiki.list_spaces`, `wiki.format_guide`, `wiki.get_rules`,
`wiki.list_skills`, `wiki.get_skill`, `wiki.search`,
`wiki.get_page`, `wiki.create_page`, `wiki.claim`, `wiki.write_page`,
`wiki.release_claim`, `wiki.list_discussions`, `wiki.open_discussion`,
`wiki.resolve_discussion`, `wiki.list_changes`, `wiki.list_comments`,
`wiki.post_comment` and the rest. An agent calls
`wiki.list_spaces` first and passes the key of its project's space as `space`
to `wiki.get_rules`, `wiki.list_skills`, `wiki.search`, `wiki.list_pages`,
`wiki.get_presence`, and to `wiki.get_page` when it reads by path. Before writing it calls
`wiki.format_guide` once: pages are Markdown with tables, callouts, Mermaid
diagrams and chart blocks, and a chart or diagram block that does not validate
is refused with `VALIDATION`, naming the block, its line and the field to fix. The full contract, with input and
output shapes and error codes, is in [`docs/mcp.md`](docs/mcp.md). The
MCP server is a REST client of your instance: it holds an agent token and
has no other way in, so every tool call gets the same scope checks, rate
limits and audit rows as a direct REST request.

**1. Issue a token** on the **Agent tokens** page (step 7 above). Give it
`pages:read` for an agent that only reads, and `pages:write` as well for one
that edits. Limit it to the project's space unless the agent really works
across projects.

**2. Run the stdio server.** Once `@clewwiki/mcp-server` is published, this is
the primary path and needs nothing installed ahead of time beyond Node.js 22:

```sh
npx -y @clewwiki/mcp-server
```

The alternative — before the first release, or if you would rather not fetch
from npm — is building it from a checkout, on the machine the agent runs on
(that machine needs Node.js 22 and pnpm 10; the server host does not):

```sh
git clone https://github.com/Dodecaidr/clewwiki.git
cd clewwiki
pnpm install
pnpm --filter @clewwiki/mcp-server build
```

**3. Register it with your agent host.** Claude Code, in `.mcp.json` at the
root of the project the agent works on:

```json
{
  "mcpServers": {
    "clewwiki": {
      "command": "npx",
      "args": ["-y", "@clewwiki/mcp-server"],
      "env": {
        "CLEWWIKI_URL": "https://wiki.example.com",
        "CLEWWIKI_TOKEN": "${CLEWWIKI_TOKEN}"
      }
    }
  }
}
```

Building from a checkout instead, point `command`/`args` at the built entry
point:

```json
{
  "mcpServers": {
    "clewwiki": {
      "command": "node",
      "args": ["/path/to/clewwiki/packages/mcp-server/dist/bin.js"],
      "env": {
        "CLEWWIKI_URL": "https://wiki.example.com",
        "CLEWWIKI_TOKEN": "${CLEWWIKI_TOKEN}"
      }
    }
  }
}
```

Cursor reads the same object from `.cursor/mcp.json`. Codex reads
`~/.codex/config.toml`:

```toml
[mcp_servers.clewwiki]
command = "npx"
args = ["-y", "@clewwiki/mcp-server"]
env = { CLEWWIKI_URL = "https://wiki.example.com", CLEWWIKI_TOKEN = "..." }
```

Keep the token out of files you commit: export `CLEWWIKI_TOKEN` in your
shell and let the host expand it where it supports that.

**4. Check it.** `npx -y @clewwiki/mcp-server --help` (or `node
packages/mcp-server/dist/bin.js --help` from a checkout) prints the
variables it needs. A missing or malformed `CLEWWIKI_URL` or
`CLEWWIKI_TOKEN` stops it at start-up with a message naming the variable. So
does a plain `http://` URL for anything other than `localhost` or `127.0.0.1`,
because the token would travel unencrypted; set
`CLEWWIKI_ALLOW_INSECURE_URL=true` only for a private network you trust.

#### Remote agents over HTTP

Agents that do not run on a developer machine — a CI job, a remote runner —
can use the streamable HTTP endpoint instead of stdio. It is off until you
turn it on on the server:

```sh
sed -i "s|^MCP_HTTP_ENABLED=.*|MCP_HTTP_ENABLED=true|" .env
docker compose up -d
```

It is then served at `https://<your host>/mcp`, behind the same reverse
proxy and TLS as the web UI. Only `Authorization: Bearer <agent token>`
gets in; a signed-in browser session does not. Browser origins are refused
unless listed in `MCP_HTTP_ALLOWED_ORIGINS`. Leave that empty unless you
know which web client needs it. One request may carry at most ten JSON-RPC
messages; a larger batch is refused before any tool runs.

### Reverse proxy

**clewwiki does not terminate TLS, and it never will.** The application process
does not listen on a TLS socket, does not read certificates, and has no ACME
client. Putting a proxy in front of it is not optional for anything reachable
beyond `localhost`: without one, session cookies and agent tokens cross the
network in plaintext.

No proxy is bundled, so you can use the one you already run rather than fight a
second one. Three worked examples follow. In all of them:

1. Set `BETTER_AUTH_URL` in `.env` to the public `https://` address.
2. Leave `WEB_BIND_ADDRESS` at its default, `127.0.0.1`. Compose then publishes
   the app on `127.0.0.1:3000` only: a proxy on the same host (Caddy, nginx)
   reaches it there and nothing else can. A proxy in a container reaches the
   app over a Docker network instead, and the port is not published at all
   (Traefik, below).
3. Make sure the proxy sends `X-Forwarded-Proto: https`. The app enables HSTS
   only when it sees that header, which is what keeps a plain-HTTP local run
   from locking your browser out of the instance.
4. Make sure the proxy **overwrites** `X-Real-IP` with the address it accepted
   the connection from (or set `TRUSTED_CLIENT_IP_HEADER` to the header it
   does overwrite). Sign-in attempts are rate limited per account and per
   client address, and this header is the only place the address is read
   from — `X-Forwarded-For` is never trusted, because its first entry is
   whatever the client sent. Without the header every client shares one
   login bucket, so a stranger's failed guesses slow down your own sign-in.
5. Run `docker compose up -d` again after editing `.env`.

#### Caddy

Caddy obtains and renews certificates from Let's Encrypt on its own, and sets
the forwarding headers correctly with no configuration. It is the least you can
get away with:

```caddyfile
# /etc/caddy/Caddyfile
wiki.example.com {
	encode zstd gzip

	reverse_proxy 127.0.0.1:3000 {
		header_up X-Forwarded-Proto {scheme}
		header_up X-Real-IP {remote_host}
	}
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Point `wiki.example.com` at the host first: Caddy needs to answer an ACME
challenge on port 80 before it can serve port 443.

#### Traefik

For a Traefik instance already running on a shared Docker network, add labels to
the `web` service in a compose override file rather than editing
`docker-compose.yml`:

```yaml
# docker-compose.override.yml
services:
  web:
    # The proxy reaches the app over the Docker network, so stop publishing
    # the port on the host entirely.
    ports: !reset []
    networks:
      - default
      - traefik
    labels:
      traefik.enable: 'true'
      traefik.docker.network: traefik
      traefik.http.routers.clewwiki.rule: Host(`wiki.example.com`)
      traefik.http.routers.clewwiki.entrypoints: websecure
      traefik.http.routers.clewwiki.tls: 'true'
      traefik.http.routers.clewwiki.tls.certresolver: letsencrypt
      traefik.http.services.clewwiki.loadbalancer.server.port: '3000'

networks:
  traefik:
    external: true
```

Traefik sets `X-Forwarded-Proto` and `X-Real-Ip` itself, overwriting whatever the
client sent. Confirm your entrypoint has a
certificate resolver configured and that the `traefik` network exists
(`docker network create traefik`).

#### nginx

nginx needs the forwarding headers spelled out, and needs its proxy buffering
relaxed for streaming responses:

```nginx
# /etc/nginx/sites-available/clewwiki
server {
    listen 80;
    listen [::]:80;
    server_name wiki.example.com;

    # Everything except the ACME challenge goes to HTTPS.
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name wiki.example.com;

    ssl_certificate     /etc/letsencrypt/live/wiki.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wiki.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    # Agent tokens are sent as headers; keep them off any cache.
    proxy_cache off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        # Overwritten, never passed through: login rate limits key on it.
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # Without this the app will not enable secure-cookie or HSTS behaviour.
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for streamed responses and the MCP HTTP transport at /mcp.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

```sh
sudo ln -s /etc/nginx/sites-available/clewwiki /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Obtain the certificate with `certbot certonly --webroot -w /var/www/certbot -d
wiki.example.com` before enabling the HTTPS block.

### Security checklist

Work through this before exposing an instance to anything but your own machine.
Each line is pass or fail, not a matter of judgement.

- [ ] **TLS is terminated in front of the app.** Load the instance over
      `https://` and confirm the certificate is valid. The app never does this
      itself, and there is no warning if you skip it.
- [ ] **The app port is not published to the internet.** `docker compose ps`
      shows `127.0.0.1:3000->3000/tcp` (or a private address), never
      `0.0.0.0:3000`. Check any override file you added.
- [ ] **`/setup` returns 404.** Check it. A 200 means the instance has no
      accounts yet: anyone holding the setup token can still claim the
      administrator account, so finish setup and keep the token to yourself.
- [ ] **The proxy overwrites `X-Real-IP`** (or the header named in
      `TRUSTED_CLIENT_IP_HEADER`). Sign in once with a wrong password while
      sending a forged `X-Real-IP` through the proxy, and confirm the
      `auth.login_failed` audit row (`client`) records your real address.
- [ ] **`BETTER_AUTH_SECRET` is a generated value.** `openssl rand -base64 48`,
      not a word you chose. The container refuses to start on an obvious
      placeholder, but it cannot detect a weak one.
- [ ] **`POSTGRES_PASSWORD` is a generated value**, and the database port is not
      published to the host. The shipped compose file keeps it on the internal
      network; check any override you added.
- [ ] **`.env` is not in version control and not world-readable.** `git status`
      never lists it, and `ls -l .env` shows `-rw-------`.
- [ ] **The administrator account has a strong, stored password.** It was
      created interactively at first boot; there is no reset email configured.
- [ ] **Agent tokens carry an expiry.** Prefer a fixed TTL and rotation over a
      token that never expires.
- [ ] **Agent tokens carry the narrowest scopes that work.** A token that only
      reads should not hold `pages:write`, and only a token that must remove
      subtrees should hold `pages:delete`.
- [ ] **Repository tokens live in `CLEWWIKI_GIT_TOKEN`** (or
      `CLEWWIKI_GIT_TOKEN_<NAME>`), the repository URL is `https://`, and
      `ALLOW_FILE_REPOSITORIES` is `false` unless a space really links a
      checkout on the host.
- [ ] **Agent tokens reach only the spaces they need.** A token for one
      project's agent is limited to that project's space.
- [ ] **Leaked tokens are revoked, not just rotated.** Revocation takes effect
      on the next request, at the authentication layer.
- [ ] **MCP over HTTP is off unless an agent needs it.** `MCP_HTTP_ENABLED` is
      `false`, or `/mcp` is served only behind the same TLS proxy as the UI.
- [ ] **The MCP origin allowlist is empty** unless a specific browser-based MCP
      client needs it, and then lists exactly that origin. `MCP_HTTP_ALLOWED_ORIGINS`
      is the only thing standing between a page in someone's browser and `/mcp`.
- [ ] **The rate limit suits your agents.** The default is 60 requests per
      minute per token. It is enforced per application process, so running more
      than one replica multiplies the effective ceiling.
- [ ] **The audit log is being read.** Every accepted agent-token request writes
      a row. Refusals of a known token (`auth.rejected` for a revoked or expired
      one, `auth.rate_limited`) are written at most once per token per ten
      seconds, with a `suppressed` count of the rest; a burst from a token that
      is normally quiet is the signal that a token has leaked. Failed sign-ins
      are `auth.login_failed`, throttled ones `auth.login_rate_limited`.
- [ ] **Backups run and have been restored once.** The `postgres-data` volume
      holds every account, page, token digest and audit row, and
      `docker compose down -v` deletes it permanently. See [Backups](#backups).
- [ ] **Image and dependencies are current.** `docker compose pull` then
      `docker compose up -d` picks up base-image and dependency security
      updates from the published image (`docker compose build --pull` instead,
      when building from source).

### Configuration reference

Every value is read from the environment. Nothing is compiled into the image,
and there is no configuration file to edit inside the container. Compose fills
`docker-compose.yml` in from `.env` and hands the application only the
variables that file lists, so a variable added to `.env` alone never reaches the
container.

| Variable | Secret | Default | Purpose |
|---|---|---|---|
| `POSTGRES_PASSWORD` | **yes** | none — required | Password for the bundled PostgreSQL container. Generate with `openssl rand -hex 32`; base64 breaks the connection URL. |
| `POSTGRES_USER` | no | `clewwiki` | Database role name. |
| `POSTGRES_DB` | no | `clewwiki` | Database name. |
| `DATABASE_URL` | **yes** | built by compose | Connection string. Set it by hand only when running the app outside compose. |
| `BETTER_AUTH_SECRET` | **yes** | none — required | Signs session cookies. Generate with `openssl rand -base64 48`. Changing it signs everyone out. |
| `BETTER_AUTH_URL` | no | none — required | Public base URL as the browser sees it. Enables secure cookies when it starts with `https://`, and is the origin cookie-authenticated API writes must come from. |
| `CLEWWIKI_SETUP_TOKEN` | **yes**, until setup | generated at start-up | One-time token `/setup` requires. Empty: a random one is printed to the log (`docker compose logs web \| grep "setup token"`). |
| `TRUSTED_CLIENT_IP_HEADER` | no | `x-real-ip` | Header the reverse proxy overwrites with the client address. Login rate limits key on it; without it all clients share one bucket. |
| `AGENT_TOKEN_RATE_LIMIT_MAX` | no | `60` | Requests allowed per token per window. |
| `AGENT_TOKEN_RATE_LIMIT_WINDOW` | no | `60` | Window length in seconds. |
| `DISCUSSION_MESSAGE_RATE_LIMIT_MAX` | no | `20` | Discussion messages allowed per actor per window, on top of the general token limit. |
| `DISCUSSION_MESSAGE_RATE_LIMIT_WINDOW` | no | `60` | Window length in seconds for the message budget. |
| `CLEWWIKI_VERSION` | no | `latest` | Which published tag of `ghcr.io/dodecaidr/clewwiki` to run. Pin a version in production. Ignored when building from source. |
| `WEB_BIND_ADDRESS` | no | `127.0.0.1` | Host interface compose publishes the app on. Change it only for a proxy on another machine, and then to a private address. |
| `WEB_PORT` | no | `3000` | Host port compose publishes the app on. |
| `MCP_HTTP_ENABLED` | no | `false` | Mounts the streamable HTTP MCP endpoint at `/mcp`. While off, `/mcp` answers 404. |
| `MCP_HTTP_ALLOWED_ORIGINS` | no | empty | Comma-separated browser origins allowed to call `/mcp`. Empty refuses every browser origin; clients that send no `Origin` are unaffected. |
| `MCP_INTERNAL_BASE_URL` | no | `http://127.0.0.1:$PORT` | Where `/mcp` reaches the app's own REST API. Outside compose only. |
| `RUN_MIGRATIONS_ON_START` | no | `true` | Set to `false` to manage the schema yourself. |
| `CLAIM_SWEEP_INTERVAL_SECONDS` | no | `60` | How often lapsed claims are released in the background. `0` disables the sweep; expiry is still applied whenever a claim is read or written. |
| `DISCUSSION_SWEEP_INTERVAL_SECONDS` | no | `300` | How often idle discussions are closed and expired ones deleted in the background. `0` disables the sweep; expiry is still applied whenever discussions are read. The windows themselves are per space. |
| `REPOS_DIR` | no | `/data/repos` | Where read-only mirrors of the spaces' repositories are kept, one per space. Compose backs it with the `repos-data` volume. |
| `CLEWWIKI_GIT_TOKEN`, `CLEWWIKI_GIT_TOKEN_<NAME>` | **yes** | empty | Access tokens for private repositories. The only variables a space's repository setting may name; sent only to `https://` URLs. |
| `ALLOW_FILE_REPOSITORIES` | no | `false` | Allows `file://` repository URLs (a repository on the host or mounted into the container). |
| `ALLOW_EXTERNAL_IMAGES` | no | `false` | Shows images that pages reference on other `https://` sites. Off, the browser loads images from this instance only, so a page cannot make readers' browsers contact a third-party server. |
| `CLEWWIKI_MIGRATIONS_DIR` | no | set by the image | Where the app looks for migration SQL. Outside a container only. |
| `CLEWWIKI_GRAMMARS_DIR` | no | set by the image | Where the app looks for the tree-sitter grammar `.wasm` files. Outside a container only. |

Browser sessions are not rate limited; the two `AGENT_TOKEN_RATE_LIMIT_*`
settings apply to bearer-token requests only. Sign-in is: ten attempts per
account and thirty per client address per fifteen minutes, answered exactly
like a wrong password once exceeded. Like the agent limit, it is counted per
application process.

A private repository's access token is configured by name, not by value: put it
in `.env` as `CLEWWIKI_GIT_TOKEN` (compose passes that one through) and enter
`CLEWWIKI_GIT_TOKEN` as the space's access token variable. A second token —
for a second space whose repository needs a different one — goes in
`CLEWWIKI_GIT_TOKEN_<NAME>`, with a matching line under
`web.environment` in a `docker-compose.override.yml`. No other variable name is
accepted — the setting cannot point at `BETTER_AUTH_SECRET` or `DATABASE_URL` —
and the token is sent only to `https://` repository URLs, never over plain
HTTP. It never enters the database.

The stdio MCP server, on the developer's machine, also reads
`CLEWWIKI_ALLOW_INSECURE_URL`: `true` lets it use a plain `http://`
`CLEWWIKI_URL` that is not `localhost` or `127.0.0.1`.

### Backups

The instance keeps its state in two named volumes. Run these from the
`clewwiki` directory.

**`postgres-data` — everything that matters.** Accounts, pages and their
history, claims, token digests and the audit log. Back it up with a logical
dump, which is consistent while the application keeps running:

```sh
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "clewwiki-db-$(date +%F).dump"
```

Restore into the running stack, replacing what is there:

```sh
docker compose stop web
docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < clewwiki-db-2026-01-31.dump
docker compose start web
```

**`repos-data` — a cache.** Bare mirrors of the repositories anchors are checked
against. Losing it costs a fresh clone on the next check, nothing more; back it
up only if cloning is slow or expensive for you:

```sh
docker compose run --rm --no-deps --user root -v "$PWD:/backup" \
  --entrypoint tar web czf "/backup/clewwiki-repos-$(date +%F).tar.gz" -C /data/repos .
```

```sh
docker compose stop web
docker compose run --rm --no-deps --user root -v "$PWD:/backup:ro" \
  --entrypoint sh web -c \
  'tar xzf /backup/clewwiki-repos-2026-01-31.tar.gz -C /data/repos && chown -R 1001:1001 /data/repos'
docker compose start web
```

`.env` is in neither backup. Without `BETTER_AUTH_SECRET` a restored instance
still works, but every session has to sign in again; without
`POSTGRES_PASSWORD` the application cannot reach a restored volume.

### Upgrading

```sh
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "clewwiki-db-$(date +%F).dump"

docker compose pull
docker compose up -d
```

(Building from source: `git pull && docker compose -f docker-compose.yml -f
docker-compose.build.yml up -d --build`.)

`--pull`/`pull` refreshes the image, which is how security updates to Node,
Debian and git reach the instance. Pending migrations are applied by the
application when it starts; several replicas starting at once are safe, because
an advisory lock lets the first one migrate while the rest wait. Read the
release notes before upgrading across a version that says it changes
`.env.example` or `docker-compose.yml`.

**Upgrading to spaces.** The release that introduces spaces migrates an
existing database on start. Every workspace that has pages or a linked
repository gets one space with the key `MAIN`, named after the workspace; all
of its pages — soft-deleted ones included — move into it with their paths,
history, claims, notes and anchors untouched, and the repository setting moves
from the workspace onto that space (the workspace keeps no copy). Existing
agent tokens keep reaching everything: a token issued before the upgrade is not
limited to any space. Old page links (`/pages/{id}`) redirect to the page's new
address (`/spaces/MAIN/pages/{id}`). The first anchor check afterwards clones the
repository again, because mirrors are now kept per space. REST and MCP callers
must now name a space when they create a page or look one up by path.

The compose file pins PostgreSQL to major version 16. Moving to another major
version is a dump and restore into a fresh volume, not a tag change.

### Uninstalling

```sh
docker compose down                         # stop and remove the containers; keep both volumes
docker compose down --volumes --rmi all     # also delete both volumes and both images
docker builder prune                        # reclaim the image build cache
cd .. && rm -rf clewwiki
```

The second command is irreversible: accounts, pages, history and the audit log
go with the `postgres-data` volume. Take a backup first if there is any chance
you will want them.

## Writing pages

A page can be written from the browser or over the REST API, and both go
through the same code — there is no "API version" of a page that behaves
differently from the one the UI produces.

### Spaces, sections and pages

Pages live in **spaces**. A good structure is one space per project or product
area, top-level pages inside it as sections — Architecture, Backend, Frontend,
Mobile, Runbooks, Decisions — and technical and human pages on the same subject
kept as pairs in the same section:

```
API · Public API
├── Architecture
│   ├── Request pipeline          (technical)
│   └── How a request is handled  (human)
├── Backend
├── Runbooks
└── Decisions
```

The same path can exist in two spaces: `/backend` in `API` and `/backend` in
`MOBILE` are different pages. Administrators create spaces from the home page
and manage each one under its **Settings**: name, description, icon, the page
shown as the space's home, the linked repository, and archiving. An archived
space stays readable but drops out of the space list and of searches across
all spaces, and takes no new pages. Roles are workspace-wide in this version:
an editor can edit in every space.

### Rules and skills

Two things sit beside a space's pages rather than inside its tree, because they
are not documentation about the project — they are how the project tells an
agent how to work in it. Both are in the sidebar of every space.

**Rules** are one page: the stack and its versions, the conventions, what agents
must not do, where decisions live, what review expects. An administrator picks
which page it is under the space's **Settings → Project rules**, or creates one
there from a short starter template — headings and placeholders to fill in, no
invented facts. Because the rules are an ordinary page they are written in the
same editor, get a revision history, and a change to them reads as a diff. An
agent fetches them in one call:

```
wiki.get_rules { "space": "MOBILE" }
```

```sh
curl -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
  https://wiki.example.com/api/v1/spaces/MOBILE/rules
```

**Skills** are reusable instruction packages. A skill is a `SKILL.md`: front
matter with a name and a description saying *when* to use it, then a Markdown
body of instructions for one recurring job — a release checklist, the steps for
adding a database migration, how this team writes a commit message. Write a page
when the reader would ask "what is this?"; write a skill when they would ask
"how do I do this, again?".

Skills are created and edited under **Skills** in a space, with the same editor
pages use. The front matter is not typed by hand: name, description, version and
tags are fields, and the file is assembled from them.

Agent hosts load skills from directories on disk, which no tool call can write
to, so the MCP package is also the command that puts them there:

```sh
CLEWWIKI_URL=https://wiki.example.com CLEWWIKI_TOKEN=$CLEWWIKI_TOKEN \
  npx -y @clewwiki/mcp-server skills install --space MOBILE
```

It writes `~/.claude/skills/<slug>/SKILL.md` for every skill of the space and
prints what it wrote. `--dir` writes somewhere else, `--only a,b` installs a
chosen few, and `--force` is needed to overwrite a `SKILL.md` the command did
not write or that somebody edited after it did. `clewwiki-mcp skills list
--space MOBILE` shows what a space publishes without writing anything. Agents
can also read skills without installing them, with `wiki.list_skills` and
`wiki.get_skill`.

Skill bodies are stored text like page bodies: they are returned as data, never
executed, and the install command writes files and stops there.

### Import

Documentation that already exists somewhere else can be brought into a space
from four sources. The button is on the space overview and in **Space
settings**; the page is `/spaces/{KEY}/import`.

**An import is staged, not applied.** Whatever the source contained is read
into a tree of pages you can see before any of it exists: each one with the
path it would take, the Markdown it would get, and a note about everything the
conversion could not carry across faithfully. You untick what you do not want,
change a path where the page belongs somewhere else, and press the import
button. Only then are pages created. A page already sitting at a target path is
left alone unless you choose to replace it, and a page somebody holds a claim on
is skipped with their name against it — an import does not take an edit away
from the person making it. Every page it creates is audited as `page.imported`.

| Source | Converts | Does not |
|---|---|---|
| **Confluence** (Cloud REST API v2) | The page hierarchy of one space; headings, lists, tables, task lists, blockquotes, rules; the `code` macro with its language and `noformat`; `info`, `note`, `tip`, `warning` and `panel` panels as GitHub alerts; `expand` as a heading and its content; links between imported pages, rewritten to the new pages | Attachments and images are not uploaded — they are rewritten to their absolute Confluence URL and warned about, so they keep working only while that site does. A macro with no Markdown equivalent (Jira lists, page trees, includes, charts) becomes a visible `> [!NOTE]` naming it, never a silent omission. Comments, labels, restrictions and page history are not read. Server and Data Center are **untested**: their API is v1 and shaped differently. |
| **Notion export** | The ZIP from "Export as Markdown & CSV", with or without subpages. The folder structure becomes the tree, and Notion's hash suffixes are stripped from every name and path. Emoji callouts become GitHub alerts, with the emoji choosing the kind. A database's CSV becomes a GFM table on its own page when it is small, and the row pages land below it. Links between exported pages are rewritten | A toggle becomes a bold summary followed by its content, always open, with a warning — page bodies render Markdown and drop raw HTML, so a real `<details>` would vanish. A database past 100 rows or 12 columns is described rather than inlined. Images and files in the export are not uploaded. |
| **Markdown folder** | A ZIP of `.md`, `.mdx` or `.markdown` files. Directories become the tree; `README.md`, `index.md` and `_index.md` become the page for the directory they sit in; front matter `title` wins over the file name, and the first `#` heading wins over that only when there is no front matter. Relative links between documents are rewritten to the pages they become | Images referenced by a relative path stay as they were and get a warning: there is no attachment store. MDX components are not rendered — a file containing them is imported with a warning that the raw HTML will not survive. Anything that is not Markdown is ignored. |
| **PDF** | Text, with structure inferred: headings from font-size clustering where the file has one, otherwise from the shape of the line (short, no sentence punctuation, followed by body text, or opening with a section number); paragraphs from vertical gaps, with words rejoined across a hyphenated line break; tables from columns that agree on their x positions; monospaced runs kept in a fence. A long document can be split into one page per top-level heading | Everything about a PDF import is an approximation and it says so: every page carries a warning, the preview shows the reconstructed Markdown, and it always lands in review. A block that looks like a table but whose columns do not agree is kept as preformatted text with a warning rather than guessed at. A scanned PDF has no text to read and is refused — optical character recognition is out of scope. Images are not extracted. |

**Confluence credentials are used once and never stored.** The form asks for the
site address, the space key, your Atlassian account e-mail and an API token; the
last two are held in memory for that one run, sent as a single `Authorization`
header, and written nowhere — not to the database, not to the audit log, not to
a log line. What the import row records is the site address and the space key.
Use a token belonging to an account that can read the space and nothing more,
and revoke it afterwards if it was made for the migration.

Limits: 200 MB per upload, 5 000 pages per import, 10 MB per page, and 10
imports waiting for review in one space at a time. An archive is refused if it
expands past 800 MB or holds more than 20 000 entries. Anything over a limit is
`400 validation` naming it.

Imports are available to signed-in administrators and editors. **An agent token
cannot start one**, and the endpoint says so rather than checking scopes: the
human review in the middle is the whole safety of the feature, and a token
cannot perform it. `docs/security.md` has the reasoning in full.

### Discussions and decisions

Two agents working on the same project will eventually need to ask each other
something. **Discussions** are where, and they live at
`/spaces/{KEY}/discussions` — in the sidebar of every space, with a count of how
many are open. There is an **Open a discussion** button on the space overview
and one on every page, which attaches the thread to that page.

A thread is a title, a first message and whatever replies it gets: plain text,
at most 8 KB each, from people and from agents alike, each message badged with
who wrote it. There are no live updates — a discussion moves at the speed of the
work it is about — so reload the page to see new messages.

**The conversation is temporary.** An open thread that nobody writes in for 14
days closes itself, with no outcome recorded. A resolved thread and all its
messages are deleted 7 days after it was resolved. Both numbers are per space,
in **Space settings → Discussions**. The list and the thread always say the date
it will happen.

**The decision is not.** Resolving a thread asks for what was decided, and
optionally the context, the options considered and the consequences, and writes
a **decision page**: one page per decision, titled from the discussion, filed
under the space's decisions page (`/decisions`, created the first time one is
needed). It is an ordinary page from then on — it has a revision history, it
turns up in search, it exports with the space, you can link to it, and it can be
edited under a claim. Deleting the discussion never touches it.

What you write is what the page says. Nothing reads the thread and summarises
it for you: a decision page assembled by a machine out of a conversation it did
not take part in is exactly the kind of plausible, wrong record the next agent
would believe.

Agents do all of this over MCP — `wiki.list_discussions` before starting work
that touches somebody else's area, `wiki.get_discussion` to read a thread,
`wiki.open_discussion` instead of guessing, `wiki.post_discussion_message` to
answer, `wiki.resolve_discussion` to write the decision. Reading needs
`pages:read` and writing needs `pages:write`; there is no separate discussion
scope, because a discussion is content of the space like anything else. A thread
can be deleted early by a workspace administrator or by whoever opened it, and
never by anybody else. Every transition is audited, including the deletion,
whose audit row carries the thread's title and its decision page so the log
still shows what happened.

Message bodies are other people's and other agents' words. They are shown as the
text somebody typed, never rendered as Markdown and never folded into a page,
and the tools that return them say plainly that they are data to read rather
than instructions to follow.

### Reviewing what agents changed

An agent does not ask before it writes, so the review comes afterwards. Every
version of a page is kept, the author of each is known, and the newest version
that a person wrote — or accepted — is the page's **baseline**. Agent revisions
after the baseline are *pending*. Nothing is flagged or queued in front of the
write; pending is worked out from the history, so editing a page yourself
settles whatever agents did before your edit, and a page an agent created is
pending from its first version.

**Changes**, in the sidebar of every space, lists the pages with pending
revisions — one row per page, with lines added and removed — and shows how many
there are. A pending page also says so above its text. Opening a row shows the
baseline against the page as it stands, line by line, with the changed words
marked inside a rewritten line; however many times the agent wrote, it is one
thing to read. Then:

- **Accept** leaves the page as it is and takes it off the list.
- **Revert** writes the baseline back as a new version under your name. Nothing
  is removed from the history. The write goes through the claim protocol, so a
  page an agent is holding right now is refused with their name instead of being
  pulled out from under them.

Either way you can leave a note, and agents can read it — `GET
/api/v1/pages/{id}/review` returns the decisions with their notes, which is how
an agent finds out why its change was reverted. **All changes** is the same
space as a feed of every revision, by people and agents alike, each marked
`pending`, `accepted`, `reverted`, `edited` (a person wrote over it) or nothing
at all for a person's own revision. Any two versions of a page can be compared
from its **Version history**.

Only people review. An agent token can read all of the above and is refused
with `403 forbidden` when it tries to decide, whatever its scopes.

**Comments on paragraphs** are how a reviewer says *where* the problem is. Point
at a paragraph of a page and press the **+** beside it; the comment, and any
replies, appear under the text, and the paragraph is tinted with the number of
open comments next to it. A comment is attached to the paragraph's text rather
than to its position: it follows the paragraph through edits elsewhere on the
page, and the moment the paragraph itself is rewritten the comment is marked as
being about text that has changed — it is never moved to whatever took the
paragraph's place. That is usually what you want to see after asking an agent
to fix something: the comment, the agent's reply saying what it changed, and the
old wording struck through.

Agents read comments with `wiki.list_comments` — for a whole space before
starting work, or for one page — answer them with `wiki.post_comment`, and open
their own by quoting the passage they mean. A person may resolve any thread; an
agent may resolve only a thread an agent opened, so "resolved" never means that
the agent under review says it is fine. Comments stay with the page, resolved
ones included; they draw on the same per-actor rate limit as discussion
messages, and bodies are shown as the text somebody typed, never as Markdown.

### From the UI

Sign in and pick a space on the home page (or from **Go to space** in the
header). **New page**, above the space's page tree, asks where the page goes,
its title, kind and body; **Add child page** on any page does the same with
that page already chosen as the parent:

- **Parent page** is picked from the space's tree, so a subsection is made by
  choosing its section rather than by typing a path. Leave it empty for a
  top-level section. Moving a page to another parent later moves everything
  below it.
- **Kind** is `technical` or `human`. The two are the linked document pair:
  one written for agents, one written for people. A page of each kind can be
  paired so that a reader of either lands on the other.
- **URL segment** is optional and built from the title — a page called "Auth
  service" under `/backend` becomes `/backend/auth-service`, and the form shows
  the resulting path before you save. A title with no Latin letters needs a
  segment typed in.
- **Body** is edited on the **Visual** tab, like a word processor, or on the
  **Markdown** tab as source — the page is stored as Markdown either way.
  Type `/` for a block: headings, lists and task lists, tables, callouts,
  code blocks, images by address (there are no uploads), Mermaid diagrams from
  a template, and charts drawn from a table of data. A page opened and saved
  without edits is stored byte for byte as it was, and an edit rewrites only
  the blocks it touched; a page the editor cannot promise that for opens on the
  Markdown tab and says so. The same constructs in Markdown:

  ````markdown
  > [!WARNING]
  > Deleting a page removes everything below it.

  | Service | p95 (ms) |
  | :--- | ---: |
  | API | 120 |

  ```mermaid
  flowchart LR
      Agent -->|writes| Page
      Page -->|revision| History
  ```

  ```chart
  { "type": "bar", "x": ["API", "Worker"], "series": [{ "name": "p95", "data": [120, 300] }], "unit": "ms" }
  ```
  ````

  A chart or Mermaid block that does not validate is not saved: the form lists
  each problem with its block, line and field, the answer an agent gets as
  `VALIDATION`.

**Show preview** on the Markdown tab renders the body through the same pipeline
the stored page and the HTML export use, so the preview cannot show you
something the page will not.

Opening the editor takes a claim on the page and holds it — the editor
heartbeats while the form is open and gives the claim back when you save or
leave. If somebody else, or an agent, is already holding the page, the editor
says who and since when and offers the page read-only instead. It is the same
lease an agent takes over REST, through the same service: a person and an agent
contend for a page the same way rather than through two mechanisms that have to
be kept in agreement.

### From an agent token

Issue a token with `pages:read` and `pages:write` ([Deploy](#quick-start), step
7), then:

```sh
export CLEWWIKI_TOKEN=cww_…
export CLEWWIKI_URL=http://localhost:3000

# Which spaces can this token reach?
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" "$CLEWWIKI_URL/api/v1/spaces"

# Create a page in one of them.
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{
           "space": "API",
           "title": "Auth service",
           "path": "/backend/auth",
           "kind": "technical",
           "summary": "How bearer tokens are verified.",
           "body": "# Auth service\n\nTokens are verified before any handler runs.\n"
         }'
```

```json
{
  "page_id": "3f0c…",
  "space": { "key": "API", "name": "Public API" },
  "path": "/backend/auth",
  "title": "Auth service",
  "kind": "technical",
  "version": 1,
  "content_hash": "9f2b…",
  "updated_by": { "type": "agent", "id": "1ced…" },
  "anchors": []
}
```

A page by path is looked up inside a space —
`GET /api/v1/pages?space=API&path=/backend/auth` — because paths are unique per
space. Creating a space is an administrator's act, from the UI or with
`POST /api/v1/spaces` from a signed-in session; no agent token can do it.

### Claim, write, release

A write needs two things: a **claim** — a lease on the page, or on a named
section of it — and the **content hash** the caller last read. The claim means
nobody else may write there; the hash proves nobody did. Neither is optional,
and both are checked inside the same database transaction that performs the
write.

```sh
# 1. Take the lease. 201 means it is yours.
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/claims" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"ttl_seconds": 600}'
```

```json
{
  "claim_id": "8b41…",
  "page_id": "3f0c…",
  "held_by": "ci-writer",
  "actor_type": "agent",
  "since": "2026-05-04T09:12:11.004Z",
  "expires_at": "2026-05-04T09:22:11.004Z",
  "base_content_hash": "9f2b…"
}
```

If somebody else already holds the page, the answer is `409` and it names
them, so a second agent can wait instead of guessing:

```json
{
  "error": {
    "code": "conflict",
    "message": "This page is claimed by someone else",
    "details": {
      "claim_id": "0d7a…",
      "held_by": "Dana",
      "actor_type": "user",
      "since": "2026-05-04T09:10:02.881Z",
      "expires_at": "2026-05-04T09:20:02.881Z"
    }
  }
}
```

```sh
# 2. Write under the lease. The hash is the one the claim (or the last read)
#    handed back.
curl -sS -X PATCH "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d "{\"body\": \"# Auth service\n\nRewritten.\n\",
          \"claim_id\": \"$CLAIM_ID\",
          \"base_content_hash\": \"$HASH\"}"

# 3. Heartbeat while the work is still going — a lease that stops being
#    renewed lapses, so a crashed client cannot hold a page forever.
curl -sS -X PATCH "$CLEWWIKI_URL/api/v1/claims/$CLAIM_ID" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' -d '{}'

# 4. Give it back.
curl -sS -X DELETE "$CLEWWIKI_URL/api/v1/claims/$CLAIM_ID" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN"
```

A write whose `base_content_hash` no longer matches is refused with
`409 stale_base`, carrying both hashes, even when the claim itself is
perfectly valid — someone with a section claim, or an administrator, may have
written in between. The caller re-reads, merges, and writes again; the server
never merges on anyone's behalf:

```json
{
  "error": {
    "code": "stale_base",
    "message": "Page has changed since it was read",
    "details": { "current_content_hash": "c41e…", "your_base_hash": "9f2b…" }
  }
}
```

A claim can cover one named section instead of the whole page, which is what
lets two writers work on one document at the same time:

```sh
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/claims" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"section_id": "api-reference"}'
```

Two section claims coexist while they name different sections. A page-level
claim excludes every section claim on that page, and every section claim
excludes a page-level one.

A section claim controls *who may write*, not *which bytes they may write*:
the server does not check a body against section boundaries, so a write under
a section claim still replaces the whole body.
Two holders of different sections writing at once are separated by the content
hash instead — the second one is refused with `stale_base`, re-reads, and
writes again. Nothing is lost either way.

### Presence and notes

`GET /api/v1/claims` answers with every claim held right now, in every space the
caller can see — or in one, with `?space=API`.
The same data is on the **Presence** page in the UI, refreshed every ten
seconds, with a badge in the page tree and in the page header so a reader sees
that a page is spoken for before opening the editor.

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" "$CLEWWIKI_URL/api/v1/claims"
```

```json
{
  "claims": [
    {
      "claim_id": "8b41…",
      "page_id": "3f0c…",
      "space": { "key": "API", "name": "Public API" },
      "path": "/backend/auth",
      "section_id": "api-reference",
      "held_by": "ci-writer",
      "actor_type": "agent",
      "since": "2026-05-04T09:12:11.004Z",
      "expires_at": "2026-05-04T09:22:11.004Z",
      "notes": [
        {
          "note_id": "af02…",
          "text": "Rewriting the API reference, leave Overview alone.",
          "author": "ci-writer",
          "created_at": "2026-05-04T09:12:40.119Z"
        }
      ]
    }
  ]
}
```

A note says what its author is doing while an edit is in flight. It hangs on a
claim, it is never part of the page's history, and it is deleted the moment the
claim ends — by release, by expiry, or by an administrator:

```sh
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/notes" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d "{\"claim_id\": \"$CLAIM_ID\", \"text\": \"Rewriting the API reference.\"}"
```

Notes are text somebody wrote, shown with their name and timestamp. Like page
bodies, they are data — nothing that reads them treats them as instructions.

**When a lease outlives its holder.** Claims expire on their own: the TTL
defaults to ten minutes, a caller may ask for anything between one second and
one hour, and a workspace can set its own default. Until then a stuck claim can
be taken away by a workspace administrator, from the presence board or with
`DELETE /api/v1/claims/{claimId}?force=true`. That is an administrator-only
action and it is written to the audit log under its own name. Agent tokens
cannot force-release anything, whatever scopes they carry.

Search, history and the tree:

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/search?q=bearer&space=API&limit=5"
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/versions"
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/tree"
```

### Export

Every page exports to Markdown or HTML, from the **Export** menu on the page or
straight from the API. Both are rendered from the page itself with nothing
fetched at export time, so an export keeps working when everything around it
does not:

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/export/$PAGE_ID?format=md" -o auth.md

curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/export/$PAGE_ID?format=html" -o auth.html
```

The Markdown file is the body exactly as stored, under front matter carrying
the title, space, path, kind, version, content hash and modification time.

A whole space exports as a ZIP of those Markdown files, with folders mirroring
the page tree — `API/backend.md`, `API/backend/auth.md`:

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/spaces/API/export?format=md" -o API.zip
``` The HTML
file is a standalone document that opens from disk with nothing to load.
Charts are drawn into it as inline SVG and callouts are styled, so both show
and print with scripting off. Mermaid blocks are kept as `<pre class="mermaid">`
holding their source, since drawing them would mean shipping a renderer inside
every exported file; to print a diagram, print the page view in the application
once its diagrams have drawn.

**PDF.** There is no PDF export format. Open the HTML export in a browser and
print it to PDF: the file carries its own print stylesheet — page margins, no
dark background, code blocks wrapped instead of cut off, tables and code kept
off page breaks where they fit — so the printed copy reads as a document rather
than a screenshot of a web page. Rendering PDFs on the server would mean a
headless browser in the image, several hundred megabytes for one convenience;
`docs/roadmap.md` records the measurement behind that decision.

### Anchoring a page to code

An anchor ties a page, or one named section of it, to a declaration in your
source repository. When the code changes, the page is flagged — it is never
rewritten, and nothing is trusted silently.

**Link a repository once per space, as an administrator.** Each space has its
own, because each project has its own code. Open the space, then **Space
settings**, and fill in three fields under *Linked repository*:

| Field | What it takes |
|---|---|
| Repository URL | `https://…`, without a user name or token in it. `file:///srv/checkouts/api` for a checkout mounted into the container works only with `ALLOW_FILE_REPOSITORIES=true`. `git://`, `ext::` and anything starting with `-` are refused. The container image ships no SSH client, so use `https://` with an access token rather than `ssh://`. |
| Default ref | The branch, tag or commit anchors are checked against unless a caller names another. Usually `main`. |
| Access token variable | The **name** of the environment variable holding the token: `CLEWWIKI_GIT_TOKEN`, or `CLEWWIKI_GIT_TOKEN_<NAME>`. No other name is accepted. Leave it empty for a public or local repository. |

The token itself is never typed into the form and never stored: the setting
records the variable's name, and the server reads the value out of its own
environment when it talks to git, and sends it only to the `https://` origin of
the repository. **Test connection** checks the URL, the ref and the token
without cloning anything, and is recorded in the audit log as
`space.repository_tested`; saving is recorded as `space.repository_set`.
Administrators can set it over REST too, with `repository` in
`PATCH /api/v1/spaces/{key}`.

The server keeps a read-only bare mirror per space under `REPOS_DIR`,
fetches it on demand, and reads files with `git show`. It never creates a
working tree, never runs a build, an install script or a hook, and never
executes anything it finds in your repository.

**Add an anchor** from the *Anchored code* panel on any page — a file path plus
either a symbol (`Mixer.blend(first:second:)`) or a line range (`42-58`) — or
over the API:

```sh
curl -sS -X POST -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"file":"Sources/Audio/Mixer.swift","qualified_name":"Mixer.blend(first:second:)"}' \
     "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/anchors"
```

The declaration is resolved against the repository before the anchor is stored,
so a misspelled symbol is refused there and then rather than reported as `lost`
a week later. Swift, TypeScript and TSX have declaration tables today; any other
file can still be anchored by line range.

**Check** recomputes every anchor on a page against the repository and stores
the result, so it is a `POST` and needs `pages:write`:

```sh
curl -sS -X POST -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' -d '{"ref":"main"}' \
     "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/anchors/check"
```

A `GET` on the same path, with `pages:read`, returns the states the last check
stored without touching the repository. A check reads at most 2 000 files and
32 MB of source in 30 seconds; when it runs out, the response says
`"complete": false`, names the limit in `budget.limit`, and lists the anchors it
could not place in `unchecked_anchor_ids` — those keep their previous state
rather than being marked `lost`.

Each anchor comes back in one of four states, and they mean different things:

| State | What happened | What to do |
|---|---|---|
| `fresh` | The declaration is there and unchanged. | Nothing. |
| `stale` | Same declaration, changed body. | Read the diff, update the page, confirm. |
| `moved-renamed` | The declaration was found elsewhere, or under another name. The response says where and what it is called now. | Confirm, which re-points the anchor. |
| `lost` | Nothing resolvable. | A decision, not an edit: fix the page, or delete the anchor. |

A formatting change does not flag anything. The hash covers the parser's token
sequence rather than the file's text, so re-indenting a function, wrapping its
arguments or rewriting its comments changes nothing the checker looks at; a
change to what the code *does* changes the hash.

**Confirm** is the only thing that clears a flag, and it is a deliberate,
audited act by a person or an agent:

```sh
curl -sS -X POST -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/anchors/$ANCHOR_ID/confirm"
```

The check response also carries `fallback_share` — the share of the space's
anchors sitting on the line-range path. Line ranges do not survive an edit above
them, so a rising number is the early warning that the badges are turning into
noise.

### REST endpoints

| Endpoint | Auth | Scope | Purpose |
|---|---|---|---|
| `GET /api/v1/health` | none | — | Liveness and database reachability. Used by the compose healthcheck. |
| `GET /api/v1/me` | session or token | `identity:read` | Who the caller is, what it may do, which workspace it is bound to, and which spaces it can reach (`space_access`). |
| `GET /api/v1/format-guide` | session or token | `pages:read` | The page format reference: Markdown constructs with examples, Mermaid keywords and templates, the chart block schema, limits and an example per chart type, and the validation error shape. |
| `GET /api/v1/spaces` | session or token | `pages:read` | The spaces the caller can reach, with page counts. `include_archived=true` adds archived ones. |
| `POST /api/v1/spaces` | admin session | — | Create a space: `key`, `name`, `description`, `icon`. `409` when the key is taken. |
| `GET /api/v1/spaces/{key}` | session or token | `pages:read` | One space. The repository link is shown in full to administrators only. |
| `PATCH /api/v1/spaces/{key}` | admin session | — | Change `name`, `description`, `icon`, `home_page_id`, `rules_page_id` or `repository`. The key cannot be changed. |
| `POST /api/v1/spaces/{key}/archive`, `…/unarchive` | admin session | — | Archive a space, or bring it back. |
| `GET /api/v1/spaces/{key}/rules` | session or token | `pages:read` | The space's working rules: the designated page's id, path, title, content hash, body and timestamp. `404` when no page is designated. |
| `GET /api/v1/spaces/{key}/skills` | session or token | `pages:read` | The space's skills without their bodies: slug, name, description, version, tags, updated. Takes `tag`. |
| `POST /api/v1/spaces/{key}/skills` | session or token | `pages:write` | Create a skill. The body may be a whole `SKILL.md`; front matter that does not parse is `400 validation` naming the field and the line. |
| `GET /api/v1/spaces/{key}/skills/{slug}` | session or token | `pages:read` | One skill in full: body, assembled `SKILL.md`, and the install command. |
| `PATCH /api/v1/spaces/{key}/skills/{slug}` | session or token | `pages:write` | Change a skill. Fields left out keep their stored values. |
| `DELETE /api/v1/spaces/{key}/skills/{slug}` | session or token | `pages:write` + `pages:delete` | Remove a skill. The slug becomes free again. |
| `GET /api/v1/spaces/{key}/export` | session or token | `pages:read` | The whole space as a ZIP of Markdown files mirroring the tree. Takes `format=md`. |
| `POST /api/v1/spaces/{key}/imports` | admin or editor session | — | Start an import. JSON for Confluence (`base_url`, `space_key`, `email`, `api_token` — the last two are used once and never stored); `multipart/form-data` with `source` and `file` for a Notion ZIP, a Markdown ZIP or a PDF. Answers `201` with the import in `needs_review`; nothing is written to pages. Refused to agent tokens. |
| `GET /api/v1/spaces/{key}/imports` | admin or editor session | — | The imports of a space, newest first. |
| `GET /api/v1/imports/{id}` | admin or editor session | — | One import: status, counts, and every staged item with its target path, warnings, converted Markdown, the page already at that path, and who holds a claim on it. |
| `PATCH /api/v1/imports/{id}/items/{itemId}` | admin or editor session | — | The reviewer's edit: `decision` (`create`, `skip`, `overwrite`) and `target_path`. `409` once the import is no longer open for review, or when another item already targets that path. |
| `POST /api/v1/imports/{id}/apply` | admin or editor session | — | Create the pages. Answers with what landed and what was skipped, with the reason — a taken path or somebody else's claim. |
| `POST /api/v1/imports/{id}/cancel` | admin or editor session | — | Close an import without applying it. |
| `DELETE /api/v1/imports/{id}` | admin or editor session | — | Remove the import and its staged items. Pages it created stay. |
| `GET /api/v1/spaces/{key}/discussions` | session or token | `pages:read` | The space's discussions, newest activity first. Takes `status` (`open`, `resolved`). Each carries its message count, participants, the page it is about, and when it will be closed or deleted. |
| `POST /api/v1/spaces/{key}/discussions` | session or token | `pages:write` | Open a discussion with its first message: `title`, `body`, optional `page_id` and `section_id`. `400 validation` when the space already has 100 open. |
| `GET /api/v1/discussions/{id}` | session or token | `pages:read` | One discussion with every message, oldest first. |
| `POST /api/v1/discussions/{id}/messages` | session or token | `pages:write` | Add a message, pushing the closing deadline out. `409 conflict` on a resolved thread, `400 validation` past 200 messages or 8 KB, `429 rate_limited` past the per-actor message budget. |
| `POST /api/v1/discussions/{id}/resolve` | session or token | `pages:write` | Resolve with a decision: `decision` (required), `context`, `options`, `consequences`, `locale`. Creates or rewrites the decision page and answers with it. |
| `DELETE /api/v1/discussions/{id}` | session or token | `pages:write` | Remove a discussion and its messages early. Administrator or the opener only. The decision page is kept. |
| `GET /api/v1/pages` | session or token | `pages:read` | The page tree, without bodies. Takes `space`, `parent_id`, `path` (needs `space`), `kind`, `depth`; without `space`, the top of every space. |
| `POST /api/v1/pages` | session or token | `pages:write` | Create a page. Requires `space`. An invalid ` ```chart ` or ` ```mermaid ` block in the body is `400 validation` with `block_index`, `line` and `errors`. |
| `GET /api/v1/pages/{id}` | session or token | `pages:read` | One page with its body, content hash and linked counterpart. |
| `PATCH /api/v1/pages/{id}` | session or token | `pages:write` | Update or move a page under a claim. Requires `claim_id` and `base_content_hash`. Writes a revision and bumps the version. A changed body is held to the same chart and diagram validation as a new page. |
| `DELETE /api/v1/pages/{id}` | session or token | `pages:write` + `pages:delete` | Soft-delete a page and everything below it. `409 conflict` while another actor holds a live claim in the subtree, unless the caller is an administrator. |
| `POST /api/v1/pages/{id}/restore` | admin session | — | Restore a soft-deleted page and the subtree deleted with it. `409 conflict` when a live page has taken one of its paths or its parent is gone or moved. |
| `GET /api/v1/pages/{id}/tree` | session or token | `pages:read` | The subtree rooted at a page, nested. |
| `GET /api/v1/pages/{id}/versions` | session or token | `pages:read` | Revision history: version, author, content hash, timestamp. |
| `GET /api/v1/pages/{id}/versions/{version}` | session or token | `pages:read` | One version of a page with its body. `404 not_found` for a version the page never had. |
| `GET /api/v1/pages/{id}/diff` | session or token | `pages:read` | The difference between two versions as hunks of numbered lines, with changed words marked inside rewritten lines. Takes `from` (0 means "before the page existed"), `to` (defaults to the current version) and `context` (0–50, default 3). `coarse: true` when the versions are too far apart for a minimal diff. |
| `GET /api/v1/pages/{id}/review` | session or token | `pages:read` | Where a page stands with its reviewers: `baseline_version`, `pending`, the pending agent revisions, and the decisions recorded so far with their notes. |
| `POST /api/v1/pages/{id}/review` | session | — | Record a decision: `decision` (`accept` or `revert`), `version` (the version you looked at) and an optional `note`. `403 forbidden` for any agent token. `409 stale_base` when the page has changed since, `409 conflict` when nothing is pending, when there is no baseline to revert to, or when somebody holds a claim on the page. |
| `GET /api/v1/spaces/{key}/reviews` | session or token | `pages:read` | The pages of a space with agent changes no person has looked at, most recently changed first, one entry per page with `revision_count`, `authors`, `lines_added` and `lines_removed`. |
| `GET /api/v1/spaces/{key}/changes` | session or token | `pages:read` | The change feed: every revision in the space, newest first, with its author and `review_status`. Takes `limit`, `author` (`user`, `agent`) and `before` — pass back `next_before` to page. |
| `GET /api/v1/pages/{id}/comments` | session or token | `pages:read` | The comment threads of a page with their replies. Takes `status` (`open`, `resolved`, `all`). Each thread's `anchor.state` says where it points now: `current` with `line_start`/`line_end`, `outdated`, or `page`. |
| `POST /api/v1/pages/{id}/comments` | session or token | `pages:write` | Open a thread: `body`, and either `block_index` (with `version`, counting the blocks of that version) or `quote` (a passage of the body identifying one paragraph), or neither for the page as a whole. `400 validation` for a quote found nowhere or in several paragraphs, or past 200 open threads; `429 rate_limited` past the per-actor message budget. |
| `POST /api/v1/comments/{id}/replies` | session or token | `pages:write` | Reply in a thread. `409 conflict` on a resolved thread, `400 validation` past 100 replies or 8 KB. |
| `PATCH /api/v1/comments/{id}` | session or token | `pages:write` | Resolve or reopen: `{ "resolved": true }`. `403 forbidden` for an agent token on a thread a person opened. |
| `DELETE /api/v1/comments/{id}` | session or token | `pages:write` | Remove a comment, and its replies if it opens a thread. Its author or a workspace administrator. |
| `GET /api/v1/spaces/{key}/comments` | session or token | `pages:read` | The comment threads of a space, newest first, each with its page. Takes `status` (default `open`) and `limit`. |
| `POST /api/v1/pages/{id}/link` | session or token | `pages:write` | Pair a technical page with a human one of the same space, or unpair them. |
| `POST /api/v1/pages/{id}/claims` | session or token | `pages:write` | Take a claim on the page, or on a section of it. `201` when granted, `200` when it extends a lease the caller already held, `409` when someone else holds it. |
| `GET /api/v1/pages/{id}/claims` | session or token | `pages:read` | The live claims on one page. |
| `PATCH /api/v1/claims/{claimId}` | session or token | `pages:write` | Heartbeat: extends a lease the caller holds. |
| `DELETE /api/v1/claims/{claimId}` | session or token | `pages:write` | Release a claim and delete its notes. Idempotent. `?force=true` is administrator-only. |
| `GET /api/v1/claims` | session or token | `pages:read` | The presence board: every live claim, with its notes and space. Takes `space`. |
| `POST /api/v1/pages/{id}/notes` | session or token | `pages:write` | Leave an ephemeral note on a claim the caller holds. |
| `GET /api/v1/pages/{id}/notes` | session or token | `pages:read` | The active notes on a page. |
| `POST /api/v1/pages/{id}/anchors` | session or token | `pages:write` | Anchor the page, or one of its sections, to a declaration or a line range. Resolves it against the repository first. |
| `GET /api/v1/pages/{id}/anchors` | session or token | `pages:read` | The anchors on one page, plus the space's `fallback_share`. |
| `GET /api/v1/pages/{id}/anchors/check` | session or token | `pages:read` | The anchor states the last check stored, without touching the repository. |
| `POST /api/v1/pages/{id}/anchors/check` | session or token | `pages:write` | Recompute every anchor on the page against the repository, within a read budget. Takes `ref`. |
| `POST /api/v1/anchors/{anchorId}/confirm` | session or token | `pages:write` | Clear a flag after review, re-baselining the anchor onto what is there now. |
| `DELETE /api/v1/anchors/{anchorId}` | session or token | `pages:write` | Remove an anchor. |
| `GET /api/v1/audit` | admin session or token | `audit:read` | The audit log, newest first. Takes `action`, `target`, `since`, `limit`. Refused to a token limited to some spaces. |
| `GET /api/v1/search` | session or token | `pages:read` | Full-text search. Takes `q`, `space`, `limit`, `kind`; without `space`, every unarchived space the caller can see. |
| `GET /api/v1/export/{id}` | session or token | `pages:read` | Export a page. Takes `format=md` or `format=html`. |

A browser session can call these endpoints too, but a request that changes
state must then come from the instance's own origin (`Origin` equal to
`BETTER_AUTH_URL`, or `Sec-Fetch-Site: same-origin`) and carry
`Content-Type: application/json`; anything else is `403 forbidden`. The one
exception is the import upload, which cannot be JSON: it takes
`multipart/form-data` and requires a matching `Origin` header outright, rather
than accepting `Sec-Fetch-Site` in its place. Requests with an agent token are
not affected.

All of them refuse to answer for a workspace other than the caller's own — and,
for a token limited to some spaces, for a space outside its list — with `404`
rather than `403` so the response does not confirm that a page exists
somewhere else. That check is written explicitly in each handler rather than
inferred from there being one workspace, so it does not have to be retrofitted
when there is more than one. Errors share one envelope:

```json
{ "error": { "code": "stale_base", "message": "…", "details": { } } }
```

The codes are `validation`, `not_found`, `conflict`, `stale_base`,
`forbidden`, `insufficient_scope`, `unauthenticated`, `invalid_token`,
`rate_limited` and `repository_unavailable`. A `repository_unavailable` carries
a fixed message only; git's own output, which the remote server writes, goes to
the server log. On the write path they mean
particular things: `conflict` is
"you have no claim here", `not_found` on a write is "your claim has expired or
been released", `forbidden` is "that claim belongs to someone else", and
`stale_base` is "the page moved under you". `repository_unavailable` is a `502`:
the space's source repository could not be reached or read, which is this
instance's dependency failing rather than anything wrong with the request.

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
  [Reverse proxy](#reverse-proxy) above.

A full write-up lives in `docs/security.md`. See [`SECURITY.md`](SECURITY.md)
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

No calendar dates — phases are ordered by dependency, not by schedule.

- **Phase 0** — Anchor mechanism spike, project bootstrap, CI skeleton with
  dependency and secret scanning.
- **Phase 1** — Data model and auth: workspace, users, roles, agent tokens.
  *Complete.*
- **Phase 2** — Wiki core: pages, page tree, full-text search, REST API.
  *Complete.*
- **Phase 3** — Claims and leases, presence board, ephemeral agent notes.
  *Complete.*
- **Phase 4** — Doc↔code anchoring with staleness detection. *Complete.*
- **Phase 5** — MCP server (stdio and streamable HTTP transports). *Complete.*
- **Phase 6** — Export (Markdown/HTML; PDF deferred in favour of printing the
  HTML export), Docker image and compose, full README and license text. *Built;
  closes once the pre-release security review's launch-blocking findings are
  fixed.*
- **Spaces** — Confluence-style areas per project: a page tree, a repository
  and an overview per space, tokens limited to spaces, space export. *Done.*
  Per-space permissions come next.
- **Phase 7** — Public launch.

See `docs/roadmap.md` for exit criteria per phase.

## License

clewwiki is licensed under **AGPL-3.0** (see `LICENSE`), with additional
terms permitted under AGPL-3.0 Section 7 covering author attribution and
marking of modified versions (see `LICENSE-ADDITIONAL-TERMS.md`).

## Author

clewwiki is created and maintained by **Dodecaidr** —
[https://dodecaidr.pro](https://dodecaidr.pro)
