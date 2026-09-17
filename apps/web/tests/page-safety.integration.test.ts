import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as ClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';
import type * as RestoreRoute from '@/app/api/v1/pages/[id]/restore/route';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping page safety suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

/**
 * Deleting subtrees, restoring them, and the cross-site rules for cookie-
 * authenticated calls: the paths where one request can undo a lot of other
 * people's work.
 */
describe.skipIf(!probe.reachable)('subtree delete, restore and cookie-authenticated writes', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;

  let pagesRoute: typeof PagesRoute;
  let pageRoute: typeof PageRoute;
  let claimsRoute: typeof ClaimsRoute;
  let restoreRoute: typeof RestoreRoute;

  const suiteTag = `ps-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let deleter = '';
  let otherAgent = '';
  let admin: TestAccount;
  let editor: TestAccount;
  const userIds: string[] = [];

  async function seedToken(name: string, scopes: string[]): Promise<{ id: string; token: string }> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    const [row] = await db
      .insert(schema.agentTokens)
      .values({
        workspaceId,
        name,
        prefix: generated.prefix,
        tokenHash: generated.tokenHash,
        scopes,
      })
      .returning({ id: schema.agentTokens.id });
    return { id: row!.id, token: generated.token };
  }

  function bearer(token: string, target: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${target}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  function withCookie(account: TestAccount, target: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${target}`, {
      ...init,
      headers: { cookie: account.cookie, ...(init.headers ?? {}) },
    });
  }

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  async function createTree(prefix: string): Promise<{ rootId: string; childId: string; rootPath: string }> {
    const rootPath = `/${suiteTag}-${prefix}`;
    const root = await pagesRoute.POST(
      bearer(deleter, '/api/v1/pages', {
        method: 'POST',
        body: JSON.stringify({ title: `Root ${prefix}`, path: rootPath }),
      }),
    );
    const rootJson = (await root.json()) as JsonRecord;
    const child = await pagesRoute.POST(
      bearer(deleter, '/api/v1/pages', {
        method: 'POST',
        body: JSON.stringify({ title: `Child ${prefix}`, path: `${rootPath}/child` }),
      }),
    );
    const childJson = (await child.json()) as JsonRecord;
    return { rootId: rootJson.page_id as string, childId: childJson.page_id as string, rootPath };
  }

  async function claim(token: string, pageId: string): Promise<string> {
    const response = await claimsRoute.POST(
      bearer(token, `/api/v1/pages/${pageId}/claims`, { method: 'POST', body: '{}' }),
      params(pageId),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as JsonRecord).claim_id as string;
  }

  async function auditActions(target: string): Promise<string[]> {
    const { and, eq } = await import('drizzle-orm');
    const rows = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.workspaceId, workspaceId), eq(schema.auditLog.target, target)));
    return rows.map((row) => row.action);
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();

    pagesRoute = await import('@/app/api/v1/pages/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    claimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');
    restoreRoute = await import('@/app/api/v1/pages/[id]/restore/route');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Safety ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning({ id: schema.workspaces.id });
    workspaceId = workspace!.id;

    deleter = (await seedToken('deleter', ['pages:read', 'pages:write', 'pages:delete'])).token;
    otherAgent = (await seedToken('other-agent', ['pages:read', 'pages:write'])).token;

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    userIds.push(admin.userId, editor.userId);
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { eq, inArray } = await import('drizzle-orm');
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  describe('DELETE /api/v1/pages/{id}', () => {
    it('refuses with conflict when another actor holds a claim in the subtree, and audits it', async () => {
      const { rootId, childId } = await createTree('held');
      await claim(otherAgent, childId);

      const response = await pageRoute.DELETE(
        bearer(deleter, `/api/v1/pages/${rootId}`, { method: 'DELETE' }),
        params(rootId),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as JsonRecord;
      expect(body.error.code).toBe('conflict');
      expect(body.error.details.claims[0]).toMatchObject({ page_id: childId, held_by: 'other-agent' });

      const stillThere = await pageRoute.GET(bearer(deleter, `/api/v1/pages/${childId}`), params(childId));
      expect(stillThere.status).toBe(200);
      expect(await auditActions(rootId)).toContain('page.delete_rejected');
    });

    it('does not count the caller’s own claim', async () => {
      const { rootId } = await createTree('own');
      await claim(deleter, rootId);
      const response = await pageRoute.DELETE(
        bearer(deleter, `/api/v1/pages/${rootId}`, { method: 'DELETE' }),
        params(rootId),
      );
      expect(response.status).toBe(200);
    });

    it('refuses a human editor too, but lets a human administrator override', async () => {
      const { rootId, childId } = await createTree('admin');
      await claim(otherAgent, childId);

      const asEditor = await pageRoute.DELETE(
        withCookie(editor, `/api/v1/pages/${rootId}`, {
          method: 'DELETE',
          headers: { origin: BASE, 'content-type': 'application/json' },
        }),
        params(rootId),
      );
      expect(asEditor.status).toBe(409);

      const asAdmin = await pageRoute.DELETE(
        withCookie(admin, `/api/v1/pages/${rootId}`, {
          method: 'DELETE',
          headers: { origin: BASE, 'content-type': 'application/json' },
        }),
        params(rootId),
      );
      expect(asAdmin.status).toBe(200);
      expect(((await asAdmin.json()) as JsonRecord).pages_deleted).toBe(2);
    });
  });

  describe('POST /api/v1/pages/{id}/restore', () => {
    it('is refused to an agent token however it is scoped, and to an editor', async () => {
      const { rootId } = await createTree('restore-authz');
      await pageRoute.DELETE(bearer(deleter, `/api/v1/pages/${rootId}`, { method: 'DELETE' }), params(rootId));

      const asAgent = await restoreRoute.POST(
        bearer(deleter, `/api/v1/pages/${rootId}/restore`, { method: 'POST', body: '{}' }),
        params(rootId),
      );
      expect(asAgent.status).toBe(403);

      const asEditor = await restoreRoute.POST(
        withCookie(editor, `/api/v1/pages/${rootId}/restore`, {
          method: 'POST',
          headers: { origin: BASE, 'content-type': 'application/json' },
        }),
        params(rootId),
      );
      expect(asEditor.status).toBe(403);
    });

    it('restores a deleted subtree for an administrator', async () => {
      const { rootId, childId } = await createTree('restore-ok');
      await pageRoute.DELETE(bearer(deleter, `/api/v1/pages/${rootId}`, { method: 'DELETE' }), params(rootId));
      expect((await pageRoute.GET(bearer(deleter, `/api/v1/pages/${childId}`), params(childId))).status).toBe(404);

      const restored = await restoreRoute.POST(
        withCookie(admin, `/api/v1/pages/${rootId}/restore`, {
          method: 'POST',
          headers: { origin: BASE, 'content-type': 'application/json' },
        }),
        params(rootId),
      );
      expect(restored.status).toBe(200);
      expect(((await restored.json()) as JsonRecord).pages_restored).toBe(2);
      expect((await pageRoute.GET(bearer(deleter, `/api/v1/pages/${childId}`), params(childId))).status).toBe(200);
      expect(await auditActions(rootId)).toContain('page.restored');
    });

    it('answers conflict when a live page has taken one of the paths', async () => {
      const { rootId, rootPath } = await createTree('restore-collide');
      await pageRoute.DELETE(bearer(deleter, `/api/v1/pages/${rootId}`, { method: 'DELETE' }), params(rootId));
      const squatter = await pagesRoute.POST(
        bearer(deleter, '/api/v1/pages', {
          method: 'POST',
          body: JSON.stringify({ title: 'Squatter', path: `${rootPath}/child` }),
        }),
      );
      expect(squatter.status).toBe(201);

      const restored = await restoreRoute.POST(
        withCookie(admin, `/api/v1/pages/${rootId}/restore`, {
          method: 'POST',
          headers: { origin: BASE, 'content-type': 'application/json' },
        }),
        params(rootId),
      );
      expect(restored.status).toBe(409);
      const body = (await restored.json()) as JsonRecord;
      expect(body.error.code).toBe('conflict');
      expect(body.error.details.paths).toEqual([`${rootPath}/child`]);
      expect((await pageRoute.GET(bearer(deleter, `/api/v1/pages/${rootId}`), params(rootId))).status).toBe(404);
    });
  });

  describe('cookie-authenticated writes', () => {
    const body = () => JSON.stringify({ title: 'Cookie page', path: `/${suiteTag}-cookie-${randomUUID().slice(0, 6)}` });

    it('accepts a same-origin JSON request', async () => {
      const response = await pagesRoute.POST(
        withCookie(editor, '/api/v1/pages', {
          method: 'POST',
          body: body(),
          headers: { origin: BASE, 'content-type': 'application/json' },
        }),
      );
      expect(response.status).toBe(201);
    });

    it('accepts Sec-Fetch-Site: same-origin in place of an Origin header', async () => {
      const response = await pagesRoute.POST(
        withCookie(editor, '/api/v1/pages', {
          method: 'POST',
          body: body(),
          headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        }),
      );
      expect(response.status).toBe(201);
    });

    it('refuses a request from another origin, even a sibling subdomain', async () => {
      const response = await pagesRoute.POST(
        withCookie(editor, '/api/v1/pages', {
          method: 'POST',
          body: body(),
          headers: {
            origin: 'http://blog.localhost:3000',
            'sec-fetch-site': 'same-site',
            'content-type': 'application/json',
          },
        }),
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as JsonRecord).error.code).toBe('forbidden');
    });

    it('refuses a request with no origin information at all', async () => {
      const response = await pagesRoute.POST(
        withCookie(editor, '/api/v1/pages', {
          method: 'POST',
          body: body(),
          headers: { 'content-type': 'application/json' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('refuses a same-origin body that is not declared as JSON', async () => {
      const response = await pagesRoute.POST(
        withCookie(editor, '/api/v1/pages', {
          method: 'POST',
          body: body(),
          headers: { origin: BASE, 'content-type': 'text/plain' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('leaves bearer-token requests alone', async () => {
      const response = await pagesRoute.POST(
        new Request(`${BASE}/api/v1/pages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${deleter}`, 'content-type': 'text/plain' },
          body: body(),
        }),
      );
      expect(response.status).toBe(201);
    });

    it('still answers reads for a cookie with no origin', async () => {
      const response = await pagesRoute.GET(withCookie(editor, '/api/v1/pages'));
      expect(response.status).toBe(200);
    });
  });
});
