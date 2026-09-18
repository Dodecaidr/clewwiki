import { describe, expect, it, vi } from 'vitest';

import { CONTENT_IS_DATA_NOTICE } from '../src/content-notice.ts';
import { ClewwikiToolError } from '../src/errors.ts';
import { assertSecureBaseUrl, ClewwikiRestClient } from '../src/rest-client.ts';
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
  it('registers exactly the twenty-two tools docs/mcp.md names', () => {
    expect(TOOLS.map((definition) => definition.name)).toEqual([
      'wiki.list_spaces',
      'wiki.format_guide',
      'wiki.get_rules',
      'wiki.list_skills',
      'wiki.get_skill',
      'wiki.search',
      'wiki.get_page',
      'wiki.list_pages',
      'wiki.create_page',
      'wiki.claim',
      'wiki.renew_claim',
      'wiki.write_page',
      'wiki.release_claim',
      'wiki.get_presence',
      'wiki.post_note',
      'wiki.list_discussions',
      'wiki.get_discussion',
      'wiki.open_discussion',
      'wiki.post_discussion_message',
      'wiki.resolve_discussion',
      'wiki.check_anchors',
      'wiki.link_docs',
    ]);
    expect(TOOLS).toHaveLength(22);
  });

  it('names every tool whose result carries text written by others', () => {
    expect([...CONTENT_RETURNING_TOOLS].sort()).toEqual(
      [
        'wiki.list_spaces',
        'wiki.get_rules',
        'wiki.list_skills',
        'wiki.get_skill',
        'wiki.search',
        'wiki.get_page',
        'wiki.list_pages',
        'wiki.claim',
        'wiki.write_page',
        'wiki.get_presence',
        'wiki.post_note',
        'wiki.list_discussions',
        'wiki.get_discussion',
        'wiki.check_anchors',
      ].sort(),
    );
  });

  it('states the content contract verbatim in every tool that returns text written by others', () => {
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
      'wiki.list_spaces',
      'wiki.format_guide',
      'wiki.get_rules',
      'wiki.list_skills',
      'wiki.get_skill',
      'wiki.search',
      'wiki.get_page',
      'wiki.list_pages',
      'wiki.get_presence',
      'wiki.list_discussions',
      'wiki.get_discussion',
    ]);
  });

  it('marks page creation as a write that is not idempotent', () => {
    expect(tool('wiki.create_page').annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
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

  it('refuses a get_page by path without the space the path is in', async () => {
    await expect(
      tool('wiki.get_page').run(clientWith(never), { path: '/backend/auth' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses a space key that is not one', async () => {
    await expect(
      tool('wiki.search').run(clientWith(never), { query: 'auth', space: 'not a key!' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      tool('wiki.list_pages').run(clientWith(never), { space: 'X' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses a page creation without a space, a title or a kind', async () => {
    for (const args of [
      { title: 'Auth', kind: 'technical' },
      { space: 'API', kind: 'technical' },
      { space: 'API', title: 'Auth' },
      { space: 'API', title: '   ', kind: 'technical' },
      { space: 'API', title: 'Auth', kind: 'prose' },
    ]) {
      await expect(tool('wiki.create_page').run(clientWith(never), args)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    }
  });

  it('refuses a page creation with both parent_id and parent_path', async () => {
    await expect(
      tool('wiki.create_page').run(clientWith(never), {
        space: 'API',
        title: 'Auth',
        kind: 'technical',
        parent_id: '11111111-1111-4111-8111-111111111111',
        parent_path: '/backend',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
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
  it('reads the format guide from the instance with one GET and no arguments', async () => {
    const guide = { version: 1, format: 'markdown', charts: { types: ['bar'] } };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, guide));
    await expect(tool('wiki.format_guide').run(clientWith(fetchMock), {})).resolves.toEqual(guide);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://wiki.example.com/api/v1/format-guide');
    expect(init.method).toBe('GET');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

  it('resolves a path to a page id inside the space, with one extra read', async () => {
    const pageId = '11111111-1111-4111-8111-111111111111';
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, { nodes: [{ page_id: pageId }] }))
      .mockResolvedValueOnce(
        jsonResponse(200, { page_id: pageId, kind: 'technical', body: 'x', space: { key: 'API', name: 'API' } }),
      );

    const result = (await tool('wiki.get_page').run(clientWith(fetchMock), {
      space: 'API',
      path: '/backend/auth',
    })) as Record<string, unknown>;

    expect(result.page_id).toBe(pageId);
    expect(result.space).toEqual({ key: 'API', name: 'API' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://wiki.example.com/api/v1/pages?space=API&path=%2Fbackend%2Fauth&depth=1',
    );
  });

  it('answers NOT_FOUND for a path nothing sits at, naming the space', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { nodes: [] }));
    const failure = await tool('wiki.get_page')
      .run(clientWith(fetchMock), { space: 'API', path: '/nowhere' })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'NOT_FOUND', details: { space: 'API', path: '/nowhere' } });
  });

  it('lists spaces with the fields an agent chooses one by', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(200, {
        spaces: [
          {
            key: 'MOBILE',
            name: 'Mobile app',
            description: 'The iOS and Android apps.',
            icon: '📱',
            page_count: 12,
            archived: false,
            has_repository: true,
            created_at: '2030-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const result = await tool('wiki.list_spaces').run(clientWith(fetchMock), {});

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://wiki.example.com/api/v1/spaces');
    expect(result).toEqual({
      spaces: [
        {
          key: 'MOBILE',
          name: 'Mobile app',
          description: 'The iOS and Android apps.',
          icon: '📱',
          page_count: 12,
          archived: false,
        },
      ],
    });
  });

  it('asks for archived spaces only when told to', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { spaces: [] }));
    await tool('wiki.list_spaces').run(clientWith(fetchMock), { include_archived: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://wiki.example.com/api/v1/spaces?include_archived=true',
    );
  });

  it('passes space through to search, the tree and presence', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { nodes: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { claims: [] }));
    const client = clientWith(fetchMock);

    await tool('wiki.search').run(client, { query: 'auth', space: 'API' });
    await tool('wiki.list_pages').run(client, { space: 'API' });
    await tool('wiki.get_presence').run(client, { space: 'API' });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://wiki.example.com/api/v1/search?q=auth&space=API',
      'https://wiki.example.com/api/v1/pages?space=API&depth=1',
      'https://wiki.example.com/api/v1/claims?space=API',
    ]);
  });
});

describe('wiki.create_page', () => {
  const created = {
    page_id: '44444444-4444-4444-8444-444444444444',
    space: { key: 'API', name: 'API' },
    parent_id: '11111111-1111-4111-8111-111111111111',
    path: '/backend/arkhitektura-bekenda',
    title: 'Архитектура бэкенда',
    kind: 'technical',
    summary: null,
    content_hash: 'sha256:abc',
    version: 1,
    body: '# Архитектура\n',
    anchors: [],
    linked_page: {
      page_id: '55555555-5555-4555-8555-555555555555',
      title: 'Written by someone else',
      kind: 'human',
    },
    claim: null,
  };

  it('posts to the page collection with only the fields it was given', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, created));
    await tool('wiki.create_page').run(clientWith(fetchMock), {
      space: 'API',
      parent_path: '/backend',
      title: 'Архитектура бэкенда',
      kind: 'technical',
      body: '# Архитектура\n',
      link_to_page_id: '55555555-5555-4555-8555-555555555555',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://wiki.example.com/api/v1/pages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      space: 'API',
      title: 'Архитектура бэкенда',
      kind: 'technical',
      parent_path: '/backend',
      body: '# Архитектура\n',
      link_to_page_id: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('passes an explicit slug, parent id and summary through', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, created));
    await tool('wiki.create_page').run(clientWith(fetchMock), {
      space: 'API',
      parent_id: '11111111-1111-4111-8111-111111111111',
      title: 'Auth',
      kind: 'human',
      summary: 'How sign-in works.',
      slug: 'sign-in',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({
      space: 'API',
      title: 'Auth',
      kind: 'human',
      parent_id: '11111111-1111-4111-8111-111111111111',
      summary: 'How sign-in works.',
      slug: 'sign-in',
    });
  });

  it('answers with the identifiers of the new page and no text written by others', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, created));
    const result = await tool('wiki.create_page').run(clientWith(fetchMock), {
      space: 'API',
      title: 'Архитектура бэкенда',
      kind: 'technical',
    });
    expect(result).toEqual({
      page_id: created.page_id,
      space: { key: 'API', name: 'API' },
      parent_id: created.parent_id,
      path: '/backend/arkhitektura-bekenda',
      title: 'Архитектура бэкенда',
      kind: 'technical',
      content_hash: 'sha256:abc',
      version: 1,
      linked_page_id: '55555555-5555-4555-8555-555555555555',
    });
    expect(JSON.stringify(result)).not.toContain('Written by someone else');
  });

  it('turns a taken path into CONFLICT naming the existing page', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'conflict',
          message: 'A page already exists at /backend/auth in this space',
          details: {
            path: '/backend/auth',
            space: 'API',
            existing_page_id: '66666666-6666-4666-8666-666666666666',
          },
        },
      }),
    );
    const failure = await tool('wiki.create_page')
      .run(clientWith(fetchMock), { space: 'API', title: 'Auth', kind: 'technical', slug: 'auth' })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'CONFLICT',
      details: { existing_page_id: '66666666-6666-4666-8666-666666666666' },
    });
  });
});

describe('discussion tools', () => {
  const never: FetchLike = () => {
    throw new Error('no REST call should have been made');
  };
  const DISCUSSION_ID = '33333333-3333-4333-8333-333333333333';

  it('lists a space\'s discussions, passing the status filter through', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { discussions: [] }));
    await tool('wiki.list_discussions').run(clientWith(fetchMock), {
      space: 'main',
      status: 'open',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://wiki.example.com/api/v1/spaces/main/discussions?status=open',
    );
  });

  it('reads one discussion by id', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(200, { discussion_id: DISCUSSION_ID, messages: [] }));
    await tool('wiki.get_discussion').run(clientWith(fetchMock), { discussion_id: DISCUSSION_ID });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://wiki.example.com/api/v1/discussions/${DISCUSSION_ID}`,
    );
  });

  it('opens a discussion in a space, sending only the fields it was given', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(201, { discussion_id: DISCUSSION_ID }));
    await tool('wiki.open_discussion').run(clientWith(fetchMock), {
      space: 'MAIN',
      title: 'Auth contract',
      body: 'Does anything of yours read the legacy cookie?',
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://wiki.example.com/api/v1/spaces/MAIN/discussions',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Auth contract',
      body: 'Does anything of yours read the legacy cookie?',
    });
  });

  it('posts a message to a discussion', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, {}));
    await tool('wiki.post_discussion_message').run(clientWith(fetchMock), {
      discussion_id: DISCUSSION_ID,
      body: 'Nothing of mine reads it.',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://wiki.example.com/api/v1/discussions/${DISCUSSION_ID}/messages`,
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      body: 'Nothing of mine reads it.',
    });
  });

  it('resolves a discussion, forwarding every block of the decision the caller wrote', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(200, { decision_page: { page_id: 'p' } }));
    await tool('wiki.resolve_discussion').run(clientWith(fetchMock), {
      discussion_id: DISCUSSION_ID,
      decision: 'Drop the cookie in 2.0.',
      context: 'Two services still read it.',
      options: 'Keep it, deprecate it, drop it.',
      consequences: 'OPS reruns its integration suite.',
      locale: 'ru',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://wiki.example.com/api/v1/discussions/${DISCUSSION_ID}/resolve`,
    );
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      decision: 'Drop the cookie in 2.0.',
      context: 'Two services still read it.',
      options: 'Keep it, deprecate it, drop it.',
      consequences: 'OPS reruns its integration suite.',
      locale: 'ru',
    });
  });

  it('refuses a resolution with no decision before any REST call is made', async () => {
    await expect(
      tool('wiki.resolve_discussion').run(clientWith(never), { discussion_id: DISCUSSION_ID }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      tool('wiki.resolve_discussion').run(clientWith(never), {
        discussion_id: DISCUSSION_ID,
        decision: '',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses a message larger than the 8 KB the server stores', async () => {
    await expect(
      tool('wiki.post_discussion_message').run(clientWith(never), {
        discussion_id: DISCUSSION_ID,
        body: 'x'.repeat(8_193),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses an empty title, a bad space key and a discussion id that is not one', async () => {
    await expect(
      tool('wiki.open_discussion').run(clientWith(never), { space: 'MAIN', title: '  ', body: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      tool('wiki.list_discussions').run(clientWith(never), { space: 'not a key!' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      tool('wiki.get_discussion').run(clientWith(never), { discussion_id: 'nope' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('teaches the protocol in the descriptions, not only the shape of the call', () => {
    expect(tool('wiki.list_discussions').description).toContain('before starting work');
    expect(tool('wiki.open_discussion').description).toContain('instead of guessing');
    expect(tool('wiki.resolve_discussion').description).toMatch(/never simply\s+abandon it/);
    // The server assembling a decision out of a thread is the thing this
    // feature must never do; the tool says so where an agent will read it.
    expect(tool('wiki.resolve_discussion').description).toContain('never summarises');
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

  it('turns an invalid chart block into VALIDATION, block details included', async () => {
    const details = {
      block_index: 1,
      line: 12,
      language: 'chart',
      errors: [{ path: 'series.0.data', message: 'series 0 ("API") has 2 values but x has 3 labels; they must be equal' }],
      blocks: [],
    };
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(400, { error: { code: 'validation', message: 'Chart block 1 at line 12 is not valid', details } }));
    const failure = await tool('wiki.create_page')
      .run(clientWith(fetchMock), { space: 'API', title: 'Latency', kind: 'human', body: '```chart\n{}\n```' })
      .catch((error: unknown) => error);
    expect((failure as ClewwikiToolError).code).toBe('VALIDATION');
    expect((failure as ClewwikiToolError).details).toEqual(details);
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

  it('recomputes anchors with a POST, because the new states are stored', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { anchors: [] }));
    await tool('wiki.check_anchors').run(clientWith(fetchMock), {
      page_id: '11111111-1111-4111-8111-111111111111',
      ref: 'main',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://wiki.example.com/api/v1/pages/11111111-1111-4111-8111-111111111111/anchors/check');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ref: 'main' });
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

describe('stdio base URL', () => {
  it('refuses plain http to a remote host', () => {
    expect(() => assertSecureBaseUrl('http://wiki.example.com')).toThrow(/plain http/);
  });

  it('allows https anywhere and plain http on loopback', () => {
    expect(() => assertSecureBaseUrl('https://wiki.example.com')).not.toThrow();
    expect(() => assertSecureBaseUrl('http://localhost:3000')).not.toThrow();
    expect(() => assertSecureBaseUrl('http://127.0.0.1:3000')).not.toThrow();
  });

  it('allows plain http elsewhere only when explicitly told to', () => {
    expect(() => assertSecureBaseUrl('http://10.0.0.5:3000', true)).not.toThrow();
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
