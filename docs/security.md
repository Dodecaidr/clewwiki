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

- **Scoped tokens.** Agent tokens carry a role (`agent`, `editor`, `admin`)
  and a `permissions` field; v1 scope is role-level, with finer
  per-operation scope left for a later iteration.
- **Token TTL.** Tokens expire and are rejected at the authentication
  layer once past `expires_at` — before any write logic runs, not only
  when a write is attempted.
- **Token revocation.** Revoking a token invalidates it immediately for
  all subsequent requests.
- **Workspace binding.** Every request handler checks that the caller's
  token and the target resource belong to the same workspace, written
  explicitly in code rather than assumed from a single-workspace
  deployment.
- **Write audit log.** Every write attempt — success, claim conflict, or
  content-hash conflict — is recorded in the same database transaction as
  the attempt itself, so failed attempts are forensic signal too, not
  silently dropped.
- **Rate limiting.** Agent tokens are rate-limited per token (not per IP,
  since an agent may sit behind a shared address); human use through the
  browser is unlimited or materially higher.
- **TLS at the edge.** The application does not terminate TLS itself.
  Secure-cookie and HSTS behavior activate only when the server sees
  `X-Forwarded-Proto: https`, and deployment documentation is explicit
  that a reverse proxy supplying TLS is required before exposing an
  instance to the internet.
- **Content-as-data.** Responses that carry page body text always
  separate it from provenance metadata (author, timestamps, content
  hash), and MCP tool descriptions state explicitly that body text is
  untrusted data, not instructions. This is a documented contract, not a
  technical guarantee enforceable on a calling agent.
- **Secrets from environment only.** No secret value is ever baked into a
  built image or committed to source; `.env.example` documents required
  keys with empty values.
- **No default credentials.** The first run requires interactively
  creating the admin account; no seeded admin account ships in any
  migration or fixture.
- **Streamable HTTP exposure.** Every streamable HTTP MCP request
  requires a valid token; there is no anonymous MCP HTTP endpoint. The
  CORS/Origin allowlist defaults to empty as a direct mitigation against
  DNS rebinding, a known risk class for locally or network-exposed MCP
  HTTP servers.
- **CI scanning.** Dependency scanning and secret scanning both run on
  every change, before code merges.

## Explicitly out of scope for v1

- Fine-grained token scope below role level — role-level scope plus TTL,
  revocation, and workspace binding already bound the blast radius of a
  leaked token without per-operation access lists.
- A WAF, IDS, or full SIEM — excessive for a single-team self-hosted
  instance; the audit log, rate limiting, and reverse-proxy TLS already
  cover this threat model.
- SSO/OIDC — a scope decision, not a security gap; credential-based login
  already satisfies the self-hosted-without-a-cloud-provider requirement.

## Pre-release review

A full pass against every item above is a mandatory exit criterion before
public launch, distinct from the narrower point checks done earlier
against authentication and claims/token handling.
