## What

<!-- What does this PR change? -->

## Why

<!-- Why is this change needed? Link an issue or discussion if there is one. -->

## How tested

<!-- How did you verify this works? Include the commands you ran and, for
     behaviour changes, what test you added or updated. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass locally
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] This PR is scoped to one concern
- [ ] Tests are added or updated for any behaviour change
- [ ] Documentation (README, `docs/*.md`) is updated in this PR if behaviour changed
- [ ] No generated agent-context or agent-config files are included (only `AGENTS.md` at the repository root)
- [ ] Commits are signed off (`git commit -s`) — see `CONTRIBUTING.md`

## Security-sensitive change?

- [ ] Yes — this touches auth, agent tokens/scopes, claims, repository access/credentials, or MCP
- [ ] No

<!-- If yes: this PR must include a test that fails without the change and
     passes with it. Describe the security implication below. -->
