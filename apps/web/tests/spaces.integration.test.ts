import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as SpacesRoute from '@/app/api/v1/spaces/route';
import type * as SpaceRoute from '@/app/api/v1/spaces/[key]/route';
import type * as ArchiveRoute from '@/app/api/v1/spaces/[key]/archive/route';
import type * as UnarchiveRoute from '@/app/api/v1/spaces/[key]/unarchive/route';
import type * as SpaceExportRoute from '@/app/api/v1/spaces/[key]/export/route';
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as PageClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';
import type * as NotesRoute from '@/app/api/v1/pages/[id]/notes/route';
import type * as AnchorsRoute from '@/app/api/v1/pages/[id]/anchors/route';
import type * as CheckRoute from '@/app/api/v1/pages/[id]/anchors/check/route';
import type * as TreeRoute from '@/app/api/v1/pages/[id]/tree/route';
import type * as VersionsRoute from '@/app/api/v1/pages/[id]/versions/route';
import type * as LinkRoute from '@/app/api/v1/pages/[id]/link/route';
import type * as ClaimRoute from '@/app/api/v1/claims/[claimId]/route';
import type * as PresenceRoute from '@/app/api/v1/claims/route';
import type * as AnchorRoute from '@/app/api/v1/anchors/[anchorId]/route';
import type * as ConfirmRoute from '@/app/api/v1/anchors/[anchorId]/confirm/route';
import type * as SearchRoute from '@/app/api/v1/search/route';
import type * as ExportRoute from '@/app/api/v1/export/[id]/route';
import type * as AuditRoute from '@/app/api/v1/audit/route';
import type * as TokenActions from '@/app/tokens/actions';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping spaces suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

// Server actions and page components read the signed-in account through
// `getSessionContext`; here it is whatever the test says. The REST handlers do
// not use it — they resolve the cookie or the bearer token themselves.
const session = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('@/lib/session', () => ({ getSessionContext: async () => session.current }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

/** A word the full-text index keeps whole: letters only. */
function marker(prefix: string): string {
  const letters = randomUUID()
    .replace(/[^a-f]/g, '')
    .slice(0, 8)
    .replace(/./g, (c) => String.fromCharCode(c.charCodeAt(0) + 10));
  return `${prefix}${letters}`;
}

describe.skipIf(!probe.reachable)('spaces', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;

  let spacesRoute: typeof SpacesRoute;
  let spaceRoute: typeof SpaceRoute;
  let archiveRoute: typeof ArchiveRoute;
  let unarchiveRoute: typeof UnarchiveRoute;
  let spaceExportRoute: typeof SpaceExportRoute;
  let pagesRoute: typeof PagesRoute;
  let pageRoute: typeof PageRoute;
  let pageClaimsRoute: typeof PageClaimsRoute;
  let notesRoute: typeof NotesRoute;
  let anchorsRoute: typeof AnchorsRoute;
  let checkRoute: typeof CheckRoute;
  let treeRoute: typeof TreeRoute;
  let versionsRoute: typeof VersionsRoute;
  let linkRoute: typeof LinkRoute;
  let claimRoute: typeof ClaimRoute;
  let presenceRoute: typeof PresenceRoute;
  let anchorRoute: typeof AnchorRoute;
  let confirmRoute: typeof ConfirmRoute;
  let searchRoute: typeof SearchRoute;
  let exportRoute: typeof ExportRoute;
  let auditRoute: typeof AuditRoute;
  let tokenActions: typeof TokenActions;

  const suiteTag = `sp-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  const userIds: string[] = [];

  let everywhere = '';
  let onlyAlpha = '';
  let alphaId = '';
  let betaId = '';

  async function seedToken(name: string, scopes: string[], spaceIds: string[] | null): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId,
      name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes,
      spaceIds,
    });
    return generated.token;
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

  function cookie(account: TestAccount, target: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${target}`, {
      ...init,
      headers: {
        cookie: account.cookie,
        origin: BASE,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });
  const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

  async function json(response: Response): Promise<{ status: number; body: JsonRecord }> {
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as JsonRecord) };
  }

  async function createPage(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: JsonRecord }> {
    return json(
      await pagesRoute.POST(bearer(token, '/api/v1/pages', { method: 'POST', body: JSON.stringify(body) })),
    );
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();

    spacesRoute = await import('@/app/api/v1/spaces/route');
    spaceRoute = await import('@/app/api/v1/spaces/[key]/route');
    archiveRoute = await import('@/app/api/v1/spaces/[key]/archive/route');
    unarchiveRoute = await import('@/app/api/v1/spaces/[key]/unarchive/route');
    spaceExportRoute = await import('@/app/api/v1/spaces/[key]/export/route');
    pagesRoute = await import('@/app/api/v1/pages/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    pageClaimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');
    notesRoute = await import('@/app/api/v1/pages/[id]/notes/route');
    anchorsRoute = await import('@/app/api/v1/pages/[id]/anchors/route');
    checkRoute = await import('@/app/api/v1/pages/[id]/anchors/check/route');
    treeRoute = await import('@/app/api/v1/pages/[id]/tree/route');
    versionsRoute = await import('@/app/api/v1/pages/[id]/versions/route');
    linkRoute = await import('@/app/api/v1/pages/[id]/link/route');
    claimRoute = await import('@/app/api/v1/claims/[claimId]/route');
    presenceRoute = await import('@/app/api/v1/claims/route');
    anchorRoute = await import('@/app/api/v1/anchors/[anchorId]/route');
    confirmRoute = await import('@/app/api/v1/anchors/[anchorId]/confirm/route');
    searchRoute = await import('@/app/api/v1/search/route');
    exportRoute = await import('@/app/api/v1/export/[id]/route');
    auditRoute = await import('@/app/api/v1/audit/route');
    tokenActions = await import('@/app/tokens/actions');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Spaces ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning();
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `${suiteTag}-other` })
      .returning();
    workspaceId = workspace!.id;
    otherWorkspaceId = other!.id;

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    userIds.push(admin.userId, editor.userId);

    // A space with the key ALPHA in another workspace: keys are unique per
    // workspace, not across the instance.
    await db.insert(schema.spaces).values({ workspaceId: otherWorkspaceId, key: 'ALPHA', name: 'Theirs' });

    session.current = {
      userId: admin.userId,
      name: 'Admin',
      email: admin.email,
      role: 'admin',
      workspace,
    };
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { eq, inArray } = await import('drizzle-orm');
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (otherWorkspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  /* ---------------------------------------------------------------- */

  describe('creating and changing spaces', () => {
    it('lets an administrator create a space, storing the key in uppercase', async () => {
      const alpha = await json(
        await spacesRoute.POST(
          cookie(admin, '/api/v1/spaces', {
            method: 'POST',
            body: JSON.stringify({ key: 'alpha', name: 'Alpha project', description: 'The *first* one.', icon: '🅰' }),
          }),
        ),
      );
      expect(alpha.status).toBe(201);
      expect(alpha.body).toMatchObject({
        key: 'ALPHA',
        name: 'Alpha project',
        description: 'The *first* one.',
        icon: '🅰',
        archived: false,
        has_repository: false,
        repository: null,
      });

      const beta = await json(
        await spacesRoute.POST(
          cookie(admin, '/api/v1/spaces', { method: 'POST', body: JSON.stringify({ key: 'BETA2', name: 'Beta' }) }),
        ),
      );
      expect(beta.status).toBe(201);

      const { and, eq } = await import('drizzle-orm');
      const rows = await db
        .select()
        .from(schema.spaces)
        .where(and(eq(schema.spaces.workspaceId, workspaceId)));
      alphaId = rows.find((row) => row.key === 'ALPHA')!.id;
      betaId = rows.find((row) => row.key === 'BETA2')!.id;
      expect(rows.find((row) => row.key === 'ALPHA')?.createdBy).toBe(admin.userId);

      const audited = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.workspaceId, workspaceId), eq(schema.auditLog.action, 'space.created')));
      expect(audited.map((row) => row.metadata?.key).sort()).toEqual(['ALPHA', 'BETA2']);

      everywhere = await seedToken('everywhere', ['identity:read', 'pages:read', 'pages:write', 'pages:delete', 'audit:read'], null);
      onlyAlpha = await seedToken('only-alpha', ['identity:read', 'pages:read', 'pages:write', 'pages:delete', 'audit:read'], [alphaId]);
    });

    it('refuses keys that are not 2–10 letters or digits', async () => {
      for (const key of ['A', 'ABCDEFGHIJK', 'MY-APP', 'MY APP', '']) {
        const response = await json(
          await spacesRoute.POST(
            cookie(admin, '/api/v1/spaces', { method: 'POST', body: JSON.stringify({ key, name: 'Bad' }) }),
          ),
        );
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('validation');
      }
    });

    it('refuses a key already used in the workspace, case-insensitively', async () => {
      const response = await json(
        await spacesRoute.POST(
          cookie(admin, '/api/v1/spaces', { method: 'POST', body: JSON.stringify({ key: 'Alpha', name: 'Again' }) }),
        ),
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('conflict');
    });

    it('leaves creating and changing spaces to administrators', async () => {
      const byEditor = await spacesRoute.POST(
        cookie(editor, '/api/v1/spaces', { method: 'POST', body: JSON.stringify({ key: 'EDIT', name: 'No' }) }),
      );
      expect(byEditor.status).toBe(403);

      const byToken = await spacesRoute.POST(
        bearer(everywhere, '/api/v1/spaces', { method: 'POST', body: JSON.stringify({ key: 'TOKEN', name: 'No' }) }),
      );
      expect(byToken.status).toBe(403);

      const patchByToken = await spaceRoute.PATCH(
        bearer(everywhere, '/api/v1/spaces/ALPHA', { method: 'PATCH', body: JSON.stringify({ name: 'No' }) }),
        keyParams('ALPHA'),
      );
      expect(patchByToken.status).toBe(403);

      const archiveByEditor = await archiveRoute.POST(
        cookie(editor, '/api/v1/spaces/ALPHA/archive', { method: 'POST' }),
        keyParams('ALPHA'),
      );
      expect(archiveByEditor.status).toBe(403);
    });

    it('never changes a key', async () => {
      const response = await json(
        await spaceRoute.PATCH(
          cookie(admin, '/api/v1/spaces/ALPHA', { method: 'PATCH', body: JSON.stringify({ key: 'OMEGA', name: 'Renamed' }) }),
          keyParams('ALPHA'),
        ),
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('validation');

      const still = await json(await spaceRoute.GET(cookie(admin, '/api/v1/spaces/ALPHA'), keyParams('ALPHA')));
      expect(still.body.name).toBe('Alpha project');
    });

    it('changes name, description, icon and repository, and shows the repository only to administrators', async () => {
      const patched = await json(
        await spaceRoute.PATCH(
          cookie(admin, '/api/v1/spaces/alpha', {
            method: 'PATCH',
            body: JSON.stringify({
              name: 'Alpha',
              description: 'Updated.',
              icon: '',
              repository: { url: 'https://git.example.com/org/alpha.git', default_ref: 'main' },
            }),
          }),
          keyParams('alpha'),
        ),
      );
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        key: 'ALPHA',
        name: 'Alpha',
        description: 'Updated.',
        icon: null,
        has_repository: true,
        repository: { url: 'https://git.example.com/org/alpha.git', default_ref: 'main', auth_token_env: null },
      });

      const asToken = await json(await spaceRoute.GET(bearer(everywhere, '/api/v1/spaces/ALPHA'), keyParams('ALPHA')));
      expect(asToken.status).toBe(200);
      expect(asToken.body.has_repository).toBe(true);
      expect(asToken.body).not.toHaveProperty('repository');

      const badRepository = await spaceRoute.PATCH(
        cookie(admin, '/api/v1/spaces/ALPHA', {
          method: 'PATCH',
          body: JSON.stringify({ repository: { url: 'https://user:secret@git.example.com/x.git', default_ref: 'main' } }),
        }),
        keyParams('ALPHA'),
      );
      expect(badRepository.status).toBe(400);

      const { and, eq } = await import('drizzle-orm');
      const audited = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.target, alphaId), eq(schema.auditLog.action, 'space.repository_set')));
      expect(audited).toHaveLength(1);
    });

    it('accepts only a page of the same space as its home page', async () => {
      const alphaHome = await createPage(everywhere, { space: 'ALPHA', title: 'Welcome', path: '/welcome' });
      const betaPage = await createPage(everywhere, { space: 'BETA2', title: 'Elsewhere', path: '/elsewhere' });

      const refused = await json(
        await spaceRoute.PATCH(
          cookie(admin, '/api/v1/spaces/ALPHA', { method: 'PATCH', body: JSON.stringify({ home_page_id: betaPage.body.page_id }) }),
          keyParams('ALPHA'),
        ),
      );
      expect(refused.status).toBe(400);

      const accepted = await json(
        await spaceRoute.PATCH(
          cookie(admin, '/api/v1/spaces/ALPHA', { method: 'PATCH', body: JSON.stringify({ home_page_id: alphaHome.body.page_id }) }),
          keyParams('ALPHA'),
        ),
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.home_page_id).toBe(alphaHome.body.page_id);
    });

    it('archives a space: hidden from the list, no new pages, restorable', async () => {
      await spacesRoute.POST(
        cookie(admin, '/api/v1/spaces', { method: 'POST', body: JSON.stringify({ key: 'OLD', name: 'Old project' }) }),
      );
      const archivedMarker = marker('archived');
      expect((await createPage(everywhere, { space: 'OLD', title: 'Kept', path: '/kept', body: archivedMarker })).status).toBe(201);

      const archived = await json(await archiveRoute.POST(cookie(admin, '/api/v1/spaces/OLD/archive', { method: 'POST' }), keyParams('OLD')));
      expect(archived.status).toBe(200);
      expect(archived.body.archived).toBe(true);

      const listed = await json(await spacesRoute.GET(bearer(everywhere, '/api/v1/spaces')));
      expect(listed.body.spaces.map((space: JsonRecord) => space.key)).not.toContain('OLD');
      const withArchived = await json(await spacesRoute.GET(bearer(everywhere, '/api/v1/spaces?include_archived=true')));
      expect(withArchived.body.spaces.map((space: JsonRecord) => space.key)).toContain('OLD');

      const refused = await createPage(everywhere, { space: 'OLD', title: 'New', path: '/new' });
      expect(refused.status).toBe(409);

      // "All spaces" leaves an archived space out of search; naming it searches it.
      const all = await json(await searchRoute.GET(bearer(everywhere, `/api/v1/search?q=${archivedMarker}`)));
      expect(all.body.results).toEqual([]);
      const named = await json(await searchRoute.GET(bearer(everywhere, `/api/v1/search?q=${archivedMarker}&space=OLD`)));
      expect(named.body.results).toHaveLength(1);

      const restored = await json(await unarchiveRoute.POST(cookie(admin, '/api/v1/spaces/OLD/unarchive', { method: 'POST' }), keyParams('OLD')));
      expect(restored.body.archived).toBe(false);
      expect((await createPage(everywhere, { space: 'OLD', title: 'New', path: '/new' })).status).toBe(201);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('paths per space', () => {
    it('requires a space to create a page', async () => {
      const missing = await createPage(everywhere, { title: 'Nowhere', path: '/nowhere' });
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe('validation');

      const unknown = await createPage(everywhere, { space: 'NOPE', title: 'Nowhere', path: '/nowhere' });
      expect(unknown.status).toBe(404);
    });

    it('allows the same path once in each space, and only once in a space', async () => {
      const inAlpha = await createPage(everywhere, { space: 'ALPHA', title: 'Backend', path: '/backend' });
      const inBeta = await createPage(everywhere, { space: 'BETA2', title: 'Backend', path: '/backend' });
      expect(inAlpha.status).toBe(201);
      expect(inBeta.status).toBe(201);
      expect(inAlpha.body.space).toEqual({ key: 'ALPHA', name: 'Alpha' });
      expect(inBeta.body.space).toEqual({ key: 'BETA2', name: 'Beta' });

      const again = await createPage(everywhere, { space: 'ALPHA', title: 'Backend again', path: '/backend' });
      expect(again.status).toBe(409);
    });

    it('looks a path up inside the space it names, and refuses a path without one', async () => {
      const alpha = await json(await pagesRoute.GET(bearer(everywhere, '/api/v1/pages?space=ALPHA&path=/backend&depth=1')));
      const beta = await json(await pagesRoute.GET(bearer(everywhere, '/api/v1/pages?space=beta2&path=/backend&depth=1')));
      expect(alpha.body.nodes).toHaveLength(1);
      expect(beta.body.nodes).toHaveLength(1);
      expect(alpha.body.nodes[0].page_id).not.toBe(beta.body.nodes[0].page_id);
      expect(alpha.body.nodes[0].space.key).toBe('ALPHA');

      const ambiguous = await pagesRoute.GET(bearer(everywhere, '/api/v1/pages?path=/backend'));
      expect(ambiguous.status).toBe(400);
    });

    it('creates a subsection under a parent of the same space only', async () => {
      const alphaBackend = await json(await pagesRoute.GET(bearer(everywhere, '/api/v1/pages?space=ALPHA&path=/backend&depth=1')));
      const betaBackend = await json(await pagesRoute.GET(bearer(everywhere, '/api/v1/pages?space=BETA2&path=/backend&depth=1')));

      const child = await createPage(everywhere, {
        space: 'ALPHA',
        title: 'Auth',
        parent_id: alphaBackend.body.nodes[0].page_id,
      });
      expect(child.status).toBe(201);
      expect(child.body.path).toBe('/backend/auth');

      const crossing = await createPage(everywhere, {
        space: 'ALPHA',
        title: 'Auth',
        parent_id: betaBackend.body.nodes[0].page_id,
      });
      expect(crossing.status).toBe(404);
    });

    it('deletes a subtree in its own space and leaves the same paths in another space alone', async () => {
      const betaChild = await createPage(everywhere, { space: 'BETA2', title: 'Auth', path: '/backend/auth' });
      expect(betaChild.status).toBe(201);
      const alphaBackend = await json(await pagesRoute.GET(bearer(everywhere, '/api/v1/pages?space=ALPHA&path=/backend&depth=1')));
      const alphaBackendId = alphaBackend.body.nodes[0].page_id as string;

      const deleted = await json(
        await pageRoute.DELETE(bearer(everywhere, `/api/v1/pages/${alphaBackendId}`, { method: 'DELETE' }), idParams(alphaBackendId)),
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body.pages_deleted).toBe(2);

      const betaStill = await pageRoute.GET(bearer(everywhere, `/api/v1/pages/${betaChild.body.page_id}`), idParams(betaChild.body.page_id));
      expect(betaStill.status).toBe(200);
      const betaTree = await json(await pagesRoute.GET(bearer(everywhere, '/api/v1/pages?space=BETA2&path=/backend&depth=2')));
      expect(betaTree.body.nodes[0].children.map((node: JsonRecord) => node.path)).toEqual(['/backend/auth']);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('a token limited to one space', () => {
    let betaPageId = '';
    let alphaPageId = '';
    let betaClaimId = '';
    let alphaClaimId = '';
    let betaAnchorId = '';
    let betaMarker = '';
    let alphaMarker = '';

    beforeAll(async () => {
      betaMarker = marker('beta');
      alphaMarker = marker('alpha');
      const beta = await createPage(everywhere, { space: 'BETA2', title: 'Beta secret', path: '/secret', body: `Beta ${betaMarker}` });
      const alpha = await createPage(everywhere, { space: 'ALPHA', title: 'Alpha open', path: '/open', body: `Alpha ${alphaMarker}` });
      betaPageId = beta.body.page_id as string;
      alphaPageId = alpha.body.page_id as string;

      const betaClaim = await json(
        await pageClaimsRoute.POST(bearer(everywhere, `/api/v1/pages/${betaPageId}/claims`, { method: 'POST', body: '{}' }), idParams(betaPageId)),
      );
      betaClaimId = betaClaim.body.claim_id as string;
      expect(betaClaim.body.space).toEqual({ key: 'BETA2', name: 'Beta' });
      const alphaClaim = await json(
        await pageClaimsRoute.POST(bearer(everywhere, `/api/v1/pages/${alphaPageId}/claims`, { method: 'POST', body: '{}' }), idParams(alphaPageId)),
      );
      alphaClaimId = alphaClaim.body.claim_id as string;

      const [anchor] = await db
        .insert(schema.anchors)
        .values({
          workspaceId,
          pageId: betaPageId,
          language: 'swift',
          kind: 'func',
          qualifiedName: 'Hidden.thing()',
          fileHint: 'Sources/Hidden.swift',
          tokenHash: 'f'.repeat(64),
          state: 'stale',
          createdByType: 'user',
          createdById: admin.userId,
        })
        .returning({ id: schema.anchors.id });
      betaAnchorId = anchor!.id;
    });

    it('gets 404 for a page in another space, on every page endpoint', async () => {
      const id = betaPageId;
      const answers = await Promise.all([
        pageRoute.GET(bearer(onlyAlpha, `/api/v1/pages/${id}`), idParams(id)),
        pageRoute.PATCH(
          bearer(onlyAlpha, `/api/v1/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ body: 'x', base_content_hash: 'f'.repeat(64) }) }),
          idParams(id),
        ),
        pageRoute.DELETE(bearer(onlyAlpha, `/api/v1/pages/${id}`, { method: 'DELETE' }), idParams(id)),
        pageClaimsRoute.POST(bearer(onlyAlpha, `/api/v1/pages/${id}/claims`, { method: 'POST', body: '{}' }), idParams(id)),
        pageClaimsRoute.GET(bearer(onlyAlpha, `/api/v1/pages/${id}/claims`), idParams(id)),
        notesRoute.GET(bearer(onlyAlpha, `/api/v1/pages/${id}/notes`), idParams(id)),
        notesRoute.POST(
          bearer(onlyAlpha, `/api/v1/pages/${id}/notes`, { method: 'POST', body: JSON.stringify({ claim_id: betaClaimId, text: 'hi' }) }),
          idParams(id),
        ),
        anchorsRoute.GET(bearer(onlyAlpha, `/api/v1/pages/${id}/anchors`), idParams(id)),
        anchorsRoute.POST(
          bearer(onlyAlpha, `/api/v1/pages/${id}/anchors`, { method: 'POST', body: JSON.stringify({ file: 'a.swift', qualified_name: 'A' }) }),
          idParams(id),
        ),
        checkRoute.GET(bearer(onlyAlpha, `/api/v1/pages/${id}/anchors/check`), idParams(id)),
        checkRoute.POST(bearer(onlyAlpha, `/api/v1/pages/${id}/anchors/check`, { method: 'POST' }), idParams(id)),
        treeRoute.GET(bearer(onlyAlpha, `/api/v1/pages/${id}/tree`), idParams(id)),
        versionsRoute.GET(bearer(onlyAlpha, `/api/v1/pages/${id}/versions`), idParams(id)),
        linkRoute.POST(
          bearer(onlyAlpha, `/api/v1/pages/${id}/link`, { method: 'POST', body: JSON.stringify({ linked_page_id: null }) }),
          idParams(id),
        ),
        exportRoute.GET(bearer(onlyAlpha, `/api/v1/export/${id}?format=md`), idParams(id)),
      ]);
      expect(answers.map((response) => response.status)).toEqual(answers.map(() => 404));

      // The same calls reach its own space.
      expect((await pageRoute.GET(bearer(onlyAlpha, `/api/v1/pages/${alphaPageId}`), idParams(alphaPageId))).status).toBe(200);
      expect((await exportRoute.GET(bearer(onlyAlpha, `/api/v1/export/${alphaPageId}?format=md`), idParams(alphaPageId))).status).toBe(200);
    });

    it('gets 404 for a claim and an anchor on a page in another space', async () => {
      const claimParams = { params: Promise.resolve({ claimId: betaClaimId }) };
      const anchorParams = { params: Promise.resolve({ anchorId: betaAnchorId }) };
      const answers = await Promise.all([
        claimRoute.PATCH(bearer(onlyAlpha, `/api/v1/claims/${betaClaimId}`, { method: 'PATCH', body: '{}' }), claimParams),
        claimRoute.DELETE(bearer(onlyAlpha, `/api/v1/claims/${betaClaimId}`, { method: 'DELETE' }), claimParams),
        anchorRoute.DELETE(bearer(onlyAlpha, `/api/v1/anchors/${betaAnchorId}`, { method: 'DELETE' }), anchorParams),
        confirmRoute.POST(bearer(onlyAlpha, `/api/v1/anchors/${betaAnchorId}/confirm`, { method: 'POST', body: '{}' }), anchorParams),
      ]);
      expect(answers.map((response) => response.status)).toEqual([404, 404, 404, 404]);

      const { eq } = await import('drizzle-orm');
      const [anchor] = await db.select().from(schema.anchors).where(eq(schema.anchors.id, betaAnchorId));
      expect(anchor).toBeDefined();
    });

    it('cannot name another space as a parameter', async () => {
      const answers = await Promise.all([
        pagesRoute.GET(bearer(onlyAlpha, '/api/v1/pages?space=BETA2')),
        searchRoute.GET(bearer(onlyAlpha, `/api/v1/search?q=${betaMarker}&space=BETA2`)),
        presenceRoute.GET(bearer(onlyAlpha, '/api/v1/claims?space=BETA2')),
        spaceRoute.GET(bearer(onlyAlpha, '/api/v1/spaces/BETA2'), keyParams('BETA2')),
        spaceExportRoute.GET(bearer(onlyAlpha, '/api/v1/spaces/BETA2/export'), keyParams('BETA2')),
        pagesRoute.POST(
          bearer(onlyAlpha, '/api/v1/pages', { method: 'POST', body: JSON.stringify({ space: 'BETA2', title: 'Sneak', path: '/sneak' }) }),
        ),
      ]);
      expect(answers.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
    });

    it('sees only its own space in the space list, the tree, search and presence', async () => {
      const spaces = await json(await spacesRoute.GET(bearer(onlyAlpha, '/api/v1/spaces?include_archived=true')));
      expect(spaces.body.spaces.map((space: JsonRecord) => space.key)).toEqual(['ALPHA']);
      expect(spaces.body.spaces[0].page_count).toBeGreaterThan(0);
      expect(typeof spaces.body.spaces[0].last_updated_at).toBe('string');

      const tree = await json(await pagesRoute.GET(bearer(onlyAlpha, '/api/v1/pages?depth=5')));
      expect(new Set(tree.body.nodes.map((node: JsonRecord) => node.space.key))).toEqual(new Set(['ALPHA']));
      expect(tree.body.nodes.map((node: JsonRecord) => node.page_id)).toContain(alphaPageId);

      const betaSearch = await json(await searchRoute.GET(bearer(onlyAlpha, `/api/v1/search?q=${betaMarker}`)));
      expect(betaSearch.body.results).toEqual([]);
      const alphaSearch = await json(await searchRoute.GET(bearer(onlyAlpha, `/api/v1/search?q=${alphaMarker}`)));
      expect(alphaSearch.body.results.map((hit: JsonRecord) => hit.page_id)).toEqual([alphaPageId]);
      expect(alphaSearch.body.results[0].space).toEqual({ key: 'ALPHA', name: 'Alpha' });

      const presence = await json(await presenceRoute.GET(bearer(onlyAlpha, '/api/v1/claims')));
      const claimIds = presence.body.claims.map((claim: JsonRecord) => claim.claim_id);
      expect(claimIds).toContain(alphaClaimId);
      expect(claimIds).not.toContain(betaClaimId);

      // A token with no restriction sees both, and can narrow to one.
      const full = await json(await presenceRoute.GET(bearer(everywhere, '/api/v1/claims')));
      expect(full.body.claims.map((claim: JsonRecord) => claim.claim_id)).toEqual(expect.arrayContaining([alphaClaimId, betaClaimId]));
      const narrowed = await json(await presenceRoute.GET(bearer(everywhere, '/api/v1/claims?space=BETA2')));
      expect(narrowed.body.claims.map((claim: JsonRecord) => claim.claim_id)).toEqual([betaClaimId]);
      expect(narrowed.body.claims[0].space).toEqual({ key: 'BETA2', name: 'Beta' });

      const everywhereSearch = await json(await searchRoute.GET(bearer(everywhere, `/api/v1/search?q=${betaMarker}`)));
      expect(everywhereSearch.body.results.map((hit: JsonRecord) => hit.page_id)).toEqual([betaPageId]);
    });

    it('cannot read the audit log, which covers every space', async () => {
      const refused = await json(await auditRoute.GET(bearer(onlyAlpha, '/api/v1/audit')));
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('forbidden');
      expect((await auditRoute.GET(bearer(everywhere, '/api/v1/audit'))).status).toBe(200);
    });

    it('exports its own space as a ZIP of Markdown that mirrors the tree', async () => {
      await createPage(everywhere, { space: 'ALPHA', title: 'Open child', path: '/open/child', body: '# Child\n' });
      const response = await spaceExportRoute.GET(bearer(onlyAlpha, '/api/v1/spaces/ALPHA/export?format=md'), keyParams('ALPHA'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/zip');
      expect(response.headers.get('content-disposition')).toContain('ALPHA.zip');
      const archive = Buffer.from(await response.arrayBuffer());
      const text = archive.toString('latin1');
      expect(text.startsWith('PK')).toBe(true);
      expect(text).toContain('ALPHA/open.md');
      expect(text).toContain('ALPHA/open/child.md');
      expect(text).not.toContain('secret.md');
    });

    it('cannot pair pages across spaces, even with access to both', async () => {
      const response = await linkRoute.POST(
        bearer(everywhere, `/api/v1/pages/${alphaPageId}/link`, { method: 'POST', body: JSON.stringify({ linked_page_id: betaPageId }) }),
        idParams(alphaPageId),
      );
      expect(response.status).toBe(404);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('issuing a token limited to spaces', () => {
    function form(values: Array<[string, string]>): FormData {
      const data = new FormData();
      for (const [key, value] of values) data.append(key, value);
      return data;
    }

    it('stores the chosen spaces on the token and audits them by key', async () => {
      const name = `limited-${randomUUID().slice(0, 6)}`;
      const result = await tokenActions.createAgentTokenAction(
        {},
        form([
          ['name', name],
          ['expiresInDays', '7'],
          ['scopes', 'pages:read'],
          ['spaceAccess', 'selected'],
          ['spaceIds', betaId],
        ]),
      );
      expect(result.issuedToken).toMatch(/^cww_/);

      const { and, eq } = await import('drizzle-orm');
      const [row] = await db
        .select()
        .from(schema.agentTokens)
        .where(and(eq(schema.agentTokens.workspaceId, workspaceId), eq(schema.agentTokens.name, name)));
      expect(row?.spaceIds).toEqual([betaId]);

      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.target, row!.id), eq(schema.auditLog.action, 'token.issued')));
      expect(audit?.metadata?.spaces).toEqual(['BETA2']);

      // The issued token works, and only in that space.
      const token = result.issuedToken as string;
      expect((await pagesRoute.GET(bearer(token, '/api/v1/pages?space=BETA2'))).status).toBe(200);
      expect((await pagesRoute.GET(bearer(token, '/api/v1/pages?space=ALPHA'))).status).toBe(404);
    });

    it('leaves a token unrestricted when all spaces are chosen, or the field is absent', async () => {
      const name = `all-${randomUUID().slice(0, 6)}`;
      await tokenActions.createAgentTokenAction(
        {},
        form([
          ['name', name],
          ['expiresInDays', '7'],
          ['scopes', 'pages:read'],
        ]),
      );
      const { and, eq } = await import('drizzle-orm');
      const [row] = await db
        .select()
        .from(schema.agentTokens)
        .where(and(eq(schema.agentTokens.workspaceId, workspaceId), eq(schema.agentTokens.name, name)));
      expect(row?.spaceIds).toBeNull();
    });

    it('refuses a restriction with no spaces, or with a space from another workspace', async () => {
      const { eq } = await import('drizzle-orm');
      const [foreign] = await db
        .select({ id: schema.spaces.id })
        .from(schema.spaces)
        .where(eq(schema.spaces.workspaceId, otherWorkspaceId));

      for (const extra of [[] as Array<[string, string]>, [['spaceIds', foreign!.id]] as Array<[string, string]>]) {
        const result = await tokenActions.createAgentTokenAction(
          {},
          form([['name', 'refused'], ['expiresInDays', '7'], ['scopes', 'pages:read'], ['spaceAccess', 'selected'], ...extra]),
        );
        expect(result.error).toBe('spaces');
        expect(result.issuedToken).toBeUndefined();
      }
    });
  });

  /* ---------------------------------------------------------------- */

  describe('links from before spaces', () => {
    it('sends /pages/{id} and /pages/{id}/edit to the page under its space', async () => {
      const page = await createPage(everywhere, { space: 'BETA2', title: 'Old link', path: '/old-link' });
      const id = page.body.page_id as string;

      const { legacyPageLocation } = await import('@/lib/spaces/legacy');
      expect(await legacyPageLocation(workspaceId, id)).toBe(`/spaces/BETA2/pages/${id}`);
      expect(await legacyPageLocation(workspaceId, id, 'edit')).toBe(`/spaces/BETA2/pages/${id}/edit`);
      expect(await legacyPageLocation(workspaceId, id, 'new-child')).toBe(`/spaces/BETA2/pages/new?parent=${id}`);
      expect(await legacyPageLocation(otherWorkspaceId, id)).toBeNull();
      expect(await legacyPageLocation(workspaceId, 'not-a-uuid')).toBeNull();

      const view = await import('@/app/pages/[id]/page');
      const edit = await import('@/app/pages/[id]/edit/page');
      const redirected = async (run: () => Promise<unknown>) => {
        try {
          await run();
        } catch (error) {
          return String((error as { digest?: string }).digest ?? '');
        }
        return 'no redirect';
      };
      expect(await redirected(() => view.default({ params: Promise.resolve({ id }) }))).toContain(
        `/spaces/BETA2/pages/${id}`,
      );
      expect(await redirected(() => edit.default({ params: Promise.resolve({ id }) }))).toContain(
        `/spaces/BETA2/pages/${id}/edit`,
      );
      // A page that does not exist is still a 404, not a redirect.
      const missing = await redirected(() => view.default({ params: Promise.resolve({ id: randomUUID() }) }));
      expect(missing).not.toContain('/spaces/');
      expect(missing).toContain('404');
    });
  });
});
