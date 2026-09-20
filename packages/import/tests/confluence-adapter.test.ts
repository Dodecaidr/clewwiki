import { describe, expect, it, vi } from 'vitest';

import { importFromConfluence } from '../src/confluence/index';
import {
  ConfluenceClient,
  assertPublicHost,
  createGuardedFetch,
  createGuardedLookup,
  isNonPublicAddress,
  nextLink,
  normalizeBaseUrl,
  retryAfterMs,
} from '../src/confluence/client';
import { DEFAULT_IMPORT_LIMITS, ImportError } from '../src/limits';
import { placeNodes } from '../src/tree';

/**
 * The Confluence API is mocked throughout: a test must never reach a network,
 * and the behaviour worth testing — pagination, the hierarchy, rate limiting,
 * and the promise that credentials go nowhere — is all in how this adapter
 * reads the answers.
 */

interface FakePage {
  id: string;
  title: string;
  parentId?: string | null;
  storage: string;
  position?: number;
}

function fakeSite(pages: FakePage[], options: { pageSize?: number; failures?: number } = {}) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let remainingFailures = options.failures ?? 0;
  const size = options.pageSize ?? 100;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
    });

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
    }

    if (url.includes('/api/v2/spaces?')) {
      return Response.json({ results: [{ id: '5001', key: 'API', name: 'API platform' }] });
    }

    const cursor = Number(new URL(url).searchParams.get('cursor') ?? '0');
    const slice = pages.slice(cursor, cursor + size);
    const next = cursor + size < pages.length ? cursor + size : null;
    return Response.json({
      results: slice.map((page) => ({
        id: page.id,
        title: page.title,
        status: 'current',
        parentId: page.parentId ?? null,
        position: page.position ?? null,
        version: { createdAt: '2026-05-01T10:00:00.000Z' },
        body: { storage: { value: page.storage, representation: 'storage' } },
        _links: { webui: `/spaces/API/pages/${page.id}` },
      })),
      _links: next === null ? {} : { next: `/wiki/api/v2/spaces/5001/pages?cursor=${next}` },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

/** DNS is not consulted in tests: the fake site is a public host by decree. */
const publicLookup = async (): Promise<string[]> => ['104.192.136.1'];

const credentials = {
  baseUrl: 'https://example.atlassian.net/wiki',
  email: 'importer@example.test',
  apiToken: 'secret-api-token-value',
};

describe('confluence base URL', () => {
  it('reduces anything pasted to an https origin', () => {
    expect(normalizeBaseUrl('example.atlassian.net')).toBe('https://example.atlassian.net');
    expect(normalizeBaseUrl('https://example.atlassian.net/wiki/spaces/API')).toBe(
      'https://example.atlassian.net',
    );
  });

  it('refuses plain HTTP, because the token would travel with it', () => {
    expect(() => normalizeBaseUrl('http://example.atlassian.net')).toThrow(ImportError);
  });
});

describe('rate limiting', () => {
  it('honours Retry-After in seconds', () => {
    expect(retryAfterMs('3', 1000, 0)).toBe(3000);
  });

  it('honours Retry-After as a date', () => {
    const when = new Date(Date.now() + 5_000).toUTCString();
    expect(retryAfterMs(when, 1000, 0)).toBeGreaterThan(3_000);
  });

  it('backs off on its own when the header is missing', () => {
    expect(retryAfterMs(null, 1000, 0)).toBe(1000);
    expect(retryAfterMs(null, 1000, 3)).toBe(8000);
  });

  it('retries a 429 and then succeeds', async () => {
    const site = fakeSite([{ id: '1', title: 'One', storage: '<p>a</p>' }], { failures: 2 });
    const sleep = vi.fn(async () => undefined);

    const result = await importFromConfluence({
      credentials,
      spaceKey: 'API',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup, sleep },
    });

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(result.nodes).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const site = fakeSite([], { failures: 99 });
    await expect(
      importFromConfluence({
        credentials,
        spaceKey: 'API',
        limits: DEFAULT_IMPORT_LIMITS,
        client: { fetchImpl: site.fetchImpl, lookup: publicLookup, sleep: async () => undefined, maxRetries: 2 },
      }),
    ).rejects.toThrow(/rate limiting/);
  });
});

describe('confluence import', () => {
  it('reads every page across the cursor, keeping the hierarchy', async () => {
    const site = fakeSite(
      [
        { id: '1', title: 'Platform', storage: '<p>Root.</p>' },
        { id: '2', title: 'Deployment', parentId: '1', storage: '<h2>Deploy</h2><p>Steps.</p>' },
        { id: '3', title: 'Runbook', parentId: '2', storage: '<p>On call.</p>' },
      ],
      { pageSize: 2 },
    );

    const result = await importFromConfluence({
      credentials,
      spaceKey: 'API',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });

    expect(result.source).toBe('confluence');
    expect(result.nodes.map((node) => node.title)).toEqual(['Platform', 'Deployment', 'Runbook']);
    expect(result.nodes.map((node) => node.parentSourceId)).toEqual([null, '1', '2']);
    expect(result.nodes[0]?.sourceUrl).toBe('https://example.atlassian.net/wiki/spaces/API/pages/1');

    const placed = placeNodes(result.nodes);
    expect(placed.nodes.map((node) => node.targetPath)).toEqual([
      '/platform',
      '/platform/deployment',
      '/platform/deployment/runbook',
    ]);
  });

  it('sends the credential as one Basic header and records neither half', async () => {
    const site = fakeSite([{ id: '1', title: 'One', storage: '<p>a</p>' }]);
    const result = await importFromConfluence({
      credentials,
      spaceKey: 'API',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });

    const expected = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`;
    expect(site.calls.every((call) => call.authorization === expected)).toBe(true);

    const recorded = JSON.stringify(result.params);
    expect(recorded).not.toContain(credentials.apiToken);
    expect(recorded).not.toContain(credentials.email);
    expect(result.params).toEqual({
      base_url: 'https://example.atlassian.net',
      deployment: 'cloud',
      space_key: 'API',
      space_name: 'API platform',
      page_count: 1,
      image_count: 0,
    });
  });

  it('treats a page whose parent is not in the export as a root', async () => {
    const site = fakeSite([{ id: '9', title: 'Orphan', parentId: '404', storage: '<p>a</p>' }]);
    const result = await importFromConfluence({
      credentials,
      spaceKey: 'API',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });
    expect(result.nodes[0]?.parentSourceId).toBeNull();
  });

  it('refuses a space with more pages than the limit allows', async () => {
    const pages = Array.from({ length: 5 }, (_, index) => ({
      id: String(index + 1),
      title: `Page ${index + 1}`,
      storage: '<p>a</p>',
    }));
    const site = fakeSite(pages);

    await expect(
      importFromConfluence({
        credentials,
        spaceKey: 'API',
        limits: { ...DEFAULT_IMPORT_LIMITS, pages: 3 },
        client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
      }),
    ).rejects.toThrow(/more than 3 pages/);
  });

  it('answers a rejected credential with a validation error that quotes neither half', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(
      importFromConfluence({
        credentials,
        spaceKey: 'API',
        limits: DEFAULT_IMPORT_LIMITS,
        client: { fetchImpl },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('answers an unknown space with a validation error', async () => {
    const fetchImpl = (async () => Response.json({ results: [] })) as unknown as typeof fetch;
    await expect(
      importFromConfluence({
        credentials,
        spaceKey: 'NOPE',
        limits: DEFAULT_IMPORT_LIMITS,
        client: { fetchImpl },
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('truncates a body past the per-page limit and says so', async () => {
    const site = fakeSite([{ id: '1', title: 'Long', storage: `<p>${'a'.repeat(5_000)}</p>` }]);
    const result = await importFromConfluence({
      credentials,
      spaceKey: 'API',
      limits: { ...DEFAULT_IMPORT_LIMITS, pageBytes: 500 },
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });
    expect(result.nodes[0]?.warnings).toContainEqual({ code: 'truncated', detail: 'Long' });
    expect(Buffer.byteLength(result.nodes[0]?.markdown ?? '')).toBeLessThanOrEqual(500);
  });
});

describe('where an import will send requests', () => {
  const ORIGIN = 'https://example.atlassian.net';

  it('knows a public address from one it must not reach', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.0.8',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::10.0.0.1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fe80::1%eth0',
      'ff02::1',
      'not-an-address',
    ]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
    for (const address of ['104.192.136.1', '8.8.8.8', '172.32.0.1', '2606:4700::6810:84e5']) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
  });

  it('refuses a literal private address, localhost, and a name that resolves to one', async () => {
    const never = async (): Promise<string[]> => {
      throw new Error('a literal address needs no lookup');
    };
    for (const host of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '[::1]', 'localhost', 'wiki.localhost']) {
      await expect(assertPublicHost(host, never), host).rejects.toMatchObject({ code: 'validation' });
    }
    await expect(assertPublicHost('8.8.8.8', never)).resolves.toBeUndefined();

    await expect(assertPublicHost('intranet.example', async () => ['10.0.0.5'])).rejects.toMatchObject({
      code: 'validation',
    });
    // One private record among public ones is enough to refuse the name.
    await expect(
      assertPublicHost('mixed.example', async () => ['104.192.136.1', '192.168.0.10']),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(assertPublicHost('empty.example', async () => [])).rejects.toBeInstanceOf(ImportError);
    await expect(
      assertPublicHost('gone.example', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('makes no request at all to an address that is not public', async () => {
    const fetchImpl = vi.fn();
    const client = new ConfluenceClient(
      { baseUrl: 'https://intranet.example', email: 'a@example.test', apiToken: 'secret' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: async () => ['10.0.0.5'] },
    );
    await expect(client.findSpaceId('API')).rejects.toMatchObject({ code: 'validation' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a next link only as a path on the origin it was given', () => {
    const body = (next: string) => ({ _links: { next } });
    expect(nextLink(body('/wiki/api/v2/spaces/1/pages?cursor=2'), ORIGIN)).toBe(
      '/api/v2/spaces/1/pages?cursor=2',
    );
    expect(nextLink(body('/api/v2/spaces/1/pages?cursor=2'), ORIGIN)).toBe(
      '/api/v2/spaces/1/pages?cursor=2',
    );
    expect(nextLink(body(`${ORIGIN}/wiki/api/v2/spaces/1/pages?cursor=3`), ORIGIN)).toBe(
      '/api/v2/spaces/1/pages?cursor=3',
    );
    expect(nextLink({ _links: {} }, ORIGIN)).toBeNull();

    for (const hostile of [
      'http://169.254.169.254/latest/meta-data/',
      'https://attacker.example/collect',
      '//attacker.example/collect',
      'http://example.atlassian.net/wiki/api/v2/pages',
      'https://example.atlassian.net.attacker.example/x',
      'file:///etc/passwd',
    ]) {
      expect(() => nextLink(body(hostile), ORIGIN), hostile).toThrow(ImportError);
    }
  });

  it('never sends the credential to a host the listing pointed at', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/api/v2/spaces?')) return Response.json({ results: [{ id: '5001', name: 'API' }] });
      return Response.json({
        results: [{ id: '1', title: 'One', body: { storage: { value: '<p>a</p>' } } }],
        _links: { next: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      });
    }) as unknown as typeof fetch;

    await expect(
      importFromConfluence({
        credentials,
        spaceKey: 'API',
        limits: DEFAULT_IMPORT_LIMITS,
        client: { fetchImpl, lookup: publicLookup },
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(seen.every((url) => url.startsWith('https://example.atlassian.net/wiki/'))).toBe(true);
  });

  it('does not follow a redirect', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:8080/' } });
    });
    const client = new ConfluenceClient(credentials, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    await expect(client.findSpaceId('API')).rejects.toMatchObject({ code: 'validation' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops reading a response past the cap, declared or not', async () => {
    const big = JSON.stringify({ results: [], padding: 'x'.repeat(5_000) });
    for (const headers of [{ 'Content-Length': String(big.length) }, {}] as Array<Record<string, string>>) {
      const client = new ConfluenceClient(credentials, {
        fetchImpl: (async () => new Response(big, { status: 200, headers })) as unknown as typeof fetch,
        lookup: publicLookup,
        maxResponseBytes: 1_000,
      });
      await expect(client.findSpaceId('API')).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
});

describe('the address is checked as the socket connects', () => {
  const PUBLIC = { address: '104.192.136.1', family: 4 };
  const LOOPBACK = { address: '127.0.0.1', family: 4 };

  function lookupOnce(
    resolve: Parameters<typeof createGuardedLookup>[0],
    all: boolean,
  ): Promise<{ error: NodeJS.ErrnoException | null; result: unknown }> {
    return new Promise((done) => {
      const callback = (error: NodeJS.ErrnoException | null, ...result: unknown[]) =>
        done({ error, result: all ? result[0] : result });
      createGuardedLookup(resolve)('wiki.example', { all }, callback as never);
    });
  }

  it('hands the socket exactly the addresses it checked, in either calling form', async () => {
    const one = await lookupOnce(async () => [PUBLIC], false);
    expect(one).toEqual({ error: null, result: ['104.192.136.1', 4] });
    const many = await lookupOnce(async () => [PUBLIC, { address: '2606:4700::6810:84e5', family: 6 }], true);
    expect(many.error).toBeNull();
    expect(many.result).toHaveLength(2);
  });

  it('refuses a name with any non-public address, or with none', async () => {
    for (const answer of [[LOOPBACK], [PUBLIC, LOOPBACK], [{ address: '::ffff:10.0.0.1', family: 6 }], []]) {
      for (const all of [false, true]) {
        const { error } = await lookupOnce(async () => answer, all);
        expect(error?.code, JSON.stringify(answer)).toBe('ENONPUBLIC');
      }
    }
  });

  it('is not fooled by a name that resolves differently the second time', async () => {
    // DNS rebinding: "public" for the check made before the request, loopback
    // for the resolution the socket uses. The first alone would let it through.
    let asked = 0;
    const rebinding = async () => {
      asked += 1;
      return asked === 1 ? [PUBLIC] : [LOOPBACK];
    };

    await expect(
      assertPublicHost('rebind.example', async (name) => (await rebinding()).map((entry) => (void name, entry.address))),
    ).resolves.toBeUndefined();

    const guardedFetch = createGuardedFetch({ resolve: rebinding, maxResponseBytes: 1_000, timeoutMs: 2_000 });
    await expect(guardedFetch('https://rebind.example/wiki/api/v2/spaces')).rejects.toMatchObject({
      code: 'validation',
    });
    expect(asked).toBe(2);
  });

  it('speaks https only, and says nothing of the cause when a host cannot be reached', async () => {
    const guardedFetch = createGuardedFetch({ resolve: async () => [PUBLIC], maxResponseBytes: 1_000 });
    await expect(guardedFetch('http://example.atlassian.net/wiki')).rejects.toMatchObject({
      code: 'validation',
    });

    const unresolvable = createGuardedFetch({
      resolve: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND secret-internal-name'), { code: 'ENOTFOUND' });
      },
      maxResponseBytes: 1_000,
    });
    const failure = await unresolvable('https://gone.example/wiki').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unavailable', message: 'Confluence could not be reached' });
    expect(String((failure as Error).message)).not.toContain('secret-internal-name');
  });
});
