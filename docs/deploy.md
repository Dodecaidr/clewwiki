# Deploy and operate


clewwiki runs as two containers — the application and PostgreSQL 16 — started
by one `docker compose` command, with no reverse proxy bundled. This section
takes a clean Linux server with Docker to a working instance with an agent
connected, in order. Every command is meant to be pasted as it is.

## Prerequisites

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

## Quick start

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
release tag (e.g. `0.4.0`) so an upgrade is a deliberate `docker compose pull`
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
| `pages:delete` | Soft-delete a page and everything below it, move it with everything below it to another space, or remove an uploaded image for good. Needs `pages:write` as well. Kept separate because one call takes a whole subtree out of a space. |
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

## Build from source

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

## Connecting an AI coding agent (MCP)

Agents talk to clewwiki through the Model Context Protocol with thirty
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
output shapes and error codes, is in [`docs/mcp.md`](mcp.md). The
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

### Remote agents over HTTP

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

## Reverse proxy

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

### Caddy

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

### Traefik

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

### nginx

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

## Security checklist

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

## Configuration reference

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
| `IMPORT_MAX_UPLOAD_MB` | no | `200` | Largest import upload. Refused from the declared `Content-Length`, before the body is read. |
| `IMPORT_MAX_EXPANDED_MB` | no | `256` | Most an uploaded ZIP may expand to. The upload and what it expands to are held in memory together until the import is staged, so on a host with little memory lower both: a container that runs out is killed, not refused. |
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
| `IMAGE_MAX_UPLOAD_MB` | no | `5` | Largest image a page accepts, at most `10`. `0` switches image uploads off; pages then take images by address only. |
| `IMAGE_STORE_MAX_MB` | no | `2048` | Most the images of one workspace may occupy together. They are stored in the database, so this is also how much they can add to a backup. |
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

## Backups

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

## Upgrading

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

## Uninstalling

```sh
docker compose down                         # stop and remove the containers; keep both volumes
docker compose down --volumes --rmi all     # also delete both volumes and both images
docker builder prune                        # reclaim the image build cache
cd .. && rm -rf clewwiki
```

The second command is irreversible: accounts, pages, history and the audit log
go with the `postgres-data` volume. Take a backup first if there is any chance
you will want them.
