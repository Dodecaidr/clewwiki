import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as Live from '@/lib/presence/live';
import type * as PagesService from '@/lib/pages/service';

/**
 * Live presence: a person is on the board while their tab beats and drops off
 * two minutes after; an agent is there while its token makes requests; a page
 * in a space the viewer cannot see is never named.
 */

const probe = await prepareTestDatabase();
if (!probe.reachable) console.warn(`[integration] skipping live presence suite: ${probe.reason}`);

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

describe.skipIf(!probe.reachable)('live presence', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let live: typeof Live;
  let pagesService: typeof PagesService;
  const tag = `lp-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let person: TestAccount;
  let openPageId = '';
  let closedPageId = '';
  let openSpaceId = '';
  let tokenId = '';

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();
    live = await import('@/lib/presence/live');
    pagesService = await import('@/lib/pages/service');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Live ${tag}`, slug: `live-${tag}` })
      .returning();
    workspaceId = workspace?.id ?? '';
    person = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag });

    const key = tag.slice(3, 7).toUpperCase();
    const [open] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: `LO${key}`, name: 'Open' })
      .returning({ id: schema.spaces.id });
    const [closed] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: `LC${key}`, name: 'Closed', restricted: true })
      .returning({ id: schema.spaces.id });
    openSpaceId = open?.id ?? '';
    const actor = { type: 'user' as const, id: person.userId };
    openPageId = (
      await pagesService.createPage({ workspaceId, spaceId: openSpaceId, actor, title: 'Auth', body: 'x', kind: 'technical' })
    ).id;
    closedPageId = (
      await pagesService.createPage({ workspaceId, spaceId: closed?.id ?? '', actor, title: 'Secret', body: 'x', kind: 'human' })
    ).id;

    const [token] = await db
      .insert(schema.agentTokens)
      .values({
        workspaceId,
        name: 'backend-bot',
        prefix: `lp${randomUUID().slice(0, 8)}`,
        tokenHash: 'x',
        scopes: ['pages:read'],
        createdBy: person.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: schema.agentTokens.id });
    tokenId = token?.id ?? '';
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    if (workspaceId) await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(drizzle.eq(schema.users.id, person.userId));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('reads the page out of an agent route', () => {
    expect(live.pageIdOfRoute(`/api/v1/pages/${openPageId}/claims`)).toBe(openPageId);
    expect(live.pageIdOfRoute(`/api/v1/pages/${openPageId.toUpperCase()}`)).toBe(openPageId);
    expect(live.pageIdOfRoute('/api/v1/search')).toBeNull();
    expect(live.pageIdOfRoute(null)).toBeNull();
  });

  it('shows a person while their tab beats, and forgets them after two minutes', async () => {
    const now = new Date();
    await live.recordHeartbeat({ workspaceId, userId: person.userId, pageId: openPageId, mode: 'editing', automated: true, now });
    const seen = await live.getLivePresence({ workspaceId, spaceIds: null, now });
    expect(seen.people).toEqual([
      expect.objectContaining({ userId: person.userId, mode: 'editing', automated: true, page: expect.objectContaining({ id: openPageId, title: 'Auth' }) }),
    ]);
    const later = new Date(now.getTime() + live.PERSON_WINDOW_MS + 1000);
    expect((await live.getLivePresence({ workspaceId, spaceIds: null, now: later })).people).toEqual([]);
  });

  it('shows an agent from its requests, naming only pages the viewer can see', async () => {
    const at = (offset: number) => new Date(Date.now() - offset);
    await db.insert(schema.auditLog).values([
      { workspaceId, actorType: 'agent', actorId: tokenId, action: 'api.request', target: `/api/v1/pages/${openPageId}`, metadata: { method: 'GET' }, createdAt: at(60_000) },
      { workspaceId, actorType: 'agent', actorId: tokenId, action: 'api.request', target: `/api/v1/pages/${closedPageId}`, metadata: { method: 'PATCH' }, createdAt: at(1_000) },
      { workspaceId, actorType: 'agent', actorId: tokenId, action: 'api.request', target: '/api/v1/search', metadata: { method: 'GET' }, createdAt: at(live.AGENT_WINDOW_MS + 60_000) },
    ]);
    const everything = await live.getLivePresence({ workspaceId, spaceIds: null });
    expect(everything.agents).toEqual([
      expect.objectContaining({ tokenId, name: 'backend-bot', requests: 2, page: expect.objectContaining({ id: closedPageId }) }),
    ]);
    // The restricted space is not the viewer's: the agent is listed, the page is not.
    const limited = await live.getLivePresence({ workspaceId, spaceIds: [openSpaceId] });
    expect(limited.agents).toEqual([expect.objectContaining({ tokenId, page: null })]);
  });
});
