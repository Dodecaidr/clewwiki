#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { assertSecureBaseUrl, ClewwikiRestClient } from './rest-client.ts';
import { createClewwikiMcpServer } from './server.ts';
import { MCP_SERVER_VERSION } from './version.ts';

/**
 * The stdio entry point: `clewwiki-mcp`.
 *
 * An agent host starts this process, and it talks to a clewwiki instance over
 * HTTPS with the token in its environment. Nothing is read from a
 * configuration file and nothing is written to disk, so the only secret in
 * play is the one the host already decided to hand over.
 *
 * Everything this process says to a human goes to stderr. stdout is the
 * protocol channel: one stray line printed there is a parse error at the other
 * end of the pipe.
 */

const USAGE = `clewwiki-mcp ${MCP_SERVER_VERSION}

The clewwiki MCP server, speaking the stdio transport. Configure it in your
agent host and give it two environment variables:

  CLEWWIKI_URL     Base URL of the instance, for example https://wiki.example.com
  CLEWWIKI_TOKEN   An agent token issued from the instance's /tokens page

Optional:

  CLEWWIKI_TIMEOUT_MS          Per-request timeout in milliseconds (default 30000)
  CLEWWIKI_ALLOW_INSECURE_URL  Set to true to allow an http:// URL that is not
                               localhost or 127.0.0.1 (the token is then sent
                               unencrypted)

The token's scopes decide what the tools can do: pages:read for reading and
searching, pages:write for claims, writes and notes.
`;

function fail(message: string): never {
  process.stderr.write(`clewwiki-mcp: ${message}\n`);
  process.exit(1);
}

function readTimeout(): number | undefined {
  const raw = process.env.CLEWWIKI_TIMEOUT_MS;
  if (!raw || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail('CLEWWIKI_TIMEOUT_MS must be a positive number of milliseconds');
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(USAGE);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stderr.write(`${MCP_SERVER_VERSION}\n`);
    return;
  }
  const unknown = args.find((arg) => arg.startsWith('-'));
  if (unknown) {
    fail(`unknown option ${unknown}. Run with --help for usage.`);
  }

  // Fail here rather than on the first tool call: an agent host that started
  // the process without configuration should find out at start-up, when a
  // person is still looking at the log, and not ten minutes into a session.
  const baseUrl = process.env.CLEWWIKI_URL?.trim();
  if (!baseUrl) {
    fail('CLEWWIKI_URL is not set. It is the base URL of your clewwiki instance, for example https://wiki.example.com');
  }
  const token = process.env.CLEWWIKI_TOKEN?.trim();
  if (!token) {
    fail('CLEWWIKI_TOKEN is not set. Issue an agent token from the /tokens page of your instance.');
  }

  let client: ClewwikiRestClient;
  try {
    assertSecureBaseUrl(baseUrl, process.env.CLEWWIKI_ALLOW_INSECURE_URL === 'true');
    client = new ClewwikiRestClient({ baseUrl, token, timeoutMs: readTimeout() });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const server = createClewwikiMcpServer({ client });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
