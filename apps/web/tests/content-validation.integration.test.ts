import { randomUUID } from 'node:crypto';

import { CHART_EXAMPLES, CHART_TYPES, chartExampleBlock } from '@clewwiki/content/chart';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as ClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';
import type * as ExportRoute from '@/app/api/v1/export/[id]/route';
import type * as FormatGuideRoute from '@/app/api/v1/format-guide/route';
import type * as PageActions from '@/app/pages/actions';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping content validation suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

// The page form's actions read the signed-in person from the request; here the
// session is whatever this suite says it is.
const session = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
// A session as `getSessionContext` builds it: the workspace's id beside the
// workspace, and no restricted space hidden from the person unless a test says so.
vi.mock('@/lib/session', () => ({
  getSessionContext: async () =>
    session.current && {
      workspaceId: (session.current.workspace as { id: string } | undefined)?.id,
      spaceIds: null,
      ...session.current,
    },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

const INVALID_CHART_BODY = [
  '# Latency',
  '',
  '```chart',
  '{"type": "bar", "x": ["API", "Worker", "DB"], "series": [{"name": "p95", "data": [42, 180]}]}',
  '```',
  '',
].join('\n');

const INVALID_MERMAID_BODY = ['Intro', '', '```mermaid', 'flowchat LR', '  A --> B', '```', ''].join('\n');

/**
 * Chart and Mermaid blocks are checked whenever a body is stored — by an agent
 * over REST (and so over MCP) and by a person through the page form — and a
 * refusal points at the block, its line and the field to fix.
 */
describe.skipIf(!probe.reachable)('structured blocks on write', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let pagesRoute: typeof PagesRoute;
  let pageRoute: typeof PageRoute;
  let claimsRoute: typeof ClaimsRoute;
  let exportRoute: typeof ExportRoute;
  let formatGuideRoute: typeof FormatGuideRoute;
  let actions: typeof PageActions;

  const suiteTag = `cv-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let writer = '';
  let reader = '';
  let identityOnly = '';
  let userId = '';

  async function seedToken(name: string, scopes: string[]): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId,
      name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes,
    });
    return generated.token;
  }

  function request(token: string, path: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  }

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  async function create(body: Record<string, unknown>): Promise<{ status: number; json: JsonRecord }> {
    const response = await pagesRoute.POST(
      request(writer, '/api/v1/pages', { method: 'POST', body: JSON.stringify({ space: 'CV', kind: 'human', ...body }) }),
    );
    return { status: response.status, json: await response.json() };
  }

  async function claim(pageId: string): Promise<string> {
    const response = await claimsRoute.POST(
      request(writer, `/api/v1/pages/${pageId}/claims`, { method: 'POST', body: '{}' }),
      params(pageId),
    );
    return ((await response.json()) as JsonRecord).claim_id as string;
  }

  async function patch(pageId: string, body: Record<string, unknown>): Promise<{ status: number; json: JsonRecord }> {
    const response = await pageRoute.PATCH(
      request(writer, `/api/v1/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify(body) }),
      params(pageId),
    );
    return { status: response.status, json: await response.json() };
  }

  async function read(pageId: string): Promise<JsonRecord> {
    const response = await pageRoute.GET(request(writer, `/api/v1/pages/${pageId}`), params(pageId));
    return (await response.json()) as JsonRecord;
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();
    pagesRoute = await import('@/app/api/v1/pages/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    claimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');
    exportRoute = await import('@/app/api/v1/export/[id]/route');
    formatGuideRoute = await import('@/app/api/v1/format-guide/route');
    actions = await import('@/app/pages/actions');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Content ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning();
    workspaceId = workspace!.id;
    await db.insert(schema.spaces).values({ workspaceId, key: 'CV', name: 'Content validation' });
    writer = await seedToken('writer', ['pages:read', 'pages:write']);
    reader = await seedToken('reader', ['pages:read']);
    identityOnly = await seedToken('identity', ['identity:read']);
    userId = `user-${suiteTag}`;
    session.current = { userId, name: 'Editor', email: 'editor@example.test', role: 'editor', workspace };
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { eq } = await import('drizzle-orm');
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  describe('REST, and therefore MCP', () => {
    it('stores a page using every chart type, Mermaid, callouts and tables', async () => {
      const body = [
        '# Everything',
        '',
        '> [!WARNING]',
        '> Careful.',
        '',
        '| a | b |',
        '| :--- | ---: |',
        '| 1 | 2 |',
        '',
        '```mermaid',
        'sequenceDiagram',
        '  A->>B: hi',
        '```',
        '',
        ...CHART_TYPES.map((type) => chartExampleBlock(type)),
        '',
      ].join('\n');
      const created = await create({ title: `All blocks ${suiteTag}`, body });
      expect(created.status).toBe(201);
      expect((await read(created.json.page_id as string)).body).toBe(body);
    });

    it('refuses a chart whose series does not match its labels, pointing at the block and field', async () => {
      const created = await create({ title: `Bad chart ${suiteTag}`, body: INVALID_CHART_BODY });
      expect(created.status).toBe(400);
      expect(created.json.error.code).toBe('validation');
      expect(created.json.error.message).toBe(
        'Chart block 0 at line 3 is not valid: series.0.data: series 0 ("p95") has 2 values but x has 3 labels; they must be equal',
      );
      expect(created.json.error.details).toEqual({
        block_index: 0,
        line: 3,
        language: 'chart',
        errors: [{ path: 'series.0.data', message: 'series 0 ("p95") has 2 values but x has 3 labels; they must be equal' }],
        blocks: [
          {
            block_index: 0,
            line: 3,
            language: 'chart',
            errors: [{ path: 'series.0.data', message: 'series 0 ("p95") has 2 values but x has 3 labels; they must be equal' }],
          },
        ],
      });

      const { and, eq } = await import('drizzle-orm');
      const rows = await db
        .select({ id: schema.pages.id })
        .from(schema.pages)
        .where(and(eq(schema.pages.workspaceId, workspaceId), eq(schema.pages.title, `Bad chart ${suiteTag}`)));
      expect(rows).toHaveLength(0);
    });

    it('refuses an unknown Mermaid diagram type without running Mermaid', async () => {
      const created = await create({ title: `Bad diagram ${suiteTag}`, body: INVALID_MERMAID_BODY });
      expect(created.status).toBe(400);
      expect(created.json.error.details).toMatchObject({
        block_index: 0,
        line: 3,
        language: 'mermaid',
        errors: [{ path: '', message: expect.stringContaining('unknown diagram type "flowchat"') }],
      });
    });

    it('refuses an invalid block on update, stores nothing and audits the refusal', async () => {
      const created = await create({ title: `Update ${suiteTag}`, body: '# Fine\n' });
      const pageId = created.json.page_id as string;
      const claimId = await claim(pageId);

      const refused = await patch(pageId, {
        claim_id: claimId,
        base_content_hash: created.json.content_hash,
        body: `# Fine\n\n${chartExampleBlock('pie').replace('"data": [\n        64,', '"data": [\n        -64,')}\n`,
      });
      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe('validation');
      expect(refused.json.error.details).toMatchObject({
        block_index: 0,
        line: 3,
        language: 'chart',
        errors: expect.arrayContaining([
          { path: 'series.0.data.0', message: '-64 is negative; a pie slice cannot be negative' },
        ]),
      });

      const after = await read(pageId);
      expect(after.body).toBe('# Fine\n');
      expect(after.version).toBe(1);

      const { and, eq } = await import('drizzle-orm');
      const audit = await db
        .select({ metadata: schema.auditLog.metadata })
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.target, pageId), eq(schema.auditLog.action, 'page.write_rejected')));
      expect(audit.some((row) => (row.metadata as JsonRecord).reason === 'validation')).toBe(true);

      const fixed = await patch(pageId, {
        claim_id: claimId,
        base_content_hash: created.json.content_hash,
        body: `# Fine\n\n${chartExampleBlock('pie')}\n`,
      });
      expect(fixed.status).toBe(200);
    });

    it('still accepts a title change on a page stored before the rule, body untouched', async () => {
      const created = await create({ title: `Legacy ${suiteTag}`, body: '# Legacy\n' });
      const pageId = created.json.page_id as string;
      const { eq } = await import('drizzle-orm');
      const { computeContentHash } = await import('@/lib/pages/content');
      await db
        .update(schema.pages)
        .set({ body: INVALID_CHART_BODY, contentHash: computeContentHash(INVALID_CHART_BODY) })
        .where(eq(schema.pages.id, pageId));

      const claimId = await claim(pageId);
      const renamed = await patch(pageId, {
        claim_id: claimId,
        base_content_hash: computeContentHash(INVALID_CHART_BODY),
        title: `Legacy renamed ${suiteTag}`,
        body: INVALID_CHART_BODY,
      });
      expect(renamed.status).toBe(200);
    });

    it('draws charts as inline SVG in the HTML export, and invalid ones as an error box', async () => {
      const created = await create({ title: `Export ${suiteTag}`, body: `${chartExampleBlock('line')}\n\n> [!TIP]\n> Print me.\n` });
      const pageId = created.json.page_id as string;
      const response = await exportRoute.GET(
        request(reader, `/api/v1/export/${pageId}?format=html`),
        params(pageId),
      );
      const html = await response.text();
      expect(html).toContain('<svg class="chart chart-line"');
      expect(html).toContain(`<title>${CHART_EXAMPLES.line.title}</title>`);
      expect(html).toContain('<div class="callout callout-tip">');
      expect(html).not.toMatch(/<script/i);
    });
  });

  describe('the format guide endpoint', () => {
    it('answers a pages:read token with the guide built from the schema', async () => {
      const response = await formatGuideRoute.GET(request(reader, '/api/v1/format-guide'));
      expect(response.status).toBe(200);
      const guide = (await response.json()) as JsonRecord;
      expect(guide.charts.types).toEqual([...CHART_TYPES]);
      expect(guide.mermaid.keywords).toContain('sequenceDiagram');
      expect(guide.validation.error_code).toBe('VALIDATION');
    });

    it('refuses a token without pages:read and an anonymous caller', async () => {
      const forbidden = await formatGuideRoute.GET(request(identityOnly, '/api/v1/format-guide'));
      expect(forbidden.status).toBe(403);
      const anonymous = await formatGuideRoute.GET(new Request(`${BASE}/api/v1/format-guide`));
      expect(anonymous.status).toBe(401);
    });
  });

  describe('the page form', () => {
    function form(values: Record<string, string>): FormData {
      const data = new FormData();
      for (const [key, value] of Object.entries(values)) data.set(key, value);
      return data;
    }

    it('shows a person the same block errors an agent gets when creating a page', async () => {
      const rest = await create({ title: `Rest twin ${suiteTag}`, body: INVALID_CHART_BODY });
      const state = await actions.createPageAction(
        {},
        form({ spaceKey: 'CV', title: `Form create ${suiteTag}`, kind: 'human', body: INVALID_CHART_BODY }),
      );
      expect(state.error).toBe('validation');
      expect(state.message).toBe(rest.json.error.message);
      expect(state.blockIssues).toEqual(rest.json.error.details.blocks);
    });

    it('shows the errors when saving an edit, and keeps the page as it was', async () => {
      const created = await create({ title: `Form edit ${suiteTag}`, body: '# Before\n' });
      const pageId = created.json.page_id as string;

      const state = await actions.updatePageAction(
        {},
        form({
          pageId,
          baseContentHash: created.json.content_hash as string,
          title: `Form edit ${suiteTag}`,
          kind: 'human',
          body: INVALID_MERMAID_BODY,
        }),
      );
      expect(state.error).toBe('validation');
      expect(state.blockIssues).toEqual([
        {
          block_index: 0,
          line: 3,
          language: 'mermaid',
          errors: [{ path: '', message: expect.stringContaining('unknown diagram type "flowchat"') }],
        },
      ]);
      expect((await read(pageId)).body).toBe('# Before\n');

      // The lease the action took for the save went back with the refusal.
      const { and, eq, isNull } = await import('drizzle-orm');
      const live = await db
        .select({ id: schema.claims.id })
        .from(schema.claims)
        .where(and(eq(schema.claims.pageId, pageId), isNull(schema.claims.releasedAt)));
      expect(live).toHaveLength(0);
    });

    it('stores a JSON-encoded body from the editor byte for byte, line endings included', async () => {
      const body = '# Mixed\n\nunix line\r\nwindows line\n\n```chart\n' + JSON.stringify(CHART_EXAMPLES.area) + '\n```';
      const title = `Exact bytes ${suiteTag}`;
      await expect(
        actions.createPageAction(
          {},
          form({ spaceKey: 'CV', title, kind: 'human', body: JSON.stringify(body), bodyEncoding: 'json' }),
        ),
      ).rejects.toThrow(/^redirect:/);
      const { and, eq } = await import('drizzle-orm');
      const [row] = await db
        .select({ body: schema.pages.body })
        .from(schema.pages)
        .where(and(eq(schema.pages.workspaceId, workspaceId), eq(schema.pages.title, title)));
      expect(row?.body).toBe(body);
    });

    it('refuses a JSON-encoded body that is not a JSON string', async () => {
      const state = await actions.createPageAction(
        {},
        form({ spaceKey: 'CV', title: `Bad encoding ${suiteTag}`, kind: 'human', body: '{not json', bodyEncoding: 'json' }),
      );
      expect(state.error).toBe('validation');
    });

    it('saves a valid page through the form', async () => {
      await expect(
        actions.createPageAction(
          {},
          form({ spaceKey: 'CV', title: `Form ok ${suiteTag}`, kind: 'technical', body: chartExampleBlock('donut') }),
        ),
      ).rejects.toThrow(/^redirect:\/spaces\/CV\/pages\//);
    });
  });
});
