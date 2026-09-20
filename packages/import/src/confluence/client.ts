/**
 * The slice of the Confluence REST API an import needs: v2 on a Cloud site, v1
 * on Server and Data Center.
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
 * **Server and Data Center** differ in four ways, and `deployment` selects
 * them. The API is v1 (`/rest/api/content`), where a page names its ancestors
 * instead of a parent and a listing is paged by `start`. The site may sit under
 * a context path (`https://wiki.example.com/confluence`), so the path a person
 * typed is kept. The credential is a personal access token sent as `Bearer`, a
 * username and password sent as `Basic`, or nothing at all for a space that is
 * open to anonymous reading. And the site is usually on a private network: it
 * is reachable only when the operator has listed its host name
 * (`privateHosts`), and then only on private ranges — see `address.ts`.
 *
 * A v1 listing is paged by counting, never by following the `next` link the
 * server offers: the position of the next request is then this client's
 * arithmetic, not the server's say-so.
 *
 * `fetchImpl` and `lookup` are injectable so the whole client is testable
 * without a network, which is how the suite exercises pagination, rate
 * limiting, error mapping and every refusal above.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ImportError } from '../limits';
import { isAddressAllowed, NO_PRIVATE_HOSTS, toPrivateHosts } from './address';
import type { PrivateHosts } from './address';
import { createGuardedFetch, NON_PUBLIC_MESSAGE } from './transport';

export { classifyAddress, isAddressAllowed, isNonPublicAddress, toPrivateHosts } from './address';
export type { AddressClass, PrivateHosts } from './address';
export { createGuardedFetch, createGuardedLookup } from './transport';

/** Where the Confluence runs: Atlassian's cloud, or a Server or Data Center of your own. */
export type ConfluenceDeployment = 'cloud' | 'datacenter';

export interface ConfluenceCredentials {
  /**
   * Cloud: `https://example.atlassian.net`, with or without `/wiki`.
   * Data Center: the site up to its context path, such as
   * `https://wiki.example.com/confluence`.
   */
  baseUrl: string;
  /**
   * Cloud: the Atlassian account e-mail. Data Center: a username, or empty to
   * send `apiToken` as a personal access token.
   */
  email: string;
  /**
   * Cloud: an Atlassian API token. Data Center: a personal access token, or the
   * password of `email`; empty together with `email` reads anonymously. Held in
   * memory for the run and never stored.
   */
  apiToken: string;
  /** Defaults to `cloud`. */
  deployment?: ConfluenceDeployment;
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
  /**
   * Host names the operator of this instance has opened on a private network.
   * Empty by default, which keeps every import to public addresses.
   */
  privateHosts?: Iterable<string>;
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
  privateHosts: PrivateHosts = NO_PRIVATE_HOSTS,
): Promise<void> {
  const refusal = new ImportError('validation', NON_PUBLIC_MESSAGE);
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === '' || bare.toLowerCase() === 'localhost' || bare.toLowerCase().endsWith('.localhost')) {
    throw refusal;
  }
  if (isIP(bare) !== 0) {
    if (!isAddressAllowed(bare, bare, privateHosts)) throw refusal;
    return;
  }
  let addresses: string[];
  try {
    addresses = await lookup(bare);
  } catch {
    throw new ImportError('validation', 'The Confluence address could not be resolved');
  }
  if (addresses.length === 0 || addresses.some((address) => !isAddressAllowed(bare, address, privateHosts))) {
    throw refusal;
  }
}

export class ConfluenceClient {
  private readonly deployment: ConfluenceDeployment;
  private readonly origin: string;
  /** Where API paths and downloads hang: `/wiki` on Cloud, the context path elsewhere. */
  private readonly root: string;
  /** Null when a Data Center space is read anonymously. */
  private readonly authorization: string | null;
  private readonly privateHosts: PrivateHosts;
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
    this.deployment = credentials.deployment ?? 'cloud';
    if (this.deployment === 'datacenter') {
      this.root = normalizeDataCenterBaseUrl(credentials.baseUrl);
      this.origin = new URL(this.root).origin;
    } else {
      this.origin = normalizeBaseUrl(credentials.baseUrl);
      this.root = `${this.origin}/wiki`;
    }
    this.authorization = authorizationFor(this.deployment, credentials);
    this.privateHosts = toPrivateHosts(options.privateHosts);
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 250);
    this.lookup = options.lookup;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchImpl =
      options.fetchImpl ??
      createGuardedFetch({ maxResponseBytes: this.maxResponseBytes, privateHosts: this.privateHosts });
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    // Its own transport, so that the cap on an image is enforced on the socket
    // and not after 64 MB of somebody's "screenshot" has been buffered.
    this.imageFetch =
      options.fetchImpl ??
      createGuardedFetch({ maxResponseBytes: this.maxImageBytes, privateHosts: this.privateHosts });
  }

  /** What may be written down about this connection: an origin, never a secret. */
  describe(): { base_url: string; deployment: ConfluenceDeployment } {
    return { base_url: this.deployment === 'datacenter' ? this.root : this.origin, deployment: this.deployment };
  }

  /** What a link or an attachment of this site is relative to. */
  contentBase(): string {
    return this.root;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.authorization === null ? extra : { Authorization: this.authorization, ...extra };
  }

  /**
   * The URL of an API path. Only a path: whatever the server suggested has
   * already been reduced to one by `nextLink`, so there is no input here that
   * can name another host.
   */
  private url(path: string): string {
    return `${this.root}${path.startsWith('/') ? path : `/${path}`}`;
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
        await assertPublicHost(new URL(this.origin).hostname, this.lookup, this.privateHosts);
        this.hostChecked = true;
      }
      let target = new URL(
        this.url(`/download/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(filename)}`),
      );

      for (let hop = 0, attempt = 0; hop <= MAX_DOWNLOAD_HOPS; ) {
        const sameOrigin = target.origin === this.origin;
        if (!sameOrigin) await assertPublicHost(target.hostname, this.lookup, this.privateHosts);

        const response = await this.imageFetch(target, {
          headers: sameOrigin ? this.headers() : {},
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
      await assertPublicHost(new URL(this.origin).hostname, this.lookup, this.privateHosts);
      this.hostChecked = true;
    }
    const target = this.url(path);
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(target, {
        headers: this.headers({ Accept: 'application/json' }),
        // Never followed: a redirect is the server choosing where the next
        // request, and the credential on it, goes.
        redirect: 'manual',
      });

      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw new ImportError(
          'validation',
          this.deployment === 'datacenter'
            ? 'Confluence answered with a redirect. Give the address of the site up to its context path, such as https://wiki.example.com/confluence'
            : 'Confluence answered with a redirect. Give the address of the site itself, such as https://example.atlassian.net',
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
        throw new ImportError(
          'validation',
          this.deployment === 'cloud'
            ? 'Confluence refused the e-mail and API token'
            : this.authorization === null
              ? 'Confluence does not let this space be read anonymously. Give a personal access token.'
              : 'Confluence refused the token, or the username and password',
        );
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
    if (this.deployment === 'datacenter') {
      // v1 lists content by the key itself, so the key is the id.
      const space = record(await this.request(`/rest/api/space/${encodeURIComponent(spaceKey)}`));
      const key = asString(space?.['key']);
      if (key === null) {
        throw new ImportError('validation', 'Confluence has no such space, or the account cannot see it', {
          space_key: spaceKey,
        });
      }
      return { id: key, name: asString(space?.['name']) ?? spaceKey };
    }
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
    if (this.deployment === 'datacenter') return this.listPagesV1(spaceId, limit);
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

  /**
   * The same listing over API v1.
   *
   * Paged by counting. The answer says how many entries it holds (`size`) and
   * how many it was willing to hold (`limit`, which a server may set lower than
   * what was asked); fewer than that is the last page. The `next` link is
   * ignored on purpose. A server that keeps answering full pages is stopped by
   * the import's own page cap, and one that answers full pages of nothing by
   * the bound on requests.
   */
  private async listPagesV1(spaceKey: string, limit: number): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];
    const size = Math.min(this.pageSize, V1_PAGE_SIZE);
    const maxRequests = Math.ceil(limit / size) + 2;
    let start = 0;

    for (let requests = 0; requests < maxRequests && pages.length < limit; requests += 1) {
      const body = record(
        await this.request(
          `/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&status=current` +
            `&expand=body.storage,ancestors,version,extensions.position&limit=${size}&start=${start}`,
        ),
      );
      const results = asArray(body?.['results']);
      for (const entry of results) {
        const page = toPageV1(entry, this.root);
        if (page !== null) pages.push(page);
        if (pages.length >= limit) break;
      }
      const answered = body?.['limit'];
      const pageLimit = typeof answered === 'number' && answered > 0 ? Math.min(answered, size) : size;
      if (results.length === 0 || results.length < pageLimit) break;
      start += results.length;
    }
    return pages;
  }
}

/**
 * A Data Center answers with at most this many pages when their bodies are
 * expanded, whatever is asked for; asking for it outright saves a guess.
 */
const V1_PAGE_SIZE = 50;

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
 * The site up to its context path, from what a person pasted. The path is kept
 * because a Data Center is often served under one (`/confluence`, `/wiki`); a
 * query or a fragment is never part of it.
 */
export function normalizeDataCenterBaseUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ImportError('validation', 'The Confluence address is not a URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new ImportError('validation', 'The Confluence address must use https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ImportError('validation', 'The Confluence address must not carry a username or a password');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function authorizationFor(deployment: ConfluenceDeployment, credentials: ConfluenceCredentials): string | null {
  const basic = (user: string, secret: string) =>
    `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
  if (deployment === 'cloud') return basic(credentials.email, credentials.apiToken);

  const user = credentials.email.trim();
  if (user === '' && credentials.apiToken === '') return null;
  if (user === '') return `Bearer ${credentials.apiToken}`;
  return basic(user, credentials.apiToken);
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

/** A page as API v1 describes it: ancestors instead of a parent, `version.when` for the date. */
function toPageV1(value: unknown, root: string): ConfluencePage | null {
  const page = record(value);
  const id = asString(page?.['id']);
  const title = asString(page?.['title']);
  if (id === null || title === null) return null;

  // Ancestors run from the root of the space down; the last one is the parent.
  const ancestors = asArray(page?.['ancestors']);
  const parentId = ancestors.length === 0 ? null : asString(record(ancestors[ancestors.length - 1])?.['id']);

  // `extensions.position` is a number, or the string "none" for a page nobody
  // has ordered by hand; the top-level `position` says the same with -1.
  const ordered = [record(page?.['extensions'])?.['position'], page?.['position']].find(
    (candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0,
  );

  const updated = asString(record(page?.['version'])?.['when']);
  const webui = asString(record(page?.['_links'])?.['webui']);

  return {
    id,
    title,
    parentId,
    position: ordered ?? null,
    status: asString(page?.['status']) ?? 'current',
    storage: asString(record(record(page?.['body'])?.['storage'])?.['value']) ?? '',
    updatedAt: updated !== null && Number.isFinite(Date.parse(updated)) ? new Date(updated) : null,
    webUrl: webui === null ? null : `${root}${webui.startsWith('/') ? webui : `/${webui}`}`,
  };
}
