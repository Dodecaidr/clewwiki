/**
 * The slice of the Confluence Cloud REST API v2 an import needs.
 *
 * Three calls: find the space by its key, list its pages with their `storage`
 * representation, and follow the cursor until there are none left. Everything
 * else about a Confluence site — permissions, labels, comments, attachments as
 * files — is deliberately out of reach, because an import that could read more
 * would need a credential that can do more.
 *
 * Credentials live in the argument list and nowhere else. They are turned into
 * one `Authorization` header inside `request`, they are never logged, never put
 * in an error message, and never returned; the caller holds them for the length
 * of one run and drops them. `describe()` exists so a caller can record what
 * the import connected to without going near the secret.
 *
 * `fetchImpl` is injectable so the whole client is testable without a network,
 * which is how the suite exercises pagination, rate limiting and error mapping.
 */

import { ImportError } from '../limits';

export interface ConfluenceCredentials {
  /** `https://example.atlassian.net`, with or without `/wiki`. */
  baseUrl: string;
  email: string;
  /** An Atlassian API token. Held in memory for the run and never stored. */
  apiToken: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  parentId: string | null;
  /** Sibling order as Confluence keeps it; absent on some instances. */
  position: number | null;
  status: string;
  storage: string;
  updatedAt: Date | null;
  webUrl: string | null;
}

export interface ConfluenceClientOptions {
  fetchImpl?: typeof fetch;
  /** How long to wait when a response carries no `Retry-After`, in ms. */
  retryDelayMs?: number;
  /** How many times one request is retried before the import gives up. */
  maxRetries?: number;
  /** Await this many milliseconds. Replaced in tests so a retry costs nothing. */
  sleep?: (ms: number) => Promise<void>;
  /** Page size asked for; Confluence caps it at 250. */
  pageSize?: number;
}

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

export class ConfluenceClient {
  private readonly origin: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pageSize: number;

  constructor(credentials: ConfluenceCredentials, options: ConfluenceClientOptions = {}) {
    this.origin = normalizeBaseUrl(credentials.baseUrl);
    this.authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`, 'utf8').toString('base64')}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 250);
  }

  /** What may be written down about this connection: an origin, never a secret. */
  describe(): { base_url: string } {
    return { base_url: this.origin };
  }

  /** The `/wiki` prefix Confluence Cloud serves the API under. */
  private url(path: string): string {
    return path.startsWith('http') ? path : `${this.origin}/wiki${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async request(path: string): Promise<unknown> {
    const target = this.url(path);
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(target, {
        headers: { Authorization: this.authorization, Accept: 'application/json' },
        redirect: 'follow',
      });

      if (response.status === 429 || response.status === 503) {
        if (attempt >= this.maxRetries) {
          throw new ImportError('unavailable', 'Confluence is rate limiting this import; try again later');
        }
        await this.sleep(retryAfterMs(response.headers.get('retry-after'), this.retryDelayMs, attempt));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        // The message names neither the address nor the account: the caller
        // already knows both, and an error body is a place a credential leaks.
        throw new ImportError('validation', 'Confluence refused the e-mail and API token');
      }
      if (response.status === 404) {
        throw new ImportError('validation', 'Confluence has no such space, or the account cannot see it');
      }
      if (!response.ok) {
        throw new ImportError('unavailable', `Confluence answered ${response.status}`);
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new ImportError('unavailable', 'Confluence answered with something that is not JSON');
      }
    }
  }

  /** The numeric id of a space, found by the key a person types. */
  async findSpaceId(spaceKey: string): Promise<{ id: string; name: string }> {
    const body = await this.request(`/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`);
    const results = asArray(record(body)?.['results']);
    const first = record(results[0]);
    const id = asString(first?.['id']);
    if (id === null) {
      throw new ImportError('validation', 'Confluence has no such space, or the account cannot see it', {
        space_key: spaceKey,
      });
    }
    return { id, name: asString(first?.['name']) ?? spaceKey };
  }

  /**
   * Every current page of a space, with its storage body.
   *
   * `limit` is the import's page cap, enforced here so a space with a hundred
   * thousand pages stops costing requests the moment the answer is known.
   */
  async listPages(spaceId: string, limit: number): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];
    let next: string | null =
      `/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?body-format=storage&status=current&limit=${this.pageSize}`;

    while (next !== null && pages.length < limit) {
      const body: unknown = await this.request(next);
      for (const entry of asArray(record(body)?.['results'])) {
        const page = toPage(entry, this.origin);
        if (page !== null) pages.push(page);
        if (pages.length >= limit) break;
      }
      next = nextLink(body);
    }
    return pages;
  }
}

/** `https://example.atlassian.net` from anything a person might paste. */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ImportError('validation', 'The Confluence address is not a URL');
  }
  if (parsed.protocol !== 'https:') {
    // An API token sent over plain HTTP is a credential handed to the network.
    throw new ImportError('validation', 'The Confluence address must use https');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * How long to wait after a 429.
 *
 * `Retry-After` is honoured when it is a number of seconds or an HTTP date;
 * without one the delay doubles per attempt, which keeps a client that is
 * already being throttled from making it worse.
 */
export function retryAfterMs(header: string | null, base: number, attempt: number): number {
  const fallback = Math.min(base * 2 ** attempt, MAX_RETRY_DELAY_MS);
  if (header === null) return fallback;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
  }
  return fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function nextLink(body: unknown): string | null {
  const links = record(record(body)?.['_links']);
  const next = asString(links?.['next']);
  if (next === null || next === '') return null;
  // v2 answers with a path relative to `/wiki`; both forms are accepted.
  return next.startsWith('/wiki') ? next.slice('/wiki'.length) : next;
}

function toPage(value: unknown, origin: string): ConfluencePage | null {
  const page = record(value);
  const id = asString(page?.['id']);
  const title = asString(page?.['title']);
  if (id === null || title === null) return null;

  const storage = asString(record(record(page?.['body'])?.['storage'])?.['value']) ?? '';
  const version = record(page?.['version']);
  const updated = asString(version?.['createdAt']);
  const webui = asString(record(page?.['_links'])?.['webui']);
  const position = page?.['position'];

  return {
    id,
    title,
    parentId: asString(page?.['parentId']),
    position: typeof position === 'number' && Number.isFinite(position) ? position : null,
    status: asString(page?.['status']) ?? 'current',
    storage,
    updatedAt: updated !== null && Number.isFinite(Date.parse(updated)) ? new Date(updated) : null,
    webUrl: webui === null ? null : `${origin}/wiki${webui}`,
  };
}
