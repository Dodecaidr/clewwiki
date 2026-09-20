import { describe, expect, it } from 'vitest';

import { importFromConfluence } from '../src/confluence/index';
import {
  ConfluenceClient,
  assertPublicHost,
  classifyAddress,
  createGuardedLookup,
  isAddressAllowed,
  normalizeDataCenterBaseUrl,
  toPrivateHosts,
} from '../src/confluence/client';
import { DEFAULT_IMPORT_LIMITS, ImportError } from '../src/limits';

/**
 * Confluence Server and Data Center, which speak REST API v1.
 *
 * The fake site answers in the shapes a real Data Center does — the fixtures
 * below were taken from a public one (cwiki.apache.org) on 2026-09-20: a page
 * names its `ancestors` rather than a parent, its date is `version.when`, its
 * order is `extensions.position` (the string `none` when nobody set one), and a
 * listing is paged by `start` with `size` and `limit` beside it.
 *
 * Nothing here reaches a network.
 */

const PUBLIC = '104.192.136.1';
const publicLookup = async () => [PUBLIC];

interface FakePage {
  id: string;
  title: string;
  ancestors?: string[];
  storage: string;
  position?: number | 'none';
}

function fakeDataCenter(
  pages: FakePage[],
  options: { pageSize?: number; serverLimit?: number; status?: number; base?: string } = {},
) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const size = options.serverLimit ?? options.pageSize ?? 50;
  const base = options.base ?? 'https://wiki.example.com/confluence';

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (options.status !== undefined) return new Response('nope', { status: options.status });

    if (url.includes('/rest/api/space/')) {
      return Response.json({ id: 28114946, key: 'ENG', name: 'Engineering', type: 'global' });
    }

    const params = new URL(url).searchParams;
    const start = Number(params.get('start') ?? '0');
    const asked = Number(params.get('limit') ?? '50');
    const limit = Math.min(asked, size);
    const slice = pages.slice(start, start + limit);
    return Response.json({
      results: slice.map((page) => ({
        id: page.id,
        type: 'page',
        status: 'current',
        title: page.title,
        position: -1,
        version: { when: '2011-07-19T14:49:54.000Z', number: 2 },
        ancestors: (page.ancestors ?? []).map((id) => ({ id, type: 'page' })),
        body: { storage: { value: page.storage, representation: 'storage' } },
        extensions: { position: page.position ?? 'none' },
        _links: { webui: `/spaces/ENG/pages/${page.id}/${page.title.replace(/ /g, '+')}` },
      })),
      start,
      limit,
      size: slice.length,
      // A real site offers this. The client must page by counting instead, so
      // the fake points it somewhere it must never go.
      _links: {
        next: 'https://attacker.example/rest/api/content?start=999',
        base,
        context: '/confluence',
      },
    });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

const dataCenter = {
  baseUrl: 'https://wiki.example.com/confluence',
  email: '',
  apiToken: 'pat-secret',
  deployment: 'datacenter' as const,
};

describe('the address of a Data Center', () => {
  it('keeps the context path and drops what is not part of it', () => {
    expect(normalizeDataCenterBaseUrl('https://wiki.example.com/confluence/')).toBe(
      'https://wiki.example.com/confluence',
    );
    expect(normalizeDataCenterBaseUrl('wiki.example.com/confluence?x=1#y')).toBe(
      'https://wiki.example.com/confluence',
    );
    expect(normalizeDataCenterBaseUrl('https://wiki.example.com')).toBe('https://wiki.example.com');
  });

  it('refuses plain HTTP and an address carrying a credential', () => {
    expect(() => normalizeDataCenterBaseUrl('http://wiki.example.com/confluence')).toThrow(ImportError);
    expect(() => normalizeDataCenterBaseUrl('https://user:pass@wiki.example.com')).toThrow(ImportError);
  });
});

describe('what a Data Center import may reach', () => {
  it('sorts an address into public, private and never', () => {
    expect(classifyAddress('104.192.136.1')).toBe('public');
    for (const address of ['10.0.0.5', '172.16.4.1', '192.168.1.10', '100.64.0.1', 'fd00::1']) {
      expect(classifyAddress(address), address).toBe('private');
    }
    for (const address of ['127.0.0.1', '169.254.169.254', '::1', '0.0.0.0', '224.0.0.1', 'fe80::1']) {
      expect(classifyAddress(address), address).toBe('forbidden');
    }
  });

  it('opens a private range only for a host name the operator listed', () => {
    const listed = toPrivateHosts(['Wiki.Example.com', ' ', 'other.internal']);
    expect(isAddressAllowed('wiki.example.com', '10.0.0.5', listed)).toBe(true);
    expect(isAddressAllowed('elsewhere.internal', '10.0.0.5', listed)).toBe(false);
    // Listing a name never reaches the loopback or cloud metadata.
    expect(isAddressAllowed('wiki.example.com', '127.0.0.1', listed)).toBe(false);
    expect(isAddressAllowed('wiki.example.com', '169.254.169.254', listed)).toBe(false);
  });

  it('refuses a private site that was not listed, and accepts the one that was', async () => {
    const privateLookup = async () => ['10.4.0.9'];
    await expect(assertPublicHost('wiki.example.com', privateLookup)).rejects.toThrow(ImportError);
    await expect(
      assertPublicHost('wiki.example.com', privateLookup, toPrivateHosts(['wiki.example.com'])),
    ).resolves.toBeUndefined();
    await expect(
      assertPublicHost('wiki.example.com', async () => ['127.0.0.1'], toPrivateHosts(['wiki.example.com'])),
    ).rejects.toThrow(ImportError);
  });

  it('gives the socket the same rule', async () => {
    const answer = [{ address: '10.4.0.9', family: 4 }];
    const ask = (hosts: string[]) =>
      new Promise<NodeJS.ErrnoException | null>((done) => {
        createGuardedLookup(async () => answer, toPrivateHosts(hosts))(
          'wiki.example.com',
          { all: false },
          ((error: NodeJS.ErrnoException | null) => done(error)) as never,
        );
      });
    expect((await ask([]))?.code).toBe('ENONPUBLIC');
    expect(await ask(['wiki.example.com'])).toBeNull();
  });

  it('says in the refusal how an operator opens a site up', async () => {
    await expect(assertPublicHost('wiki.example.com', async () => ['10.4.0.9'])).rejects.toThrow(
      /IMPORT_CONFLUENCE_PRIVATE_HOSTS/,
    );
  });
});

describe('reading a Data Center space', () => {
  it('reads every page across the start parameter, keeping the hierarchy', async () => {
    const site = fakeDataCenter(
      [
        { id: '1', title: 'Platform', storage: '<p>Root.</p>' },
        { id: '2', title: 'Deployment', ancestors: ['1'], storage: '<h2>Deploy</h2><p>Steps.</p>' },
        { id: '3', title: 'Runbook', ancestors: ['1', '2'], storage: '<p>On call.</p>' },
      ],
      { serverLimit: 2 },
    );

    const result = await importFromConfluence({
      credentials: dataCenter,
      spaceKey: 'ENG',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });

    expect(result.nodes.map((node) => node.title)).toEqual(['Platform', 'Deployment', 'Runbook']);
    // The last ancestor is the parent, not the first.
    expect(result.nodes.map((node) => node.parentSourceId)).toEqual([null, '1', '2']);
    expect(result.nodes[0]?.sourceUrl).toBe(
      'https://wiki.example.com/confluence/spaces/ENG/pages/1/Platform',
    );
    expect(result.nodes[0]?.updatedAt?.toISOString()).toBe('2011-07-19T14:49:54.000Z');
    expect(result.nodes[1]?.markdown).toContain('## Deploy');

    const paged = site.calls.filter((call) => call.url.includes('/rest/api/content'));
    expect(paged.map((call) => new URL(call.url).searchParams.get('start'))).toEqual(['0', '2']);
    expect(paged.every((call) => call.url.startsWith('https://wiki.example.com/confluence/'))).toBe(true);
  });

  it('never follows the next link the server offers', async () => {
    const site = fakeDataCenter([{ id: '1', title: 'One', storage: '<p>a</p>' }]);
    await importFromConfluence({
      credentials: dataCenter,
      spaceKey: 'ENG',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });
    expect(site.calls.some((call) => call.url.includes('attacker.example'))).toBe(false);
  });

  it('stops when the server answers with fewer pages than it allowed', async () => {
    // Asked for 50, answers 10 at a time: a client that trusted its own page
    // size would stop after the first answer and lose the rest.
    const pages = Array.from({ length: 25 }, (_, index) => ({
      id: String(index + 1),
      title: `Page ${index + 1}`,
      storage: '<p>x</p>',
    }));
    const site = fakeDataCenter(pages, { serverLimit: 10 });

    const result = await importFromConfluence({
      credentials: dataCenter,
      spaceKey: 'ENG',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });
    expect(result.nodes).toHaveLength(25);
    expect(site.calls.filter((call) => call.url.includes('/rest/api/content'))).toHaveLength(3);
  });

  it('orders by the position a person set and leaves "none" to the reading order', async () => {
    const site = fakeDataCenter([
      { id: '1', title: 'Second', position: 20, storage: '<p>a</p>' },
      { id: '2', title: 'First', position: 10, storage: '<p>b</p>' },
      { id: '3', title: 'Unordered', position: 'none', storage: '<p>c</p>' },
    ]);
    const result = await importFromConfluence({
      credentials: dataCenter,
      spaceKey: 'ENG',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });
    expect(result.nodes.map((node) => node.ordering)).toEqual([20, 10, 2]);
  });

  it('refuses a space with more pages than the limit allows', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 1),
      title: `Page ${index + 1}`,
      storage: '<p>x</p>',
    }));
    const site = fakeDataCenter(pages, { serverLimit: 3 });
    await expect(
      importFromConfluence({
        credentials: dataCenter,
        spaceKey: 'ENG',
        limits: { ...DEFAULT_IMPORT_LIMITS, pages: 4 },
        client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
      }),
    ).rejects.toThrow(ImportError);
  });

  it('records the deployment and the address, and neither half of the credential', async () => {
    const site = fakeDataCenter([{ id: '1', title: 'One', storage: '<p>a</p>' }]);
    const result = await importFromConfluence({
      credentials: { ...dataCenter, email: 'ops' },
      spaceKey: 'ENG',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });
    expect(result.params).toEqual({
      base_url: 'https://wiki.example.com/confluence',
      deployment: 'datacenter',
      space_key: 'ENG',
      space_name: 'Engineering',
      page_count: 1,
      image_count: 0,
    });
    expect(JSON.stringify(result.params)).not.toContain('pat-secret');
  });
});

describe('how a Data Center is authenticated', () => {
  async function authorizationOf(email: string, apiToken: string): Promise<string | null> {
    const site = fakeDataCenter([{ id: '1', title: 'One', storage: '<p>a</p>' }]);
    await importFromConfluence({
      credentials: { ...dataCenter, email, apiToken },
      spaceKey: 'ENG',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });
    return site.calls[0]?.authorization ?? null;
  }

  it('sends a personal access token as Bearer', async () => {
    expect(await authorizationOf('', 'pat-secret')).toBe('Bearer pat-secret');
  });

  it('sends a username and password as Basic', async () => {
    expect(await authorizationOf('ops', 'hunter2')).toBe(
      `Basic ${Buffer.from('ops:hunter2').toString('base64')}`,
    );
  });

  it('sends no credential at all when neither was given', async () => {
    expect(await authorizationOf('', '')).toBeNull();
  });

  it('tells an anonymous reader that the space needs a token', async () => {
    const site = fakeDataCenter([], { status: 401 });
    const client = new ConfluenceClient(
      { ...dataCenter, email: '', apiToken: '' },
      { fetchImpl: site.fetchImpl, lookup: publicLookup },
    );
    await expect(client.findSpaceId('ENG')).rejects.toThrow(/anonymously/);
  });

  it('tells a signed-in reader that the credential was refused, quoting neither half', async () => {
    const site = fakeDataCenter([], { status: 403 });
    const client = new ConfluenceClient(dataCenter, { fetchImpl: site.fetchImpl, lookup: publicLookup });
    await expect(client.findSpaceId('ENG')).rejects.toThrow(/refused the token/);
    await expect(client.findSpaceId('ENG')).rejects.not.toThrow(/pat-secret/);
  });
});
