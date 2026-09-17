# @clewwiki/mcp-server

The MCP server for [clewwiki](https://github.com/Dodecaidr/clewwiki): the
eleven wiki tools an AI coding agent calls, wrapping a clewwiki instance's
REST API with an agent token.

```sh
CLEWWIKI_URL=https://wiki.example.com CLEWWIKI_TOKEN=cww_... clewwiki-mcp
```

It speaks MCP over stdio. It has no access to the database and no state
of its own: every tool call is one REST request, authorized, rate limited
and audited by the instance.

The tool contract, error codes and host configuration for Claude Code,
Cursor and Codex are in
[`docs/mcp.md`](https://github.com/Dodecaidr/clewwiki/blob/main/docs/mcp.md).

## License

AGPL-3.0-or-later with additional attribution terms — see the repository's
`LICENSE` and `LICENSE-ADDITIONAL-TERMS.md`.

clewwiki — created by Dodecaidr (https://dodecaidr.pro.site)
