import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

// Route modules are imported for their types here and loaded lazily below:
// they read configuration at module scope, so they must not be evaluated
// before the environment is set up.
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as ClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';
import type * as TreeRoute from '@/app/api/v1/pages/[id]/tree/route';
import type * as VersionsRoute from '@/app/api/v1/pages/[id]/versions/route';
import type * as LinkRoute from '@/app/api/v1/pages/[id]/link/route';
import type * as SearchRoute from '@/app/api/v1/search/route';
import type * as ExportRoute from '@/app/api/v1/export/[id]/route';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping pages suite: ${probe.reason}`);
}

// Set before the application modules load: `lib/auth.ts` refuses to initialise
// without a secret, by design.
process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

const BASE = 'http://localhost:3000';

describe.skipIf(!probe.reachable)('pages REST API', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;

  let pagesRoute: typeof PagesRoute;
  let pageRoute: typeof PageRoute;
  let claimsRoute: typeof ClaimsRoute;
  let treeRoute: typeof TreeRoute;
  let versionsRoute: typeof VersionsRoute;
  let linkRoute: typeof LinkRoute;
  let searchRoute: typeof SearchRoute;
  let exportRoute: typeof ExportRoute;

  const suiteTag = `pg-${randomUUID().slice(0, 8)}`;
  const workspaceIds: string[] = [];

  let workspaceId: string;
  let otherWorkspaceId: string;
  let readWrite = '';
  let readOnly = '';
  let writeNoDelete = '';
  let noPageScope = '';
  let foreignToken = '';

  async function seedToken(options: {
    workspaceId: string;
    name: string;
    scopes: string[];
  }): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId: options.workspaceId,
      name: options.name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes: options.scopes,
    });
    return generated.token;
  }

  function request(token: string, path: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type JsonRecord = Record<string, any>;

  async function createPage(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: JsonRecord }> {
    // Every page lives in a space; these tests work in the one each workspace
    // was given in `beforeAll`, both of which carry the key MAIN.
    const response = await pagesRoute.POST(
      request(token, '/api/v1/pages', {
        method: 'POST',
        body: JSON.stringify({ space: 'MAIN', ...body }),
      }),
    );
    return { status: response.status, json: await response.json() };
  }

  /**
   * Since Phase 3 a write needs a lease. These tests are about pages rather
   * than about claims, so they take one the short way and let it expire or be
   * released as the case may be; `claims.integration.test.ts` is where the
   * lease rules themselves are exercised.
   */
  async function claimPage(token: string, pageId: string): Promise<string> {
    const response = await claimsRoute.POST(
      request(token, `/api/v1/pages/${pageId}/claims`, { method: 'POST', body: '{}' }),
      params(pageId),
    );
    const body = await response.json();
    return body.claim_id as string;
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();

    pagesRoute = await import('@/app/api/v1/pages/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    claimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');
    treeRoute = await import('@/app/api/v1/pages/[id]/tree/route');
    versionsRoute = await import('@/app/api/v1/pages/[id]/versions/route');
    linkRoute = await import('@/app/api/v1/pages/[id]/link/route');
    searchRoute = await import('@/app/api/v1/search/route');
    exportRoute = await import('@/app/api/v1/export/[id]/route');

    const [primary] = await db
      .insert(schema.workspaces)
      .values({ name: `Primary ${suiteTag}`, slug: `${suiteTag}-primary` })
      .returning({ id: schema.workspaces.id });
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `${suiteTag}-other` })
      .returning({ id: schema.workspaces.id });

    workspaceId = primary!.id;
    otherWorkspaceId = other!.id;
    workspaceIds.push(workspaceId, otherWorkspaceId);
    await db.insert(schema.spaces).values([
      { workspaceId, key: 'MAIN', name: 'Main' },
      { workspaceId: otherWorkspaceId, key: 'MAIN', name: 'Main' },
    ]);

    readWrite = await seedToken({
      workspaceId,
      name: 'rw',
      scopes: ['pages:read', 'pages:write', 'pages:delete'],
    });
    writeNoDelete = await seedToken({
      workspaceId,
      name: 'rw-no-delete',
      scopes: ['pages:read', 'pages:write'],
    });
    readOnly = await seedToken({ workspaceId, name: 'ro', scopes: ['pages:read'] });
    noPageScope = await seedToken({ workspaceId, name: 'none', scopes: ['identity:read'] });
    foreignToken = await seedToken({
      workspaceId: otherWorkspaceId,
      name: 'foreign',
      scopes: ['pages:read', 'pages:write', 'pages:delete'],
    });
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { inArray } = await import('drizzle-orm');
    if (workspaceIds.length > 0) {
      // Pages, revisions, tokens and audit rows all cascade from the workspace.
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds));
    }
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  /* ---------------------------------------------------------------- */

  describe('create → get → update → versions', () => {
    it('walks the full lifecycle of a page', async () => {
      const slug = `lifecycle-${randomUUID().slice(0, 8)}`;
      const created = await createPage(readWrite, {
        title: 'Auth service',
        path: `/${slug}`,
        kind: 'technical',
        body: '# Auth service\n\nBearer tokens are verified here.\n',
        summary: 'How authentication works.',
      });

      expect(created.status).toBe(201);
      expect(created.json.path).toBe(`/${slug}`);
      expect(created.json.version).toBe(1);
      expect(created.json.kind).toBe('technical');
      expect(created.json.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(created.json.created_by).toMatchObject({ type: 'agent' });

      const pageId = created.json.page_id as string;

      const readResponse = await pageRoute.GET(
        request(readOnly, `/api/v1/pages/${pageId}`),
        params(pageId),
      );
      expect(readResponse.status).toBe(200);
      const read = await readResponse.json();
      expect(read.body).toContain('Bearer tokens are verified here.');
      // Every read carries the hash a later write echoes back.
      expect(read.content_hash).toBe(created.json.content_hash);

      const claimId = await claimPage(readWrite, pageId);
      const updateResponse = await pageRoute.PATCH(
        request(readWrite, `/api/v1/pages/${pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            body: '# Auth service\n\nBearer tokens are verified here, then rate limited.\n',
            title: 'Auth service (v2)',
            claim_id: claimId,
            base_content_hash: read.content_hash,
          }),
        }),
        params(pageId),
      );
      expect(updateResponse.status).toBe(200);
      const updated = await updateResponse.json();
      expect(updated.version).toBe(2);
      expect(updated.title).toBe('Auth service (v2)');
      expect(updated.content_hash).not.toBe(read.content_hash);

      const versionsResponse = await versionsRoute.GET(
        request(readOnly, `/api/v1/pages/${pageId}/versions`),
        params(pageId),
      );
      expect(versionsResponse.status).toBe(200);
      const versions = await versionsResponse.json();
      expect(versions.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(versions.versions[0].content_hash).toBe(updated.content_hash);
      expect(versions.versions[1].content_hash).toBe(created.json.content_hash);
      expect(versions.versions[0].author).toMatchObject({ type: 'agent' });

      const deleteResponse = await pageRoute.DELETE(
        request(readWrite, `/api/v1/pages/${pageId}`, { method: 'DELETE' }),
        params(pageId),
      );
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toMatchObject({ deleted: true, pages_deleted: 1 });

      const goneResponse = await pageRoute.GET(
        request(readOnly, `/api/v1/pages/${pageId}`),
        params(pageId),
      );
      expect(goneResponse.status).toBe(404);
    });

    it('refuses a write built on a hash that is no longer current', async () => {
      const slug = `stale-${randomUUID().slice(0, 8)}`;
      const created = await createPage(readWrite, {
        title: 'Stale base',
        path: `/${slug}`,
        body: 'first',
      });
      const pageId = created.json.page_id as string;
      const staleHash = created.json.content_hash as string;
      const claimId = await claimPage(readWrite, pageId);

      await pageRoute.PATCH(
        request(readWrite, `/api/v1/pages/${pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            body: 'second',
            claim_id: claimId,
            base_content_hash: staleHash,
          }),
        }),
        params(pageId),
      );

      const conflict = await pageRoute.PATCH(
        request(readWrite, `/api/v1/pages/${pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            body: 'third',
            claim_id: claimId,
            base_content_hash: staleHash,
          }),
        }),
        params(pageId),
      );

      expect(conflict.status).toBe(409);
      const payload = await conflict.json();
      expect(payload.error.code).toBe('stale_base');
      expect(payload.error.details.your_base_hash).toBe(staleHash);
      expect(payload.error.details.current_content_hash).not.toBe(staleHash);
    });

    it('rejects a second page on the same path', async () => {
      const slug = `dup-${randomUUID().slice(0, 8)}`;
      expect((await createPage(readWrite, { title: 'One', path: `/${slug}` })).status).toBe(201);
      const second = await createPage(readWrite, { title: 'Two', path: `/${slug}` });
      expect(second.status).toBe(409);
      expect(second.json.error).toMatchObject({ code: 'conflict' });
    });

    it('writes an audit row in the same transaction as the write', async () => {
      const { and, eq } = await import('drizzle-orm');
      const created = await createPage(readWrite, {
        title: 'Audited',
        path: `/audited-${randomUUID().slice(0, 8)}`,
      });
      const pageId = created.json.page_id as string;

      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.target, pageId), eq(schema.auditLog.action, 'page.created')),
        );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.workspaceId).toBe(workspaceId);
      expect(rows[0]!.actorType).toBe('agent');
    });
  });

  /* ---------------------------------------------------------------- */

  describe('tree', () => {
    it('nests children under their parent and moves a whole subtree', async () => {
      const root = `tree-${randomUUID().slice(0, 8)}`;
      const parent = await createPage(readWrite, { title: 'Backend', path: `/${root}` });
      const parentId = parent.json.page_id as string;

      const child = await createPage(readWrite, {
        title: 'Auth',
        parent_id: parentId,
      });
      const childId = child.json.page_id as string;
      expect(child.json.path).toBe(`/${root}/auth`);

      const grandchild = await createPage(readWrite, {
        title: 'Tokens',
        parent_id: childId,
      });
      expect(grandchild.json.path).toBe(`/${root}/auth/tokens`);

      const treeResponse = await treeRoute.GET(
        request(readOnly, `/api/v1/pages/${parentId}/tree`),
        params(parentId),
      );
      expect(treeResponse.status).toBe(200);
      const tree = await treeResponse.json();
      expect(tree.nodes).toHaveLength(1);
      expect(tree.nodes[0].page_id).toBe(parentId);
      expect(tree.nodes[0].has_children).toBe(true);
      expect(tree.nodes[0].children[0].page_id).toBe(childId);
      expect(tree.nodes[0].children[0].children[0].title).toBe('Tokens');

      // Renaming the middle page must carry its descendants with it.
      const moveClaim = await claimPage(readWrite, childId);
      const moved = await pageRoute.PATCH(
        request(readWrite, `/api/v1/pages/${childId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            path: `/${root}/identity`,
            claim_id: moveClaim,
            base_content_hash: child.json.content_hash,
          }),
        }),
        params(childId),
      );
      expect(moved.status).toBe(200);
      expect((await moved.json()).path).toBe(`/${root}/identity`);

      const afterMove = await treeRoute.GET(
        request(readOnly, `/api/v1/pages/${parentId}/tree`),
        params(parentId),
      );
      const movedTree = await afterMove.json();
      expect(movedTree.nodes[0].children[0].path).toBe(`/${root}/identity`);
      expect(movedTree.nodes[0].children[0].children[0].path).toBe(`/${root}/identity/tokens`);
    });

    it('refuses to move a page below itself', async () => {
      const root = `cycle-${randomUUID().slice(0, 8)}`;
      const parent = await createPage(readWrite, { title: 'Parent', path: `/${root}` });
      const parentId = parent.json.page_id as string;
      const child = await createPage(readWrite, { title: 'Child', parent_id: parentId });

      const cycleClaim = await claimPage(readWrite, parentId);
      const response = await pageRoute.PATCH(
        request(readWrite, `/api/v1/pages/${parentId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            parent_id: child.json.page_id,
            claim_id: cycleClaim,
            base_content_hash: parent.json.content_hash,
          }),
        }),
        params(parentId),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('validation');
    });

    it('deletes a subtree with its root', async () => {
      const root = `subtree-${randomUUID().slice(0, 8)}`;
      const parent = await createPage(readWrite, { title: 'Doomed', path: `/${root}` });
      const parentId = parent.json.page_id as string;
      const child = await createPage(readWrite, { title: 'Also doomed', parent_id: parentId });

      const response = await pageRoute.DELETE(
        request(readWrite, `/api/v1/pages/${parentId}`, { method: 'DELETE' }),
        params(parentId),
      );
      expect(await response.json()).toMatchObject({ pages_deleted: 2 });

      const childResponse = await pageRoute.GET(
        request(readOnly, `/api/v1/pages/${child.json.page_id}`),
        params(child.json.page_id as string),
      );
      expect(childResponse.status).toBe(404);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('search', () => {
    it('finds a page by a word from its body, and by a prefix of one', async () => {
      const marker = `zephyrine${randomUUID().slice(0, 6).replace(/[^a-z]/g, 'x')}`;
      const created = await createPage(readWrite, {
        title: 'Search target',
        path: `/search-${randomUUID().slice(0, 8)}`,
        body: `The deployment pipeline uses ${marker} for artefact signing.`,
      });

      const whole = await searchRoute.GET(
        request(readOnly, `/api/v1/search?q=${encodeURIComponent(marker)}`),
      );
      expect(whole.status).toBe(200);
      const wholeBody = await whole.json();
      expect(wholeBody.results.map((r: { page_id: string }) => r.page_id)).toContain(
        created.json.page_id,
      );
      expect(wholeBody.results[0].snippet).toContain(marker);
      expect(wholeBody.results[0].content_hash).toBe(created.json.content_hash);

      // A partial word falls back to a prefix query, which is what makes a
      // half-typed search box useful.
      const partial = await searchRoute.GET(
        request(readOnly, `/api/v1/search?q=${encodeURIComponent(marker.slice(0, 7))}`),
      );
      const partialBody = await partial.json();
      expect(partialBody.results.map((r: { page_id: string }) => r.page_id)).toContain(
        created.json.page_id,
      );
    });

    it('finds a page by a word from its title', async () => {
      const marker = `quintessepage${randomUUID().slice(0, 4).replace(/[^a-z]/g, 'y')}`;
      const created = await createPage(readWrite, {
        title: `The ${marker} handbook`,
        path: `/title-search-${randomUUID().slice(0, 8)}`,
        body: 'Nothing notable in the body.',
      });

      const response = await searchRoute.GET(
        request(readOnly, `/api/v1/search?q=${encodeURIComponent(marker)}`),
      );
      const body = await response.json();
      expect(body.results.map((r: { page_id: string }) => r.page_id)).toContain(
        created.json.page_id,
      );
    });

    it('never returns a page from another workspace', async () => {
      const marker = `crossworkspaceleak${randomUUID().slice(0, 4).replace(/[^a-z]/g, 'z')}`;
      await createPage(readWrite, {
        title: 'Private',
        path: `/private-${randomUUID().slice(0, 8)}`,
        body: `Contains ${marker}.`,
      });

      const response = await searchRoute.GET(
        request(foreignToken, `/api/v1/search?q=${encodeURIComponent(marker)}`),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).results).toEqual([]);
    });

    it('rejects an empty query rather than returning everything', async () => {
      const response = await searchRoute.GET(request(readOnly, '/api/v1/search?q='));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('validation');
    });
  });

  /* ---------------------------------------------------------------- */

  describe('technical ↔ human linking', () => {
    it('pairs two pages so both sides agree, then unpairs them', async () => {
      const tag = randomUUID().slice(0, 8);
      const technical = await createPage(readWrite, {
        title: 'Auth (technical)',
        path: `/tech-${tag}`,
        kind: 'technical',
      });
      const human = await createPage(readWrite, {
        title: 'Auth (human)',
        path: `/human-${tag}`,
        kind: 'human',
      });

      const technicalId = technical.json.page_id as string;
      const humanId = human.json.page_id as string;

      const linked = await linkRoute.POST(
        request(readWrite, `/api/v1/pages/${technicalId}/link`, {
          method: 'POST',
          body: JSON.stringify({ linked_page_id: humanId }),
        }),
        params(technicalId),
      );
      expect(linked.status).toBe(200);
      expect(await linked.json()).toEqual({ page_id: technicalId, linked_page_id: humanId });

      for (const [id, partner] of [
        [technicalId, humanId],
        [humanId, technicalId],
      ] as const) {
        const response = await pageRoute.GET(request(readOnly, `/api/v1/pages/${id}`), params(id));
        const payload = await response.json();
        expect(payload.linked_page.page_id).toBe(partner);
      }

      const unlinked = await linkRoute.POST(
        request(readWrite, `/api/v1/pages/${humanId}/link`, {
          method: 'POST',
          body: JSON.stringify({ linked_page_id: null }),
        }),
        params(humanId),
      );
      expect(await unlinked.json()).toEqual({ page_id: humanId, linked_page_id: null });

      for (const id of [technicalId, humanId]) {
        const response = await pageRoute.GET(request(readOnly, `/api/v1/pages/${id}`), params(id));
        expect((await response.json()).linked_page).toBeNull();
      }
    });

    it('refuses to pair two pages of the same kind', async () => {
      const tag = randomUUID().slice(0, 8);
      const a = await createPage(readWrite, {
        title: 'A',
        path: `/same-a-${tag}`,
        kind: 'technical',
      });
      const b = await createPage(readWrite, {
        title: 'B',
        path: `/same-b-${tag}`,
        kind: 'technical',
      });

      const response = await linkRoute.POST(
        request(readWrite, `/api/v1/pages/${a.json.page_id}/link`, {
          method: 'POST',
          body: JSON.stringify({ linked_page_id: b.json.page_id }),
        }),
        params(a.json.page_id as string),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('validation');
    });

    it('refuses to pair a page with a page in another workspace', async () => {
      const tag = randomUUID().slice(0, 8);
      const mine = await createPage(readWrite, {
        title: 'Mine',
        path: `/mine-${tag}`,
        kind: 'technical',
      });
      const theirs = await createPage(foreignToken, {
        title: 'Theirs',
        path: `/theirs-${tag}`,
        kind: 'human',
      });

      const response = await linkRoute.POST(
        request(readWrite, `/api/v1/pages/${mine.json.page_id}/link`, {
          method: 'POST',
          body: JSON.stringify({ linked_page_id: theirs.json.page_id }),
        }),
        params(mine.json.page_id as string),
      );
      expect(response.status).toBe(404);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('export', () => {
    const body = '# Flow\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n';
    let pageId = '';

    beforeAll(async () => {
      const created = await createPage(readWrite, {
        title: 'Export me',
        path: `/export-${randomUUID().slice(0, 8)}`,
        body,
      });
      pageId = created.json.page_id as string;
    });

    it('exports Markdown with front matter and the body untouched', async () => {
      const response = await exportRoute.GET(
        request(readOnly, `/api/v1/export/${pageId}?format=md`),
        params(pageId),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/markdown');
      expect(response.headers.get('Content-Disposition')).toContain('.md"');

      const text = await response.text();
      expect(text.startsWith('---\n')).toBe(true);
      expect(text).toContain('title: "Export me"');
      expect(text).toContain(body.trimEnd());
    });

    it('exports HTML with the Mermaid block preserved', async () => {
      const response = await exportRoute.GET(
        request(readOnly, `/api/v1/export/${pageId}?format=html`),
        params(pageId),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');

      const text = await response.text();
      expect(text).toContain('<pre class="mermaid">');
      expect(text).toContain('<h1>Flow</h1>');
    });

    it('rejects a format it does not produce', async () => {
      const response = await exportRoute.GET(
        request(readOnly, `/api/v1/export/${pageId}?format=pdf`),
        params(pageId),
      );
      expect(response.status).toBe(400);
    });

    it('does not export a page from another workspace', async () => {
      const response = await exportRoute.GET(
        request(foreignToken, `/api/v1/export/${pageId}?format=md`),
        params(pageId),
      );
      expect(response.status).toBe(404);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('workspace isolation', () => {
    let pageId = '';

    beforeAll(async () => {
      const created = await createPage(readWrite, {
        title: 'Isolated',
        path: `/isolated-${randomUUID().slice(0, 8)}`,
        body: 'Only the owning workspace may see this.',
      });
      pageId = created.json.page_id as string;
    });

    it('answers 404 — not 403 — for a page in another workspace', async () => {
      // 404 rather than 403 on purpose: a 403 would confirm the page exists.
      const response = await pageRoute.GET(
        request(foreignToken, `/api/v1/pages/${pageId}`),
        params(pageId),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Only the owning workspace');
    });

    it('will not update or delete a page in another workspace', async () => {
      const patched = await pageRoute.PATCH(
        request(foreignToken, `/api/v1/pages/${pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            body: 'overwritten',
            base_content_hash: 'f'.repeat(64),
          }),
        }),
        params(pageId),
      );
      expect(patched.status).toBe(404);

      const deleted = await pageRoute.DELETE(
        request(foreignToken, `/api/v1/pages/${pageId}`, { method: 'DELETE' }),
        params(pageId),
      );
      expect(deleted.status).toBe(404);

      const stillThere = await pageRoute.GET(
        request(readOnly, `/api/v1/pages/${pageId}`),
        params(pageId),
      );
      expect(stillThere.status).toBe(200);
      expect((await stillThere.json()).body).toBe('Only the owning workspace may see this.');
    });

    it('will not return another workspace subtree or history', async () => {
      expect(
        (
          await treeRoute.GET(
            request(foreignToken, `/api/v1/pages/${pageId}/tree`),
            params(pageId),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await versionsRoute.GET(
            request(foreignToken, `/api/v1/pages/${pageId}/versions`),
            params(pageId),
          )
        ).status,
      ).toBe(404);
    });

    it('lists only the caller workspace pages', async () => {
      const response = await pagesRoute.GET(request(foreignToken, '/api/v1/pages?depth=5'));
      const payload = await response.json();
      const ids = JSON.stringify(payload.nodes);
      expect(ids).not.toContain(pageId);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('scope enforcement', () => {
    let pageId = '';

    beforeAll(async () => {
      const created = await createPage(readWrite, {
        title: 'Scoped',
        path: `/scoped-${randomUUID().slice(0, 8)}`,
      });
      pageId = created.json.page_id as string;
    });

    it('refuses a read from a token without pages:read', async () => {
      const response = await pageRoute.GET(
        request(noPageScope, `/api/v1/pages/${pageId}`),
        params(pageId),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('insufficient_scope');
    });

    it('refuses a write from a read-only token', async () => {
      for (const call of [
        () =>
          pagesRoute.POST(
            request(readOnly, '/api/v1/pages', {
              method: 'POST',
              body: JSON.stringify({ title: 'Nope', path: '/nope' }),
            }),
          ),
        () =>
          pageRoute.PATCH(
            request(readOnly, `/api/v1/pages/${pageId}`, {
              method: 'PATCH',
              body: JSON.stringify({ body: 'nope', base_content_hash: 'f'.repeat(64) }),
            }),
            params(pageId),
          ),
        () =>
          pageRoute.DELETE(
            request(readOnly, `/api/v1/pages/${pageId}`, { method: 'DELETE' }),
            params(pageId),
          ),
        () =>
          linkRoute.POST(
            request(readOnly, `/api/v1/pages/${pageId}/link`, {
              method: 'POST',
              body: JSON.stringify({ linked_page_id: null }),
            }),
            params(pageId),
          ),
      ]) {
        const response = await call();
        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe('insufficient_scope');
      }
    });

    it('refuses a delete from a token with pages:write but not pages:delete', async () => {
      const response = await pageRoute.DELETE(
        request(writeNoDelete, `/api/v1/pages/${pageId}`, { method: 'DELETE' }),
        params(pageId),
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error.code).toBe('insufficient_scope');
      expect(body.error.message).toContain('pages:delete');

      const stillThere = await pageRoute.GET(
        request(readOnly, `/api/v1/pages/${pageId}`),
        params(pageId),
      );
      expect(stillThere.status).toBe(200);
    });

    it('refuses search and export without pages:read', async () => {
      expect((await searchRoute.GET(request(noPageScope, '/api/v1/search?q=x'))).status).toBe(403);
      expect(
        (
          await exportRoute.GET(
            request(noPageScope, `/api/v1/export/${pageId}?format=md`),
            params(pageId),
          )
        ).status,
      ).toBe(403);
    });

    it('refuses every page endpoint without credentials', async () => {
      const anonymous = new Request(`${BASE}/api/v1/pages`);
      const response = await pagesRoute.GET(anonymous);
      expect(response.status).toBe(401);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('validation', () => {
    it('rejects a page with no title', async () => {
      const response = await createPage(readWrite, { title: '   ' });
      expect(response.status).toBe(400);
      expect(response.json.error).toMatchObject({ code: 'validation' });
    });

    it('rejects a path that normalises to nothing', async () => {
      const response = await createPage(readWrite, { title: 'Bad path', path: '///' });
      expect(response.status).toBe(400);
    });

    it('answers 404 for a page id that is not a uuid', async () => {
      const response = await pageRoute.GET(
        request(readOnly, '/api/v1/pages/not-a-uuid'),
        params('not-a-uuid'),
      );
      expect(response.status).toBe(404);
    });

    it('rejects a body that is not JSON', async () => {
      const response = await pagesRoute.POST(
        new Request(`${BASE}/api/v1/pages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${readWrite}`, 'Content-Type': 'application/json' },
          body: '{not json',
        }),
      );
      expect(response.status).toBe(400);
    });
  });
});
