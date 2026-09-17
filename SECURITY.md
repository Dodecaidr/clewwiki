# Security Policy

## Supported versions

clewwiki is pre-1.0 and pre-release. Until the first tagged release
(`v0.1.0`) and for as long as the project stays pre-1.0 afterwards, only
the **latest published release** (or, before any tag exists, the `main`
branch) is supported with security fixes. There is no long-term support
branch and no backporting to older minor versions while the project is
pre-1.0.

| Version | Supported |
|---|---|
| Latest release (or `main`, pre-`v0.1.0`) | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

Report security vulnerabilities through **GitHub private vulnerability
reporting** — open the **Security** tab on this repository and choose
**Report a vulnerability**:

<https://github.com/Dodecaidr/clewwiki/security/advisories/new>

This is the only reporting channel. **Do not open a public issue, a public
discussion, or a pull request for a security vulnerability.** A private
report keeps details out of the public tracker until a fix is available.

### What to include

To help triage the report quickly, include as much of the following as you
can:

- A clear description of the vulnerability and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The affected component: the web application, the MCP server package
  (`@clewwiki/mcp-server`), the Docker image, or `docker-compose.yml`.
- The version or commit you tested against, and how you ran it (source
  checkout, Docker image, `docker compose`).
- Any relevant logs or request/response detail — with tokens, cookies, and
  passwords redacted.

### Response targets

clewwiki is maintained by one person, so response times are **best-effort**,
not contractual:

- **Acknowledgement** of a new report: within **7 days**.
- **Status update** (triage result, and either a fix timeline or the
  reasoning for closing the report): within **30 days**.

You will be kept informed as the report is investigated and, where
applicable, as a fix is prepared and released.

## Scope

**In scope:**

- The clewwiki web application (`apps/web`): authentication, authorization,
  claims/leases, the REST API, the anchor mechanism, and the UI.
- The MCP server package (`packages/mcp-server`, published as
  `@clewwiki/mcp-server`).
- The Docker image (`docker/Dockerfile`) and `docker-compose.yml`, as
  shipped by this repository.

**Out of scope:**

- Deployments that do not follow the [security
  checklist](README.md#security-checklist) documented in the README (for
  example: no TLS in front of the instance, a published database port, a
  weak or default `BETTER_AUTH_SECRET`).
- Reverse-proxy misconfiguration on the operator's own infrastructure —
  clewwiki does not bundle or manage a reverse proxy; see
  [Reverse proxy](README.md#reverse-proxy) for the documented, supported
  configurations.
- Denial of service caused by an **authenticated administrator** of a given
  instance against their own instance. An administrator is a trusted
  principal in this threat model; see `docs/security.md`.

If you are not sure whether something is in scope, report it anyway — it is
easier to close an out-of-scope report than to miss an in-scope one.

## Safe harbour

clewwiki welcomes good-faith security research conducted in accordance with
this policy. If you:

- make a good-faith effort to avoid privacy violations, data destruction,
  and service disruption to others,
- only interact with test accounts, data, or instances you control (or have
  explicit permission to test),
- report the issue through the private channel above before any public
  disclosure, and
- give a reasonable amount of time to address the issue before disclosing
  it publicly,

then this activity is considered authorized, and no legal action will be
pursued against you for it. This safe harbour applies only to testing
conducted under these conditions and does not extend to third-party
infrastructure, other users' deployments, or activity outside them.

## Credit

With your permission, reporters are credited in the GitHub Security
Advisory published for the fix and, where applicable, in the release notes.
Let the maintainer know in your report whether you would like to be
credited, and under what name.
