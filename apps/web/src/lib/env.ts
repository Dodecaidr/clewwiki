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
 * Host names of Confluence sites on a private network that imports may reach.
 *
 * An import connects to an address somebody typed, so by default it connects
 * only to public addresses: without that rule the form is a way to make this
 * server fetch from its own network. A Confluence Server or Data Center is
 * normally *on* that network, which is why this exists — but it is the
 * operator's decision, made once, by host name, not the importing person's.
 *
 * Only the private ranges open up (RFC 1918, carrier-grade NAT, IPv6 unique
 * local). The loopback, link-local — where cloud metadata lives — multicast
 * and reserved space stay refused whatever is listed here, so this cannot be
 * turned into a way to read the container's own ports.
 *
 * Comma-separated host names, never addresses: the name is what is checked, and
 * what it resolves to is checked again as the socket connects.
 */
export function getImportConfluencePrivateHosts(): string[] {
  return (process.env.IMPORT_CONFLUENCE_PRIVATE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== '');
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

/**
 * Largest image a page accepts, in megabytes. `0` switches image uploads off:
 * an instance that does not want to serve bytes its users supplied can say so.
 * The table refuses anything past 10 MB whatever this says.
 */
export function getImageMaxUploadMb(): number {
  const raw = process.env.IMAGE_MAX_UPLOAD_MB;
  if (raw !== undefined && raw.trim() === '0') return 0;
  return Math.min(optionalNumber('IMAGE_MAX_UPLOAD_MB', 5), 10);
}

/**
 * Most a workspace's images may occupy together, in megabytes. Images live in
 * the database, so this is what keeps a wiki's backup from becoming a photo
 * archive without anybody having decided that.
 */
export function getImageStoreMaxMb(): number {
  return optionalNumber('IMAGE_STORE_MAX_MB', 2048);
}

/** Image uploads one actor may make per window. */
export function getImageUploadRateLimitMax(): number {
  return optionalNumber('IMAGE_UPLOAD_RATE_LIMIT_MAX', 30);
}

/** Length of the image-upload rate limit window, in seconds. */
export function getImageUploadRateLimitWindowSeconds(): number {
  return optionalNumber('IMAGE_UPLOAD_RATE_LIMIT_WINDOW', 60);
}

/**
 * Where attached files are kept: `local` for a directory on this machine
 * (`FILES_DIR`), `off` for no attached files at all. Unset is `off`, so an
 * instance only starts accepting files once somebody has decided where they
 * go — a directory inside the container that is not a volume would lose every
 * file on the next image update. The shipped compose file sets `local` and
 * mounts the volume.
 */
export function getFilesDriver(): 'local' | 's3' | 'off' {
  const raw = process.env.FILES_DRIVER?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'off') return 'off';
  if (raw === 'local' || raw === 's3') return raw;
  throw new Error('Environment variable FILES_DRIVER must be local, s3 or off');
}

export interface FilesS3Settings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
}

/**
 * The bucket of `FILES_DRIVER=s3`. Endpoint, bucket and both halves of the key
 * are required: an instance told to keep files in a bucket it cannot name
 * refuses to take any, rather than falling back to a directory nobody backs up.
 */
export function getFilesS3Settings(): FilesS3Settings {
  const value = (name: string) => process.env[name]?.trim() ?? '';
  const settings = {
    endpoint: value('FILES_S3_ENDPOINT'),
    bucket: value('FILES_S3_BUCKET'),
    region: value('FILES_S3_REGION') || 'us-east-1',
    accessKeyId: value('FILES_S3_ACCESS_KEY_ID'),
    secretAccessKey: value('FILES_S3_SECRET_ACCESS_KEY'),
    forcePathStyle: value('FILES_S3_FORCE_PATH_STYLE').toLowerCase() !== 'false',
    prefix: value('FILES_S3_PREFIX'),
  };
  const missing = (['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).filter(
    (key) => settings[key] === '',
  );
  if (missing.length > 0) {
    throw new Error(
      `FILES_DRIVER=s3 needs FILES_S3_ENDPOINT, FILES_S3_BUCKET, FILES_S3_ACCESS_KEY_ID and FILES_S3_SECRET_ACCESS_KEY`,
    );
  }
  return settings;
}

/** The directory the `local` file store writes under. */
export function getFilesDir(): string {
  const configured = process.env.FILES_DIR;
  return configured && configured.trim() !== '' ? configured : '/data/files';
}

/**
 * Largest single file, in megabytes. The upload is streamed to disk as it
 * arrives and never held in memory, so this is about disk and patience, not
 * about the size of the container.
 */
export function getFilesMaxUploadMb(): number {
  return optionalNumber('FILES_MAX_UPLOAD_MB', 512);
}

/**
 * Most a workspace's files may occupy together, in megabytes, counting each
 * distinct content once: re-uploading a file, or restoring an old version,
 * costs nothing.
 */
export function getFilesStoreMaxMb(): number {
  return optionalNumber('FILES_STORE_MAX_MB', 20480);
}
