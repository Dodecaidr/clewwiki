import { ClewwikiToolError, toolErrorFromRest } from './errors.ts';
import { USER_AGENT } from './version.ts';

/**
 * The REST client every tool goes through.
 *
 * It is deliberately thin. The MCP server owns no service logic, no cache and
 * no merge strategy: authorization, scope checks, rate limiting and the audit
 * log all live in the REST layer, and a tool that reached the database another
 * way would be a hole in all four. Page content passes through this client
 * byte for byte — nothing here rewrites, trims or summarises a body.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClewwikiClientOptions {
  /** Base URL of the instance, with or without a trailing slash. */
  baseUrl: string;
  /** Agent token sent as `Authorization: Bearer`. */
  token: string;
  /** Per-request timeout in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Injectable for tests and for the in-app HTTP transport. */
  fetch?: FetchLike;
}

export interface RestRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ClewwikiRestClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: ClewwikiClientOptions) {
    const trimmed = options.baseUrl.trim().replace(/\/+$/, '');
    if (trimmed === '') {
      throw new Error('clewwiki base URL is empty');
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`clewwiki base URL is not a URL: ${options.baseUrl}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`clewwiki base URL must be http or https, got ${parsed.protocol}`);
    }
    if (options.token.trim() === '') {
      throw new Error('clewwiki agent token is empty');
    }

    this.#baseUrl = trimmed;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * Performs one REST call and returns its parsed body.
   *
   * A non-2xx answer becomes a `ClewwikiToolError` carrying the uppercase code
   * for the REST condition, so every caller above this point handles failure
   * the same way.
   */
  async request<T = unknown>(request: RestRequest): Promise<T> {
    const url = new URL(`${this.#baseUrl}/api/v1${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.#token}`,
      'user-agent': USER_AGENT,
    };
    const init: RequestInit = { method: request.method, headers };
    if (request.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }

    let response: Response;
    try {
      init.signal = AbortSignal.timeout(this.#timeoutMs);
      response = await this.#fetch(url.toString(), init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The instance itself could not be reached. It is not a condition any
      // tool input could have avoided, and no REST code describes it, so it is
      // reported as `INTERNAL` with the transport's own words rather than
      // dressed up as something the caller did wrong.
      throw new ClewwikiToolError('INTERNAL', `Could not reach the clewwiki instance: ${reason}`, {
        base_url: this.#baseUrl,
        method: request.method,
        path: request.path,
      });
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      throw toolErrorFromRest(response.status, parsed);
    }
    return parsed as T;
  }
}
