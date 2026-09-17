/**
 * Every value here comes from the process environment. Nothing is defaulted to
 * a real secret: a missing secret is a startup error, not a fallback.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

export function getDatabaseUrl(): string {
  return required('DATABASE_URL');
}

export function getAuthSecret(): string {
  return required('BETTER_AUTH_SECRET');
}

export function getAuthBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';
}

export function getAppBaseUrl(): string {
  return process.env.APP_BASE_URL ?? getAuthBaseUrl();
}

/** Requests per window allowed for a single agent token. */
export function getAgentRateLimitMax(): number {
  return optionalNumber('AGENT_TOKEN_RATE_LIMIT_MAX', 60);
}

/** Length of the agent-token rate limit window, in seconds. */
export function getAgentRateLimitWindowSeconds(): number {
  return optionalNumber('AGENT_TOKEN_RATE_LIMIT_WINDOW', 60);
}

/**
 * Whether the streamable HTTP MCP transport is mounted at `/mcp`.
 *
 * Off unless the operator says otherwise, and the route answers 404 rather
 * than 403 while it is off: an endpoint nobody enabled should not announce
 * that it exists. stdio needs none of this — that transport runs on the
 * developer's own machine and reaches the instance as an ordinary REST client.
 */
export function isMcpHttpEnabled(): boolean {
  return process.env.MCP_HTTP_ENABLED === 'true';
}

/**
 * Browser origins allowed to reach `/mcp`, empty by default.
 *
 * A request with no `Origin` header is not a browser request and passes; a
 * request that carries one is refused unless the operator listed it. The
 * default of "nothing" is the direct mitigation for DNS rebinding, where a
 * page the user did not open reaches a local MCP endpoint through their
 * browser and borrows its network position.
 */
export function getMcpAllowedOrigins(): string[] {
  const raw = process.env.MCP_HTTP_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

/**
 * Where the MCP endpoint reaches the REST API — this same application.
 *
 * The MCP server is a REST client, here as much as over stdio: it holds the
 * caller's token and calls the public API with it, so authorization, scope
 * checks, rate limiting and the audit row all happen exactly once, in the
 * handlers, with no private path around them. The default is the loopback
 * address and the port the server is listening on, so the call never leaves
 * the container and never depends on the reverse proxy in front of it.
 */
export function getMcpInternalBaseUrl(): string {
  const configured = process.env.MCP_INTERNAL_BASE_URL;
  if (configured && configured.trim() !== '') return configured.trim();
  const port = process.env.PORT && process.env.PORT.trim() !== '' ? process.env.PORT.trim() : '3000';
  return `http://127.0.0.1:${port}`;
}

/**
 * Where the server keeps its mirror of each workspace's source repository.
 *
 * One directory per workspace, holding a bare clone: the anchor checker reads
 * blobs out of it with `git show` and never creates a working tree, so nothing
 * from the repository is ever laid out on disk in a form something could
 * execute.
 */
export function getReposDir(): string {
  const configured = process.env.REPOS_DIR;
  return configured && configured.trim() !== '' ? configured : '/data/repos';
}

/**
 * Reads the access token for a repository out of the environment.
 *
 * The workspace setting names the variable; the value never enters the
 * database, an API response or a log line.
 */
export function getRepositoryToken(variableName: string | undefined | null): string | null {
  if (!variableName) return null;
  const value = process.env[variableName];
  return value && value.trim() !== '' ? value : null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
