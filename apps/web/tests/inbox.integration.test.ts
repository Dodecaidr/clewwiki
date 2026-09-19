import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as InboxRoute from '@/app/api/v1/inbox/route';
import type * as InboxReadRoute from '@/app/api/v1/inbox/read/route';
import type * as InboxService from '@/lib/inbox/service';
import type * as DiscussionService from '@/lib/discussions/service';
import type * as CommentService from '@/lib/comments/service';
import type * as ReviewService from '@/lib/reviews/service';
import type * as PageService from '@/lib/pages/service';

/**
 * The inbox, against a real database. It is a query, so what is tested is who
 * the query finds things for: the people and agents who had a hand in
 * something, never the one who spoke, and nobody who can no longer see the
 * space it happened in.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping inbox suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

describe.skipIf(!probe.reachable)('inbox', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let inbox: typeof InboxService;
  let discussions: typeof DiscussionService;
  let comments: typeof CommentService;
  let reviews: typeof ReviewService;
  let pagesService: typeof PageService;
  let inboxRoute: typeof InboxRoute;
  let inboxReadRoute: typeof InboxReadRoute;

  const suiteTag = `ib-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let alice: TestAccount;
  let bob: TestAccount;
  let outsider: TestAccount;
  let agentToken = '';
  let agentId = '';
  let openSpaceId = '';
  let closedSpaceId = '';

  const asAlice = () => ({ type: 'user' as const, id: alice.userId, label: 'Alice' });
  const asBob = () => ({ type: 'user' as const, id: bob.userId, label: 'Bob' });
  const asAgent = () => ({ type: 'agent' as const, id: agentId, label: 'backend-agent' });

  const inboxOf = (actor: { type: 'user' | 'agent'; id: string }, spaceIds: string[] | null = null) =>
    inbox.getInbox({ workspaceId, actor: { type: actor.type, id: actor.id }, spaceIds });

  async function json(response: Response): Promise<{ status: number; body: JsonRecord }> {
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as JsonRecord) };
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();
    inbox = await import('@/lib/inbox/service');
    discussions = await import('@/lib/discussions/service');
    comments = await import('@/lib/comments/service');
    reviews = await import('@/lib/reviews/service');
    pagesService = await import('@/lib/pages/service');
    inboxRoute = await import('@/app/api/v1/inbox/route');
    inboxReadRoute = await import('@/app/api/v1/inbox/read/route');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Inbox ${suiteTag}`, slug: `inbox-${suiteTag}` })
      .returning();
    workspaceId = workspace?.id ?? '';
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `inbox-other-${suiteTag}` })
      .returning();
    otherWorkspaceId = other?.id ?? '';

    alice = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    bob = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    outsider = await createTestAccount({ db, schema, workspaceId: otherWorkspaceId, role: 'admin', tag: `${suiteTag}-o` });

    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    const [token] = await db
      .insert(schema.agentTokens)
      .values({
        workspaceId,
        name: 'backend-agent',
        prefix: generated.prefix,
        tokenHash: generated.tokenHash,
        scopes: ['pages:read'],
        spaceIds: null,
      })
      .returning({ id: schema.agentTokens.id });
    agentToken = generated.token;
    agentId = token?.id ?? '';

    const key = suiteTag.slice(3, 7).toUpperCase();
    const [open] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: `IO${key}`, name: 'Open' })
      .returning({ id: schema.spaces.id });
    const [closed] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: `IC${key}`, name: 'Closed', restricted: true })
      .returning({ id: schema.spaces.id });
    openSpaceId = open?.id ?? '';
    closedSpaceId = closed?.id ?? '';
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, id));
    }
    const userIds = [alice?.userId, bob?.userId, outsider?.userId].filter(
      (value): value is string => typeof value === 'string',
    );
    if (userIds.length > 0) await db.delete(schema.users).where(drizzle.inArray(schema.users.id, userIds));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  let discussionId = '';

  it('tells the one who asked that somebody answered, and not the one who answered', async () => {
    const opened = await discussions.openDiscussion({
      workspaceId,
      spaceId: openSpaceId,
      actor: asAgent(),
      title: 'Can I change the auth contract?',
      body: 'Does anything of yours depend on the session cookie name?',
    });
    discussionId = opened.discussion.id;
    expect((await inboxOf(asAgent())).items).toEqual([]);

    await discussions.postDiscussionMessage({
      workspaceId,
      discussionId,
      actor: asAlice(),
      body: 'Yes — the gateway   reads it.\n\nRename it there first.',
    });

    const agentInbox = await inboxOf(asAgent());
    expect(agentInbox.unread).toBe(1);
    expect(agentInbox.items[0]).toMatchObject({
      kind: 'discussion.message',
      unread: true,
      by: { type: 'user', label: 'Alice' },
      title: 'Can I change the auth contract?',
      excerpt: 'Yes — the gateway reads it. Rename it there first.',
      discussionId,
    });
    expect((await inboxOf(asAlice())).items).toEqual([]);
    // Bob was never in the thread.
    expect((await inboxOf(asBob())).items).toEqual([]);
  });

  it('tells everyone who spoke, once they have spoken', async () => {
    await discussions.postDiscussionMessage({ workspaceId, discussionId, actor: asAgent(), body: 'Will do.' });
    const aliceInbox = await inboxOf(asAlice());
    expect(aliceInbox.items.map((item) => [item.kind, item.by?.label, item.excerpt])).toEqual([
      ['discussion.message', 'backend-agent', 'Will do.'],
    ]);
    // The agent's first message came before Alice joined, and is not news to her.
  });

  it('moves the mark forward only, and leaves what came after it unread', async () => {
    const before = await inboxOf(asAgent());
    const handled = before.items[0]?.at ?? new Date();

    await discussions.postDiscussionMessage({ workspaceId, discussionId, actor: asBob(), body: 'Same for the worker.' });
    await inbox.markInboxRead(workspaceId, { type: 'agent', id: agentId }, handled);

    const after = await inboxOf(asAgent());
    expect(after.items.map((item) => [item.by?.label, item.unread])).toEqual([
      ['Bob', true],
      ['Alice', false],
    ]);

    const moved = await inbox.markInboxRead(workspaceId, { type: 'agent', id: agentId }, new Date(0));
    expect(moved.getTime()).toBe(handled.getTime());
    const future = await inbox.markInboxRead(workspaceId, { type: 'agent', id: agentId }, new Date(Date.now() + 86_400_000));
    expect(future.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await inboxOf(asAgent())).unread).toBe(0);
  });

  it('says when a discussion was settled, to those who were in it', async () => {
    await discussions.resolveDiscussion({
      workspaceId,
      discussionId,
      actor: asAlice(),
      decision: 'Rename the cookie in the gateway first, then in the app.',
    });
    const agentInbox = await inbox.getInbox({
      workspaceId,
      actor: { type: 'agent', id: agentId },
      spaceIds: null,
      unreadOnly: true,
    });
    expect(agentInbox.items).toHaveLength(1);
    expect(agentInbox.items[0]).toMatchObject({ kind: 'discussion.resolved', decision: 'decided', discussionId });
    expect(agentInbox.items[0]?.pageId).toBeTruthy();
    expect((await inboxOf(asAlice())).items.some((item) => item.kind === 'discussion.resolved')).toBe(false);
  });

  let pageId = '';
  let threadId = '';

  it('brings a comment to whoever wrote the version it is on', async () => {
    const page = await pagesService.createPage({
      workspaceId,
      spaceId: openSpaceId,
      actor: { type: 'agent', id: agentId },
      title: 'Session handling',
      body: 'The cookie is called `sid`.\n\nIt lives for a day.',
      kind: 'human',
    });
    pageId = page.id;

    const thread = await comments.openComment({ workspaceId, pageId, actor: asBob(), body: 'A day is too long.' });
    threadId = thread.root.id;

    const found = (await inboxOf(asAgent())).items.find((item) => item.kind === 'comment.new');
    expect(found).toMatchObject({
      by: { type: 'user', label: 'Bob' },
      title: 'Session handling',
      excerpt: 'A day is too long.',
      pageId,
      threadId,
      unread: true,
    });
    expect((await inboxOf(asAlice())).items.some((item) => item.kind === 'comment.new')).toBe(false);
  });

  it('brings a reply to everyone already in the thread', async () => {
    await comments.replyToComment({ workspaceId, threadId, actor: asAgent(), body: 'Shortened to an hour.' });
    const bobInbox = await inboxOf(asBob());
    expect(bobInbox.items.find((item) => item.kind === 'comment.reply')).toMatchObject({
      by: { type: 'agent', label: 'backend-agent' },
      threadId,
      pageId,
    });
    expect((await inboxOf(asAgent())).items.some((item) => item.kind === 'comment.reply')).toBe(false);
  });

  it('tells an agent its change was reviewed, with the reviewer\'s note', async () => {
    await reviews.acceptPageChanges({
      workspaceId,
      pageId,
      reviewer: { id: alice.userId, label: 'Alice' },
      headVersion: 1,
      note: 'This belongs in the security page.',
    });
    const review = (await inboxOf(asAgent())).items.find((item) => item.kind === 'review.decided');
    expect(review).toMatchObject({
      by: { type: 'user', label: 'Alice' },
      title: 'Session handling',
      excerpt: 'This belongs in the security page.',
      pageId,
      decision: 'accepted',
    });
    expect((await inboxOf(asAlice())).items.some((item) => item.kind === 'review.decided')).toBe(false);
  });

  it('shows nothing from a space the caller cannot see', async () => {
    const opened = await discussions.openDiscussion({
      workspaceId,
      spaceId: closedSpaceId,
      actor: asBob(),
      title: 'A closed-space question',
      body: 'Asked while Bob was still a member.',
    });
    await discussions.postDiscussionMessage({
      workspaceId,
      discussionId: opened.discussion.id,
      actor: asAlice(),
      body: 'An answer Bob must not read any more.',
    });

    const everywhere = await inboxOf(asBob(), null);
    expect(everywhere.items.some((item) => item.title === 'A closed-space question')).toBe(true);
    const visible = await inboxOf(asBob(), [openSpaceId]);
    expect(visible.items.some((item) => item.title === 'A closed-space question')).toBe(false);
    expect((await inboxOf(asBob(), [])).items).toEqual([]);

    // And over REST, where Bob's session decides: he is not a member of the restricted space.
    const response = await json(
      await inboxRoute.GET(new Request(`${BASE}/api/v1/inbox`, { headers: { cookie: bob.cookie } })),
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('closed-space');
  });

  it('drops a deleted page\'s comments from the inbox', async () => {
    await pagesService.deletePage({ workspaceId, pageId, actor: { type: 'user', id: alice.userId } });
    const agentInbox = await inboxOf(asAgent());
    expect(agentInbox.items.some((item) => item.pageId === pageId && item.kind !== 'discussion.resolved')).toBe(false);
  });

  it('serves a token its own inbox and lets a read-only token keep a bookmark', async () => {
    const bearer = { Authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' };
    const listed = await json(await inboxRoute.GET(new Request(`${BASE}/api/v1/inbox?unread=false&limit=5`, { headers: bearer })));
    expect(listed.status).toBe(200);
    expect(listed.body['items'].length).toBeGreaterThan(0);
    expect(listed.body['items'][0]).toHaveProperty('url');
    expect(listed.body['items'].every((item: JsonRecord) => item['by'] === null || item['by']['label'] !== 'backend-agent')).toBe(true);

    const marked = await json(
      await inboxReadRoute.POST(new Request(`${BASE}/api/v1/inbox/read`, { method: 'POST', headers: bearer, body: '{}' })),
    );
    expect(marked.status).toBe(200);
    const after = await json(await inboxRoute.GET(new Request(`${BASE}/api/v1/inbox`, { headers: bearer })));
    expect(after.body['unread']).toBe(0);

    const bad = await inboxReadRoute.POST(
      new Request(`${BASE}/api/v1/inbox/read`, { method: 'POST', headers: bearer, body: JSON.stringify({ up_to: 'soon' }) }),
    );
    expect(bad.status).toBe(400);
  });

  it('is nobody else\'s: another workspace sees none of it, and no session sees nothing', async () => {
    const theirs = await json(
      await inboxRoute.GET(new Request(`${BASE}/api/v1/inbox?unread=false`, { headers: { cookie: outsider.cookie } })),
    );
    expect(theirs.body['items']).toEqual([]);
    const anonymous = await inboxRoute.GET(new Request(`${BASE}/api/v1/inbox`));
    expect(anonymous.status).toBe(401);
  });
});
