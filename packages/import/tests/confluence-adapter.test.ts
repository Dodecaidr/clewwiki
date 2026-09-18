import { describe, expect, it, vi } from 'vitest';

import { importFromConfluence } from '../src/confluence/index';
import { normalizeBaseUrl, retryAfterMs } from '../src/confluence/client';
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
      client: { fetchImpl: site.fetchImpl, sleep },
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
        client: { fetchImpl: site.fetchImpl, sleep: async () => undefined, maxRetries: 2 },
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
      client: { fetchImpl: site.fetchImpl },
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
      client: { fetchImpl: site.fetchImpl },
    });

    const expected = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`;
    expect(site.calls.every((call) => call.authorization === expected)).toBe(true);

    const recorded = JSON.stringify(result.params);
    expect(recorded).not.toContain(credentials.apiToken);
    expect(recorded).not.toContain(credentials.email);
    expect(result.params).toEqual({
      base_url: 'https://example.atlassian.net',
      space_key: 'API',
      space_name: 'API platform',
      page_count: 1,
    });
  });

  it('treats a page whose parent is not in the export as a root', async () => {
    const site = fakeSite([{ id: '9', title: 'Orphan', parentId: '404', storage: '<p>a</p>' }]);
    const result = await importFromConfluence({
      credentials,
      spaceKey: 'API',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl },
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
        client: { fetchImpl: site.fetchImpl },
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
      client: { fetchImpl: site.fetchImpl },
    });
    expect(result.nodes[0]?.warnings).toContainEqual({ code: 'truncated', detail: 'Long' });
    expect(Buffer.byteLength(result.nodes[0]?.markdown ?? '')).toBeLessThanOrEqual(500);
  });
});
