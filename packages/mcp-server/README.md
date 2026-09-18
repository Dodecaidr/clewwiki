# @clewwiki/mcp-server

The MCP server for [clewwiki](https://github.com/Dodecaidr/clewwiki): the
twenty-eight wiki tools an AI coding agent calls, wrapping a clewwiki instance's
REST API with an agent token. An agent starts with `wiki.list_spaces` and
works inside its project's space; `wiki.get_rules` gives it that project's
working rules in one call, `wiki.list_skills` and `wiki.get_skill` its reusable
instruction packages, and `wiki.format_guide` tells it how to write a page —
tables, callouts, Mermaid diagrams and chart blocks.

```sh
CLEWWIKI_URL=https://wiki.example.com CLEWWIKI_TOKEN=cww_... clewwiki-mcp
```

It speaks MCP over stdio. It has no access to the database and no state
of its own: every tool call is one REST request, authorized, rate limited
and audited by the instance.

## Installing a project's skills

Agent hosts load skills from directories on disk, which no tool call can write
to, so this package is also the command that puts them there:

```sh
CLEWWIKI_URL=https://wiki.example.com CLEWWIKI_TOKEN=$CLEWWIKI_TOKEN \
  npx -y @clewwiki/mcp-server skills install --space MOBILE
```

```
clewwiki-mcp skills list    --space KEY
clewwiki-mcp skills install --space KEY [--dir DIR] [--only a,b] [--force]
```

It writes each skill to `<DIR>/<slug>/SKILL.md` — `~/.claude/skills` by
default — and prints every file it wrote. It refuses a slug that would land
outside the target directory, refuses to follow a symbolic link, and leaves
alone any `SKILL.md` it did not write or that was edited after it did, unless
`--force`. Skill bodies are written as files and never executed.

The tool contract, error codes and host configuration for Claude Code,
Cursor and Codex are in
[`docs/mcp.md`](https://github.com/Dodecaidr/clewwiki/blob/main/docs/mcp.md).

## License

AGPL-3.0-or-later with additional attribution terms — see the repository's
`LICENSE` and `LICENSE-ADDITIONAL-TERMS.md`.

clewwiki — created by Dodecaidr (https://dodecaidr.pro)
