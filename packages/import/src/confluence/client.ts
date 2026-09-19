/**
 * The slice of the Confluence Cloud REST API v2 an import needs.
 *
 * Four calls: find the space by its key, list its pages with their `storage`
 * representation, follow the cursor until there are none left, and download an
 * image a page shows. Everything else about a Confluence site — permissions,
 * labels, comments, attachments that are not pictures — is deliberately out of
 * reach, because an import that could read more would need a credential that
 * can do more.
 *
 * Credentials live in the argument list and nowhere else. They are turned into
 * one `Authorization` header inside `request`, they are never logged, never put
 * in an error message, and never returned; the caller holds them for the length
 * of one run and drops them. `describe()` exists so a caller can record what
 * the import connected to without going near the secret.
 *
 * **The address is somebody's input, and so is everything the server says.** A
 * person types the address, and from then on the server at that address decides
 * what the client requests next, through redirects and through the `next` link
 * of every listing. Left alone, that is a way to make this process send
 * requests — with a credential attached — to any host it can reach: a metadata
 * endpoint, an admin port on the loopback, a service on the private network. So:
 *
 * - the address must be `https` and must not resolve to a loopback, private,
 *   link-local or otherwise non-public address (`assertPublicHost`);
 * - a `next` link is followed only as a path on the origin that was typed — an
 *   absolute link to anywhere else ends the import;
 * - an API request follows no redirect at all;
 * - an image download follows a few, because Confluence Cloud serves every
 *   attachment by redirecting to its media host — but each hop must be `https`
 *   to a public address, and the credential goes only to the origin that was
 *   typed: a hop to any other host is made without it (`downloadAttachment`);
 * - a response is read up to a fixed size and no further.
 *
 * A check followed by a request would be two lookups, and a name server that
 * answers differently the second time — DNS rebinding — would pass the first
 * and land the second. So the default transport (`transport.ts`) makes the same
 * check inside the one resolution the socket uses: the address validated is the
 * address dialled. The check made here, before any request, is what gives a
 * clean refusal for a literal address and what still holds when a test injects
 * its own `fetchImpl`.
 *
 * `fetchImpl` and `lookup` are injectable so the whole client is testable
 * without a network, which is how the suite exercises pagination, rate
 * limiting, error mapping and every refusal above.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ImportError } from '../limits';
import { isNonPublicAddress } from './address';
import { createGuardedFetch } from './transport';

export { isNonPublicAddress } from './address';
export { createGuardedFetch, createGuardedLookup } from './transport';

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
  /** Resolves a host name to its addresses. Replaced in tests. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Largest response body read, in bytes. */
  maxResponseBytes?: number;
  /** Largest image downloaded, in bytes. */
  maxImageBytes?: number;
}

/** A downloaded image, or the reason there is none — never an exception. */
export type AttachmentDownload = { data: Uint8Array } | { failed: string };

const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * A listing of 250 pages with their bodies is a few megabytes. This is far
 * above that and far below what would hurt: the server on the other end picks
 * the size of its answer, and an answer is held in memory while it is parsed.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The origin's own redirect, then the media host's, then one to spare. A chain
 * longer than that is not how an attachment is served.
 */
const MAX_DOWNLOAD_HOPS = 3;

async function systemLookup(hostname: string): Promise<string[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

/**
 * Refuses an address that is, or resolves to, anything but public hosts. Every
 * address a name resolves to must be public: one private record among several
 * is how a name is made to land where it should not.
 */
export async function assertPublicHost(
  hostname: string,
  lookup: (hostname: string) => Promise<string[]> = systemLookup,
): Promise<void> {
  const refusal = new ImportError(
    'validation',
    'The Confluence address must be a public host. Addresses on a private network, the loopback and link-local ranges are not imported from.',
  );
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === '' || bare.toLowerCase() === 'localhost' || bare.toLowerCase().endsWith('.localhost')) {
    throw refusal;
  }
  if (isIP(bare) !== 0) {
    if (isNonPublicAddress(bare)) throw refusal;
    return;
  }
  let addresses: string[];
  try {
    addresses = await lookup(bare);
  } catch {
    throw new ImportError('validation', 'The Confluence address could not be resolved');
  }
  if (addresses.length === 0 || addresses.some((address) => isNonPublicAddress(address))) {
    throw refusal;
  }
}

export class ConfluenceClient {
  private readonly origin: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pageSize: number;
  private readonly lookup: ((hostname: string) => Promise<string[]>) | undefined;
  private readonly maxResponseBytes: number;
  private readonly maxImageBytes: number;
  private readonly imageFetch: typeof fetch;
  private hostChecked = false;

  constructor(credentials: ConfluenceCredentials, options: ConfluenceClientOptions = {}) {
    this.origin = normalizeBaseUrl(credentials.baseUrl);
    this.authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`, 'utf8').toString('base64')}`;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 250);
    this.lookup = options.lookup;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchImpl =
      options.fetchImpl ?? createGuardedFetch({ maxResponseBytes: this.maxResponseBytes });
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    // Its own transport, so that the cap on an image is enforced on the socket
    // and not after 64 MB of somebody's "screenshot" has been buffered.
    this.imageFetch =
      options.fetchImpl ?? createGuardedFetch({ maxResponseBytes: this.maxImageBytes });
  }

  /** What may be written down about this connection: an origin, never a secret. */
  describe(): { base_url: string } {
    return { base_url: this.origin };
  }

  /**
   * The URL of an API path. Only a path: whatever the server suggested has
   * already been reduced to one by `nextLink`, so there is no input here that
   * can name another host.
   */
  private url(path: string): string {
    return `${this.origin}/wiki${path.startsWith('/') ? path : `/${path}`}`;
  }

  /** Reads a body up to the cap and no further, whatever `Content-Length` claimed. */
  private async readBody(response: Response): Promise<string> {
    return Buffer.from(await this.readBytes(response, this.maxResponseBytes)).toString('utf8');
  }

  private async readBytes(response: Response, cap: number): Promise<Uint8Array> {
    const tooLarge = new ImportError('unavailable', 'Confluence answered with more than this import will read');
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) throw tooLarge;
    if (!response.body) return new Uint8Array(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge;
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  /**
   * One image attached to a page, or why it could not be had.
   *
   * It never throws for the image's own sake: a picture that is missing,
   * forbidden, too large or served from somewhere this client will not go is a
   * picture the import does without, not a reason to lose the pages.
   *
   * Confluence Cloud answers a download with a redirect to its media host,
   * carrying a short-lived signed address. So redirects are followed here, and
   * only here, under three rules: every hop is `https`; every host but the
   * origin is checked to be public before it is dialled (and again by the
   * transport, inside the socket's own lookup); and the `Authorization` header
   * is sent to the origin that was typed and to nothing else. A server that
   * redirects this client somewhere gets a request there, but never a
   * credential.
   */
  async downloadAttachment(pageId: string, filename: string): Promise<AttachmentDownload> {
    try {
      if (!this.hostChecked) {
        await assertPublicHost(new URL(this.origin).hostname, this.lookup);
        this.hostChecked = true;
      }
      let target = new URL(
        this.url(`/download/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(filename)}`),
      );

      for (let hop = 0, attempt = 0; hop <= MAX_DOWNLOAD_HOPS; ) {
        const sameOrigin = target.origin === this.origin;
        if (!sameOrigin) await assertPublicHost(target.hostname, this.lookup);

        const response = await this.imageFetch(target, {
          headers: sameOrigin ? { Authorization: this.authorization } : {},
          redirect: 'manual',
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location === null || location === '') return { failed: 'a redirect that leads nowhere' };
          let next: URL;
          try {
            next = new URL(location, target);
          } catch {
            return { failed: 'a redirect that leads nowhere' };
          }
          if (next.protocol !== 'https:') return { failed: 'a redirect away from https' };
          target = next;
          hop += 1;
          continue;
        }
        if (response.type === 'opaqueredirect') return { failed: 'a redirect that could not be read' };

        if ((response.status === 429 || response.status === 503) && attempt < this.maxRetries) {
          await this.sleep(retryAfterMs(response.headers.get('retry-after'), this.retryDelayMs, attempt));
          attempt += 1;
          continue;
        }
        if (!response.ok) return { failed: `Confluence answered ${response.status}` };

        return { data: await this.readBytes(response, this.maxImageBytes) };
      }
      return { failed: 'too many redirects' };
    } catch (error) {
      // An `ImportError` message is written to be shown. Anything else could
      // carry an address or a path, and is not.
      return { failed: error instanceof ImportError ? error.message : 'the download failed' };
    }
  }

  private async request(path: string): Promise<unknown> {
    if (!this.hostChecked) {
      await assertPublicHost(new URL(this.origin).hostname, this.lookup);
      this.hostChecked = true;
    }
    const target = this.url(path);
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(target, {
        headers: { Authorization: this.authorization, Accept: 'application/json' },
        // Never followed: a redirect is the server choosing where the next
        // request, and the credential on it, goes.
        redirect: 'manual',
      });

      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw new ImportError(
          'validation',
          'Confluence answered with a redirect. Give the address of the site itself, such as https://example.atlassian.net',
        );
      }

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

      const text = await this.readBody(response);
      try {
        return JSON.parse(text) as unknown;
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
      next = nextLink(body, this.origin);
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

/**
 * The next page of a listing, as a path under `/wiki` on the origin the import
 * was given — or an error. The link is the server's say-so about where to send
 * the next authenticated request, so an absolute link is accepted only when it
 * points back at that same origin, and is reduced to its path either way.
 */
export function nextLink(body: unknown, origin: string): string | null {
  const links = record(record(body)?.['_links']);
  const next = asString(links?.['next']);
  if (next === null || next === '') return null;

  let path = next;
  if (/^[a-z][a-z0-9+.-]*:/i.test(next) || next.startsWith('//')) {
    let parsed: URL;
    try {
      parsed = new URL(next, origin);
    } catch {
      throw new ImportError('unavailable', 'Confluence answered with a next link that is not a URL');
    }
    if (parsed.origin !== origin) {
      throw new ImportError(
        'unavailable',
        'Confluence pointed the next page of the listing at another host, which an import does not follow',
      );
    }
    path = `${parsed.pathname}${parsed.search}`;
  }
  if (!path.startsWith('/')) path = `/${path}`;
  // v2 answers with a path relative to the site root; both forms are accepted.
  return path.startsWith('/wiki/') ? path.slice('/wiki'.length) : path;
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
