# Contributing to clewwiki

Thanks for taking the time to contribute. This document covers how to set
up the project, what a pull request needs to pass, and how contributions
are licensed. `AGENTS.md` is the binding source of truth for repository
conventions — this file expands on it for the parts specific to
contributing a change.

## Development setup

You need **Node.js 22** (see `.nvmrc`), **pnpm 10**, and a **PostgreSQL 16**
you can point at.

```sh
pnpm install
cp .env.example .env          # then fill DATABASE_URL and BETTER_AUTH_SECRET
pnpm db:migrate                # apply migrations
pnpm dev                       # development server on :3000
```

`pnpm db:generate` regenerates migrations after a schema change in
`packages/db/src/schema.ts`.

## Running the checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### Unit and integration tests

Unit tests run with nothing but Node. Integration tests need a throwaway
PostgreSQL 16 database, supplied as `TEST_DATABASE_URL`:

```sh
createdb clewwiki_test
TEST_DATABASE_URL=postgres://localhost:5432/clewwiki_test pnpm test
```

They apply migrations themselves and create and delete their own
workspaces, so an existing database is not disturbed — point them at a
scratch database anyway. Without `TEST_DATABASE_URL` reachable, integration
tests skip with a message and `pnpm test` stays green, which is expected on
a fresh checkout with no database configured.

## What a pull request must pass

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

CI runs the same four commands, plus a dependency audit, a secret scan, and
a full Docker build-and-smoke-test cycle. A pull request that does not pass
all of them locally will not pass CI.

## Commit messages and PR scope

- Commit messages follow [Conventional
  Commits](https://www.conventionalcommits.org/).
- Keep pull requests small and scoped to one concern. A PR that mixes an
  unrelated refactor with a behaviour change is harder to review and harder
  to revert if something goes wrong.
- Commit messages, PR descriptions, and code comments must not contain any
  AI-attribution trailers, generated-by notes, or similar markers — write
  them as you would for work done by a human contributor.

## Tests for behaviour changes

- Any change in behaviour needs a test that demonstrates it. A bug fix
  needs a test that fails without the fix.
- **Security-sensitive changes** — authentication, agent tokens, scopes,
  claims, repository access/credentials, or the MCP server — need a test
  that **fails without the change** and passes with it. This is checked in
  review; a PR touching these areas without such a test will be asked to
  add one.
- Claims/leases concurrency behaviour is integration-tested: a concurrent
  claim attempt on the same page or section must resolve to exactly one
  success and one conflict (see `AGENTS.md`, "Testing expectations").

## Documentation

Update the relevant documentation (README, `docs/*.md`) in the **same pull
request** as the behaviour change it describes, not as a follow-up. This
project's whole premise is that documentation and code should not drift
apart — that applies to its own repository first.

Do not commit generated agent-context or agent-config files. `AGENTS.md` at
the repository root is the only one this project keeps; do not add
tool-specific rule files next to it. See `AGENTS.md`, "Do not".

## Licensing of contributions

clewwiki is licensed under **AGPL-3.0-or-later**, with the additional terms
in `LICENSE-ADDITIONAL-TERMS.md` (author attribution and marking of
modified versions, both permitted under AGPL-3.0 Section 7).

By submitting a contribution, you agree that it is licensed to the project
under the same terms — **AGPL-3.0-or-later plus the additional terms in
`LICENSE-ADDITIONAL-TERMS.md`** — and that you have the right to submit it
under those terms ("inbound = outbound").

Sign off your commits to record that agreement, DCO-style:

```sh
git commit -s
```

This appends a line to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

It states that you wrote the change, or otherwise have the right to submit
it under the project's license, using your real name and a working email
address (no anonymous or pseudonymous sign-offs).

## Where to ask questions

Use [GitHub
Discussions](https://github.com/Dodecaidr/clewwiki/discussions) if it is
enabled on the repository. Otherwise, open a regular
[issue](https://github.com/Dodecaidr/clewwiki/issues) — questions are
welcome there too, not just bug reports.

Do not use the security reporting channel for questions that are not
vulnerability reports; see `SECURITY.md`.
