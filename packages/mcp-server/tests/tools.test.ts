import { describe, expect, it, vi } from 'vitest';

import { CONTENT_IS_DATA_NOTICE } from '../src/content-notice.ts';
import { ClewwikiToolError } from '../src/errors.ts';
import { ClewwikiRestClient } from '../src/rest-client.ts';
import type { FetchLike } from '../src/rest-client.ts';
import { CONTENT_RETURNING_TOOLS, TOOLS } from '../src/tools.ts';
import { USER_AGENT } from '../src/version.ts';

const TOKEN = 'test-token-value';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchMock: FetchLike): ClewwikiRestClient {
  return new ClewwikiRestClient({ baseUrl: 'https://wiki.example.com', token: TOKEN, fetch: fetchMock });
}

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

describe('tool surface', () => {
  it('registers exactly the eleven tools docs/mcp.md names', () => {
    expect(TOOLS.map((definition) => definition.name)).toEqual([
      'wiki.search',
      'wiki.get_page',
      'wiki.list_pages',
      'wiki.claim',
      'wiki.renew_claim',
      'wiki.write_page',
      'wiki.release_claim',
      'wiki.get_presence',
      'wiki.post_note',
      'wiki.check_anchors',
      'wiki.link_docs',
    ]);
  });

  it('states the content contract verbatim in every tool that returns page text', () => {
    for (const name of CONTENT_RETURNING_TOOLS) {
      expect(tool(name).description).toContain(CONTENT_IS_DATA_NOTICE);
    }
  });

  it('does not put the statement on tools that return no page text', () => {
    const silent = TOOLS.filter(
      (definition) => !(CONTENT_RETURNING_TOOLS as readonly string[]).includes(definition.name),
    );
    for (const definition of silent) {
      expect(definition.description).not.toContain(CONTENT_IS_DATA_NOTICE);
    }
  });

  it('marks the read-only tools as read-only', () => {
    const readOnly = TOOLS.filter((definition) => definition.annotations.readOnlyHint === true).map(
      (definition) => definition.name,
    );
    expect(readOnly).toEqual([
      'wiki.search',
      'wiki.get_page',
      'wiki.list_pages',
      'wiki.get_presence',
      'wiki.check_anchors',
    ]);
  });
});

describe('input validation', () => {
  const never: FetchLike = () => {
    throw new Error('no REST call should have been made');
  };

  it('refuses a search with no query', async () => {
    await expect(tool('wiki.search').run(clientWith(never), {})).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('refuses a page id that is not a page id', async () => {
    await expect(
      tool('wiki.claim').run(clientWith(never), { page_id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses a search limit outside 1..50', async () => {
    await expect(
      tool('wiki.search').run(clientWith(never), { query: 'auth', limit: 500 }),
    ).rejects.toThrow();
  });

  it('refuses a get_page with neither id nor path', async () => {
    await expect(tool('wiki.get_page').run(clientWith(never), {})).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('refuses a write with no base hash', async () => {
    await expect(
      tool('wiki.write_page').run(clientWith(never), {
        page_id: '11111111-1111-4111-8111-111111111111',
        claim_id: '22222222-2222-4222-8222-222222222222',
        body: 'text',
      }),
    ).rejects.toThrow();
  });
});

describe('REST calls', () => {
  it('sends the bearer token and its own user agent', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { results: [] }));
    await tool('wiki.search').run(clientWith(fetchMock), { query: 'auth' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://wiki.example.com/api/v1/search?q=auth');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^clewwiki-mcp\/\d+\.\d+\.\d+$/);
  });

  it('passes a claim straight through the way REST answered it', async () => {
    const claim = {
      claim_id: '33333333-3333-4333-8333-333333333333',
      page_id: '11111111-1111-4111-8111-111111111111',
      expires_at: '2030-01-01T00:00:00.000Z',
      base_content_hash: 'sha256:abc',
      held_by: 'ci-writer',
    };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, claim));
    const result = await tool('wiki.claim').run(clientWith(fetchMock), {
      page_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(result).toEqual(claim);
  });

  it('leaves a page body byte for byte as it was stored', async () => {
    const body = '# Title\n\nText with `code`, {braces} and a trailing space \n';
    const page = {
      page_id: '11111111-1111-4111-8111-111111111111',
      kind: 'technical',
      body,
      content_hash: 'sha256:abc',
      linked_page: null,
      anchors: [],
    };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, page));
    const result = (await tool('wiki.get_page').run(clientWith(fetchMock), {
      page_id: page.page_id,
    })) as { body: string };
    expect(result.body).toBe(body);
  });

  it('omits the body when the caller asked for the other variant, and edits nothing', async () => {
    const page = {
      page_id: '11111111-1111-4111-8111-111111111111',
      kind: 'technical',
      body: '# Technical\n',
      linked_page: null,
    };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, page));
    const result = (await tool('wiki.get_page').run(clientWith(fetchMock), {
      page_id: page.page_id,
      variant: 'human',
    })) as Record<string, unknown>;
    expect(result).not.toHaveProperty('body');
    expect(result.page_id).toBe(page.page_id);
  });

  it('resolves a path to a page id with one extra read', async () => {
    const pageId = '11111111-1111-4111-8111-111111111111';
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, { nodes: [{ page_id: pageId }] }))
      .mockResolvedValueOnce(jsonResponse(200, { page_id: pageId, kind: 'technical', body: 'x' }));

    const result = (await tool('wiki.get_page').run(clientWith(fetchMock), {
      path: '/backend/auth',
    })) as Record<string, unknown>;

    expect(result.page_id).toBe(pageId);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/v1/pages?path=%2Fbackend%2Fauth');
  });

  it('answers NOT_FOUND for a path nothing sits at', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { nodes: [] }));
    await expect(
      tool('wiki.get_page').run(clientWith(fetchMock), { path: '/nowhere' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('failures on the way back', () => {
  it('turns a scope refusal into FORBIDDEN', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        jsonResponse(403, {
          error: { code: 'insufficient_scope', message: 'Token is missing scope: pages:write' },
        }),
      );
    await expect(
      tool('wiki.claim').run(clientWith(fetchMock), { page_id: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('turns a stale write into STALE_BASE, details included', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'stale_base',
          message: 'stale',
          details: { current_content_hash: 'sha256:new', your_base_hash: 'sha256:old' },
        },
      }),
    );
    const failure = await tool('wiki.write_page')
      .run(clientWith(fetchMock), {
        page_id: '11111111-1111-4111-8111-111111111111',
        claim_id: '22222222-2222-4222-8222-222222222222',
        base_content_hash: 'sha256:old',
        body: 'new text',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClewwikiToolError);
    expect((failure as ClewwikiToolError).code).toBe('STALE_BASE');
    expect((failure as ClewwikiToolError).details).toEqual({
      current_content_hash: 'sha256:new',
      your_base_hash: 'sha256:old',
    });
  });

  it('turns an unreachable repository into REPOSITORY_UNAVAILABLE', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(502, {
        error: { code: 'repository_unavailable', message: 'could not read from remote repository' },
      }),
    );
    await expect(
      tool('wiki.check_anchors').run(clientWith(fetchMock), {
        page_id: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_UNAVAILABLE' });
  });

  it('reports an instance it cannot reach without blaming the caller', async () => {
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(
      tool('wiki.get_presence').run(clientWith(fetchMock), {}),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('client configuration', () => {
  it('refuses a base URL that is not http or https', () => {
    expect(() => new ClewwikiRestClient({ baseUrl: 'ftp://wiki.example.com', token: TOKEN })).toThrow(
      /http or https/,
    );
  });

  it('refuses an empty token', () => {
    expect(() => new ClewwikiRestClient({ baseUrl: 'https://wiki.example.com', token: '  ' })).toThrow(
      /token is empty/,
    );
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { claims: [] }));
    const client = new ClewwikiRestClient({
      baseUrl: 'https://wiki.example.com/',
      token: TOKEN,
      fetch: fetchMock,
    });
    await tool('wiki.get_presence').run(client, {});
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://wiki.example.com/api/v1/claims');
  });
});
