/**
 * Connection snippets and the onboarding prompt shown on `/connect`.
 *
 * Nothing here ever sees a token. Every snippet refers to the token by the
 * name of the environment variable it is expected to live in, so what a person
 * copies from the page is safe to paste into a terminal, a config file that is
 * committed by mistake, or a chat. The builders take no token argument on
 * purpose: there is no code path by which one could be interpolated.
 */

export const AGENT_HOSTS = ['claude-code', 'cursor', 'codex', 'other'] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

export function isAgentHost(value: unknown): value is AgentHost {
  return typeof value === 'string' && (AGENT_HOSTS as readonly string[]).includes(value);
}

/** Name of the environment variable the token is kept in. */
export const TOKEN_ENV_VAR = 'CLEWWIKI_TOKEN';
/** How a shell refers to it. The only form of "the token" a snippet contains. */
export const TOKEN_PLACEHOLDER = `$${TOKEN_ENV_VAR}`;

/** The operator setting that mounts the HTTP transport. */
export const MCP_HTTP_ENV_VAR = 'MCP_HTTP_ENABLED';

export const MCP_SERVER_NAME = 'clewwiki';
export const MCP_PACKAGE = '@clewwiki/mcp-server';
/** Until the package is on npm, the host runs the built entry point instead. */
export const MCP_LOCAL_ENTRY = '/path/to/clewwiki/packages/mcp-server/dist/bin.js';

export type SnippetTransport = 'http' | 'stdio';

export type SnippetId =
  | 'claude-code-http'
  | 'claude-code-stdio'
  | 'claude-code-stdio-local'
  | 'cursor-http'
  | 'cursor-stdio'
  | 'codex-http'
  | 'codex-stdio'
  | 'other-http'
  | 'other-stdio'
  | 'operator-enable-http';

export interface ConnectSnippet {
  id: SnippetId;
  transport: SnippetTransport;
  /** A hint for display only. */
  language: 'shell' | 'json' | 'toml' | 'text';
  code: string;
}

export interface ConnectOptions {
  /** The instance's public base URL, from `BETTER_AUTH_URL`. */
  baseUrl: string;
  /** Whether this instance mounts the streamable HTTP transport at `/mcp`. */
  httpEnabled: boolean;
}

/** Trims whitespace and trailing slashes so `<url>/mcp` never doubles a slash. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The snippets for one agent host, preferred variant first. HTTP variants are
 * left out entirely when the instance does not serve `/mcp`: a command that
 * can only fail is worse than no command.
 */
export function buildConnectSnippets(host: AgentHost, options: ConnectOptions): ConnectSnippet[] {
  const url = normalizeBaseUrl(options.baseUrl);
  const mcpUrl = `${url}/mcp`;
  const snippets: ConnectSnippet[] = [];

  switch (host) {
    case 'claude-code': {
      if (options.httpEnabled) {
        snippets.push({
          id: 'claude-code-http',
          transport: 'http',
          language: 'shell',
          code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`,
        });
      }
      snippets.push(
        {
          id: 'claude-code-stdio',
          transport: 'stdio',
          language: 'shell',
          code: `claude mcp add ${MCP_SERVER_NAME} -e CLEWWIKI_URL=${url} -e ${TOKEN_ENV_VAR}=${TOKEN_PLACEHOLDER} -- npx -y ${MCP_PACKAGE}`,
        },
        {
          id: 'claude-code-stdio-local',
          transport: 'stdio',
          language: 'shell',
          code: `claude mcp add ${MCP_SERVER_NAME} -e CLEWWIKI_URL=${url} -e ${TOKEN_ENV_VAR}=${TOKEN_PLACEHOLDER} -- node ${MCP_LOCAL_ENTRY}`,
        },
      );
      break;
    }
    case 'cursor': {
      // Cursor expands `${env:NAME}` in mcp.json, so the file names the
      // variable and never holds the value.
      if (options.httpEnabled) {
        snippets.push({
          id: 'cursor-http',
          transport: 'http',
          language: 'json',
          code: json({
            mcpServers: {
              [MCP_SERVER_NAME]: {
                url: mcpUrl,
                headers: { Authorization: `Bearer \${env:${TOKEN_ENV_VAR}}` },
              },
            },
          }),
        });
      }
      snippets.push({
        id: 'cursor-stdio',
        transport: 'stdio',
        language: 'json',
        code: json({
          mcpServers: {
            [MCP_SERVER_NAME]: {
              command: 'npx',
              args: ['-y', MCP_PACKAGE],
              env: { CLEWWIKI_URL: url, [TOKEN_ENV_VAR]: `\${env:${TOKEN_ENV_VAR}}` },
            },
          },
        }),
      });
      break;
    }
    case 'codex': {
      // Codex reads the bearer token from a named variable, and forwards named
      // variables to a stdio server, so config.toml holds no secret either way.
      if (options.httpEnabled) {
        snippets.push({
          id: 'codex-http',
          transport: 'http',
          language: 'toml',
          code: [
            `[mcp_servers.${MCP_SERVER_NAME}]`,
            `url = ${tomlString(mcpUrl)}`,
            `bearer_token_env_var = ${tomlString(TOKEN_ENV_VAR)}`,
          ].join('\n'),
        });
      }
      snippets.push({
        id: 'codex-stdio',
        transport: 'stdio',
        language: 'toml',
        code: [
          `[mcp_servers.${MCP_SERVER_NAME}]`,
          `command = "npx"`,
          `args = ["-y", ${tomlString(MCP_PACKAGE)}]`,
          `env = { CLEWWIKI_URL = ${tomlString(url)} }`,
          `env_vars = [${tomlString(TOKEN_ENV_VAR)}]`,
        ].join('\n'),
      });
      break;
    }
    case 'other': {
      if (options.httpEnabled) {
        snippets.push({
          id: 'other-http',
          transport: 'http',
          language: 'text',
          code: [
            `URL: ${mcpUrl}`,
            'Transport: streamable HTTP',
            `Header: Authorization: Bearer ${TOKEN_PLACEHOLDER}`,
          ].join('\n'),
        });
      }
      snippets.push({
        id: 'other-stdio',
        transport: 'stdio',
        language: 'shell',
        code: `CLEWWIKI_URL=${url} ${TOKEN_ENV_VAR}=${TOKEN_PLACEHOLDER} npx -y ${MCP_PACKAGE}`,
      });
      break;
    }
  }

  if (!options.httpEnabled) {
    snippets.push({
      id: 'operator-enable-http',
      transport: 'http',
      language: 'shell',
      code: `${MCP_HTTP_ENV_VAR}=true`,
    });
  }

  return snippets;
}

/** The snippet an agent should ask its human to run: the preferred one. */
export function primarySnippet(host: AgentHost, options: ConnectOptions): ConnectSnippet {
  const [first] = buildConnectSnippets(host, options);
  if (!first) {
    throw new Error(`No connection snippet for ${host}`);
  }
  return first;
}

/** `curl` against `/api/v1/me`, the cheapest call that proves a token works. */
export function buildTestCommand(options: Pick<ConnectOptions, 'baseUrl'>): string {
  return `curl -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" ${normalizeBaseUrl(options.baseUrl)}/api/v1/me`;
}

/**
 * Formats a message by key. Structurally what next-intl's translator does, so
 * the page passes one in and the tests can pass one built from the same
 * message files.
 */
export type PromptTranslator = (key: string, values?: Record<string, string>) => string;

/**
 * The onboarding text a person pastes into their agent's chat.
 *
 * Its wording lives in the message files under `connectPrompt`, in each
 * language the page offers; this function only fills in the instance URL and
 * the connection command for the chosen host.
 */
export function buildOnboardingPrompt(
  t: PromptTranslator,
  host: AgentHost,
  options: ConnectOptions,
): string {
  const url = normalizeBaseUrl(options.baseUrl);
  return t('body', {
    url,
    server: MCP_SERVER_NAME,
    command: primarySnippet(host, options).code,
    tokenVar: TOKEN_ENV_VAR,
  });
}
