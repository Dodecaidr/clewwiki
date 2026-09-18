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
 * Discussion messages one actor may post per window.
 *
 * Tighter than the general request limit on purpose: a message is the cheapest
 * write in the API to repeat, and a thread nobody can read is a thread that has
 * stopped doing its job.
 */
export function getDiscussionMessageRateLimitMax(): number {
  return optionalNumber('DISCUSSION_MESSAGE_RATE_LIMIT_MAX', 20);
}

/** Length of the discussion-message rate limit window, in seconds. */
export function getDiscussionMessageRateLimitWindowSeconds(): number {
  return optionalNumber('DISCUSSION_MESSAGE_RATE_LIMIT_WINDOW', 60);
}

/**
 * Largest import upload, in megabytes. The whole upload is held in memory while
 * it is parsed, so this is a statement about the instance's memory as much as
 * about what people may import.
 */
export function getImportMaxUploadMb(): number {
  return optionalNumber('IMPORT_MAX_UPLOAD_MB', 200);
}

/**
 * Most an uploaded archive may expand to, in megabytes. Expanded entries are
 * held in memory alongside the upload until the import is staged: the two
 * together are what one import can cost, and a container with less memory than
 * that is killed rather than refused. Lower both on a small instance.
 */
export function getImportMaxExpandedMb(): number {
  return optionalNumber('IMPORT_MAX_EXPANDED_MB', 256);
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
 * The only environment variable names a repository setting may point at:
 * `CLEWWIKI_GIT_TOKEN`, or `CLEWWIKI_GIT_TOKEN_<NAME>` for a second repository
 * credential.
 *
 * The setting is written by a workspace administrator, and the process
 * environment also holds the database URL and the session-signing secret. A
 * dedicated namespace is what keeps "name a variable" from meaning "read any
 * secret this process has and send it to a URL of your choosing".
 */
export const REPOSITORY_TOKEN_ENV_PATTERN = /^CLEWWIKI_GIT_TOKEN(?:_[A-Z0-9]{1,40})?$/;

/**
 * Reads the access token for a repository out of the environment.
 *
 * The workspace setting names the variable; the value never enters the
 * database, an API response or a log line. The name is checked again here,
 * not only when the setting is saved, so a setting stored by an older release
 * cannot reach outside the namespace either.
 */
export function getRepositoryToken(variableName: string | undefined | null): string | null {
  if (!variableName) return null;
  if (!REPOSITORY_TOKEN_ENV_PATTERN.test(variableName)) return null;
  const value = process.env[variableName];
  return value && value.trim() !== '' ? value : null;
}

/**
 * Whether a workspace may link a `file://` repository.
 *
 * A file URL reads any git repository the application's user can see on the
 * host or in the container, so it is an operator decision rather than an
 * administrator one: off unless `ALLOW_FILE_REPOSITORIES=true`.
 */
export function areFileRepositoriesAllowed(): boolean {
  return process.env.ALLOW_FILE_REPOSITORIES === 'true';
}

/**
 * The request header that carries the client's address, as set by the
 * reverse proxy in front of the application.
 *
 * `X-Real-IP` by default, because each of the three documented proxies can be
 * made to overwrite it with the address it actually accepted the connection
 * from. `X-Forwarded-For` is deliberately not the default: a proxy appends to
 * it, so its first entry is whatever the client chose to send.
 */
export function getTrustedClientIpHeader(): string {
  const configured = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  return configured && /^[a-z0-9-]{1,64}$/.test(configured) ? configured : 'x-real-ip';
}

/**
 * The one-time token first-run setup requires, when the operator chose it.
 * Unset means the server generates one at start-up and prints it to its log.
 */
export function getConfiguredSetupToken(): string | null {
  const value = process.env.CLEWWIKI_SETUP_TOKEN?.trim();
  return value ? value : null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
