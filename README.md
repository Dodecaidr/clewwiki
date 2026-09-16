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

What is here today: the database schema, credential login, scoped agent tokens,
a container that builds, and the wiki core — pages, a page tree, Markdown and
Mermaid rendering, full-text search, revision history, and Markdown/HTML
export, over both the web UI and the REST API. Claims, anchoring and the MCP
server are not here yet. What follows works today, verbatim, on a clean
machine.

### Prerequisites

- Docker Engine 24 or newer with the Compose plugin (`docker compose version`).
- Roughly 1 GB of free disk for the image and the database volume.
- A machine you can reach on port 3000, or a reverse proxy in front of it.
- `openssl`, for generating secrets. Any CSPRNG will do.

Nothing else: no Node.js, no PostgreSQL, no package manager on the host. Those
are only needed for development, covered further down.

### Quick start

**1. Clone the repository.**

```sh
git clone https://github.com/Dodecaidr/clewwiki.git
cd clewwiki
```

**2. Create your environment file.**

```sh
cp .env.example .env
```

**3. Generate the two secrets.** Both are required, and neither has a default —
the container refuses to start if either is missing or left at a placeholder.

```sh
# Signs session cookies. Changing it later logs everyone out.
printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 48)"

# Password for the bundled PostgreSQL container.
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 24)"
```

Paste both lines into `.env`, replacing the empty keys already there. Then set
`BETTER_AUTH_URL` to the address a browser will actually use. For a first local
run that is:

```
BETTER_AUTH_URL=http://localhost:3000
```

If you are deploying behind a reverse proxy, set it to the public HTTPS address
instead (`https://wiki.example.com`). It has to match what the browser sees, or
sign-in cookies are issued for the wrong origin and silently dropped. Secure
cookies switch on automatically when this value starts with `https://`.

**4. Start it.**

```sh
docker compose up -d
```

Compose builds the image, starts PostgreSQL, waits for it to pass its
healthcheck, then starts the application, which applies its own database
migrations before serving the first request. Watch it come up with:

```sh
docker compose logs -f web
```

**5. Confirm it is alive.**

```sh
curl http://localhost:3000/api/v1/health
```

```json
{ "status": "ok", "service": "clewwiki", "database": "up" }
```

A `"database": "down"` answer means the app is running but cannot reach
PostgreSQL — check `docker compose logs postgres` and the `POSTGRES_PASSWORD`
in `.env`.

By default compose publishes the port on `127.0.0.1` only, so nothing is
reachable from the network yet. That is deliberate; see
[Reverse proxy](#reverse-proxy) before changing it.

**6. Create the administrator account.**

Open <http://localhost:3000> in a browser. Because the instance has no accounts
yet, it sends you to `/setup`, which asks for a workspace name, your name, your
email, and a password of at least 12 characters.

There are no default credentials, and there is no seeded admin account in any
migration or fixture. The account you create here is the first one that exists.
Once it does, `/setup` stops being a route at all and answers 404, so the form
cannot be reached again on a running instance.

Store the password in a password manager. There is no mail transport configured
by default, so there is no password-reset email to fall back on.

**7. Issue an agent token.**

Sign in, then open **Agent tokens** in the navigation (or go straight to
`/tokens`). Give the token a name you will recognise later, choose how long it
should live, and grant only the scopes the agent actually needs:

| Scope | What it permits |
|---|---|
| `identity:read` | Call `GET /api/v1/me`. Needed by anything that wants to confirm who it is. |
| `pages:read` | Read wiki pages, the page tree, search results and exports. |
| `pages:write` | Create, change, move, delete and link wiki pages. |
| `audit:read` | Read the audit log. Reserved for a later phase. |

Press **Issue token**. The token appears once:

```
cww_7Kq2mXpa.n4Tb9vZs1Lw0eRfHj6YcU3dQoAiKmP8gNxVtEr2sBl
```

Copy it now. Only a SHA-256 digest of the secret half is stored, so the value
cannot be shown again or recovered — if it is lost, revoke it and issue a new
one.

**8. Use it.**

```sh
curl -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     http://localhost:3000/api/v1/me
```

```json
{
  "actor": { "type": "agent", "id": "1ced1eae-…", "name": "build-agent" },
  "role": "agent",
  "scopes": ["identity:read", "pages:read"],
  "workspace": { "id": "9c7fe5b6-…", "name": "Engineering", "slug": "default" }
}
```

The response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` headers so a client can slow down before it is turned away.

**9. Revoke it when you are done.** Press **Revoke** on the tokens page. The
next request with that token is rejected at the authentication layer, before any
handler runs:

```sh
curl -i -H "Authorization: Bearer cww_7Kq2mXpa.…" http://localhost:3000/api/v1/me
```

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="clewwiki"

{"error":{"code":"invalid_token","message":"Invalid or expired token"}}
```

Expiry behaves identically: a token past `expires_at` is refused at the same
point, not at write time.

## Writing pages

A page can be written from the browser or over the REST API, and both go
through the same code — there is no "API version" of a page that behaves
differently from the one the UI produces.

### From the UI

Sign in and open **Pages**. **New page** asks for a title, where the page sits
in the tree, its kind, and the body:

- **Kind** is `technical` or `human`. The two are the linked document pair:
  one written for agents, one written for people. A page of each kind can be
  paired so that a reader of either lands on the other.
- **Path** is derived from the title and the parent if you leave it empty —
  a page called "Auth service" under `/backend` becomes `/backend/auth-service`.
  Moving a page later moves everything below it.
- **Body** is Markdown. A fenced block marked `mermaid` is rendered as a
  diagram in the browser:

  ````markdown
  ```mermaid
  flowchart LR
      Agent -->|writes| Page
      Page -->|revision| History
  ```
  ````

**Show preview** renders the body through the same pipeline the stored page and
the HTML export use, so the preview cannot show you something the page will not.

### From an agent token

Issue a token with `pages:read` and `pages:write` (see above), then:

```sh
export CLEWWIKI_TOKEN=cww_…
export CLEWWIKI_URL=http://localhost:3000

# Create a page.
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{
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
  "path": "/backend/auth",
  "title": "Auth service",
  "kind": "technical",
  "version": 1,
  "content_hash": "9f2b…",
  "updated_by": { "type": "agent", "id": "1ced…" },
  "anchors": []
}
```

`content_hash` comes back on every read. Send it as `base_content_hash` on a
write and the write is refused with `409 stale_base` if someone changed the
page in between, instead of silently overwriting them:

```sh
curl -sS -X PATCH "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d "{\"body\": \"# Auth service\n\nRewritten.\n\", \"base_content_hash\": \"$HASH\"}"
```

Search, history and the tree:

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/search?q=bearer&limit=5"
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
the title, path, kind, version, content hash and modification time. The HTML
file is a standalone document that opens from disk with nothing to load;
Mermaid blocks are kept as `<pre class="mermaid">` holding their source, since
drawing them would mean shipping a renderer inside every exported file.

### REST endpoints in this phase

| Endpoint | Auth | Scope | Purpose |
|---|---|---|---|
| `GET /api/v1/health` | none | — | Liveness and database reachability. Used by the compose healthcheck. |
| `GET /api/v1/me` | session or token | `identity:read` | Who the caller is, what it may do, and which workspace it is bound to. |
| `GET /api/v1/pages` | session or token | `pages:read` | The page tree, without bodies. Takes `parent_id`, `path`, `kind`, `depth`. |
| `POST /api/v1/pages` | session or token | `pages:write` | Create a page. |
| `GET /api/v1/pages/{id}` | session or token | `pages:read` | One page with its body, content hash and linked counterpart. |
| `PATCH /api/v1/pages/{id}` | session or token | `pages:write` | Update or move a page. Writes a revision and bumps the version. |
| `DELETE /api/v1/pages/{id}` | session or token | `pages:write` | Soft-delete a page and everything below it. |
| `GET /api/v1/pages/{id}/tree` | session or token | `pages:read` | The subtree rooted at a page, nested. |
| `GET /api/v1/pages/{id}/versions` | session or token | `pages:read` | Revision history: version, author, content hash, timestamp. |
| `POST /api/v1/pages/{id}/link` | session or token | `pages:write` | Pair a technical page with a human one, or unpair them. |
| `GET /api/v1/search` | session or token | `pages:read` | Full-text search. Takes `q`, `limit`, `kind`. |
| `GET /api/v1/export/{id}` | session or token | `pages:read` | Export a page. Takes `format=md` or `format=html`. |

All of them refuse to answer for a workspace other than the caller's own, with
`404` rather than `403` so the response does not confirm that a page exists
somewhere else. That check is written explicitly in each handler rather than
inferred from there being one workspace, so it does not have to be retrofitted
when there is more than one. Errors share one envelope:

```json
{ "error": { "code": "stale_base", "message": "…", "details": { } } }
```

### Reverse proxy

**clewwiki does not terminate TLS, and it never will.** The application process
does not listen on a TLS socket, does not read certificates, and has no ACME
client. Putting a proxy in front of it is not optional for anything reachable
beyond `localhost`: without one, session cookies and agent tokens cross the
network in plaintext.

No proxy is bundled, so you can use the one you already run rather than fight a
second one. Three worked examples follow. In all of them:

1. Set `BETTER_AUTH_URL` in `.env` to the public `https://` address.
2. Set `WEB_BIND_ADDRESS=127.0.0.1` (the default) if the proxy runs on the same
   host, so the app is unreachable except through the proxy.
3. Make sure the proxy sends `X-Forwarded-Proto: https`. The app enables HSTS
   only when it sees that header, which is what keeps a plain-HTTP local run
   from locking your browser out of the instance.
4. Run `docker compose up -d` again after editing `.env`.

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

Traefik sets `X-Forwarded-Proto` itself. Confirm your entrypoint has a
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
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        # Without this the app will not enable secure-cookie or HSTS behaviour.
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for streamed responses and, later, the MCP HTTP transport.
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
- [ ] **`BETTER_AUTH_SECRET` is a generated value.** `openssl rand -base64 48`,
      not a word you chose and not the placeholder. The container refuses to
      start on an obvious placeholder, but it cannot detect a weak one.
- [ ] **`POSTGRES_PASSWORD` is a generated value**, and the database port is not
      published to the host. The shipped compose file keeps it on the internal
      network; check any override you added.
- [ ] **`.env` is not in version control.** `git status` should never list it.
      `.gitignore` covers it, but a `git add -f` defeats that.
- [ ] **The administrator account has a strong, stored password.** It was
      created interactively at first boot; there is no reset email configured.
- [ ] **`/setup` returns 404.** Check it. A 200 means the instance has no
      accounts and anyone reaching it can claim the administrator account.
- [ ] **Agent tokens carry an expiry.** Prefer a fixed TTL and rotation over a
      token that never expires.
- [ ] **Agent tokens carry the narrowest scopes that work.** A token that only
      reads should not hold `pages:write`.
- [ ] **Leaked tokens are revoked, not just rotated.** Revocation takes effect
      on the next request, at the authentication layer.
- [ ] **The rate limit suits your agents.** The default is 60 requests per
      minute per token. It is enforced per application process, so running more
      than one replica multiplies the effective ceiling.
- [ ] **The audit log is being read.** Every agent-token request writes a row,
      including rejected ones. A burst of `auth.rejected` from a token that is
      normally quiet is the signal that a token has leaked.
- [ ] **Backups cover the `postgres-data` volume.** It holds every account,
      token digest and audit row. `docker compose down -v` deletes it
      permanently.
- [ ] **Image and dependencies are current.** `docker compose build --pull` then
      `docker compose up -d` picks up base-image security updates.

### Configuration reference

Every value is read from the environment. Nothing is compiled into the image,
and there is no configuration file to edit inside the container.

| Variable | Secret | Default | Purpose |
|---|---|---|---|
| `POSTGRES_PASSWORD` | **yes** | none — required | Password for the bundled PostgreSQL container. |
| `POSTGRES_USER` | no | `clewwiki` | Database role name. |
| `POSTGRES_DB` | no | `clewwiki` | Database name. |
| `DATABASE_URL` | **yes** | built by compose | Connection string. Set it by hand only when running outside compose. |
| `BETTER_AUTH_SECRET` | **yes** | none — required | Signs session cookies and tokens. Changing it invalidates every session. |
| `BETTER_AUTH_URL` | no | `http://localhost:3000` | Public base URL as the browser sees it. Enables secure cookies when it starts with `https://`. |
| `APP_BASE_URL` | no | `BETTER_AUTH_URL` | Base URL used for generated links. |
| `AGENT_TOKEN_RATE_LIMIT_MAX` | no | `60` | Requests allowed per token per window. |
| `AGENT_TOKEN_RATE_LIMIT_WINDOW` | no | `60` | Window length in seconds. |
| `WEB_BIND_ADDRESS` | no | `127.0.0.1` | Host interface compose publishes on. `0.0.0.0` exposes the app to the network — only with TLS in front. |
| `WEB_PORT` | no | `3000` | Host port compose publishes on. |
| `RUN_MIGRATIONS_ON_START` | no | unset (migrations run) | Set to `false` to manage the schema yourself. |
| `CLEWWIKI_MIGRATIONS_DIR` | no | set by the image | Where the app looks for migration SQL. |
| `LOG_LEVEL` | no | `info` | One of `error`, `warn`, `info`, `debug`. |

Browser sessions are not rate limited; the two `AGENT_TOKEN_RATE_LIMIT_*`
settings apply to bearer-token requests only.

### Upgrading

```sh
git pull
docker compose build --pull
docker compose up -d
```

Pending migrations are applied by the application when it starts. Several
replicas starting at once are safe: an advisory lock means the first one
migrates and the rest wait, then find nothing to do.

### Uninstalling

```sh
docker compose down        # stop, keep the data
docker compose down -v     # stop and delete the database volume
```

The second form is irreversible: accounts, tokens and audit history go with it.

### Development

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
  responsibility; worked examples for Caddy, Traefik, and nginx are in
  [Reverse proxy](#reverse-proxy) above.

A full write-up lives in `docs/security.md`.

## Roadmap

No calendar dates — phases are ordered by dependency, not by schedule.

- **Phase 0** — Anchor mechanism spike, project bootstrap, CI skeleton with
  dependency and secret scanning.
- **Phase 1** — Data model and auth: workspace, users, roles, agent tokens.
  *Complete.*
- **Phase 2** — Wiki core: pages, page tree, full-text search, REST API.
  *Complete.*
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
