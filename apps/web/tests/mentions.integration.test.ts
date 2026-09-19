import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as InboxRoute from '@/app/api/v1/inbox/route';
import type * as MessagesRoute from '@/app/api/v1/discussions/[id]/messages/route';
import type * as InboxService from '@/lib/inbox/service';
import type * as DiscussionService from '@/lib/discussions/service';
import type * as CommentService from '@/lib/comments/service';
import type * as PageService from '@/lib/pages/service';

/**
 * Mentions, against a real database: a name in a message or a comment reaches
 * the inbox of whoever it names — once, only them, only while they can see the
 * thing, and only for as long as the thing exists.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping mentions suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

describe.skipIf(!probe.reachable)('mentions', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let inbox: typeof InboxService;
  let discussions: typeof DiscussionService;
  let comments: typeof CommentService;
  let pagesService: typeof PageService;
  let inboxRoute: typeof InboxRoute;
  let messagesRoute: typeof MessagesRoute;

  const suiteTag = `mn-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let alice: TestAccount;
  let bob: TestAccount;
  let outsider: TestAccount;
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
    pagesService = await import('@/lib/pages/service');
    inboxRoute = await import('@/app/api/v1/inbox/route');
    messagesRoute = await import('@/app/api/v1/discussions/[id]/messages/route');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Mentions ${suiteTag}`, slug: `mentions-${suiteTag}` })
      .returning();
    workspaceId = workspace?.id ?? '';
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `mentions-other-${suiteTag}` })
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
    agentId = token?.id ?? '';

    const key = suiteTag.slice(3, 7).toUpperCase();
    const [open] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: `MO${key}`, name: 'Open' })
      .returning({ id: schema.spaces.id });
    const [closed] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: `MC${key}`, name: 'Closed', restricted: true })
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

  // createTestAccount names an account `${role} ${tag}`.
  const bobName = () => `editor ${suiteTag}`;
  const mentionsOf = async (actor: { type: 'user' | 'agent'; id: string }, spaceIds: string[] | null = null) =>
    (await inboxOf(actor, spaceIds)).items.filter((item) => item.kind === 'mention');

  let discussionId = '';

  it('brings in somebody who was never in the thread, and says who it reached', async () => {
    const opened = await discussions.openDiscussion({
      workspaceId,
      spaceId: openSpaceId,
      actor: asAlice(),
      title: 'Who owns the gateway config?',
      body: `@backend-agent does the gateway read this? cc @[${bobName()}] and @nobody-by-that-name`,
    });
    discussionId = opened.discussion.id;
    expect(opened.message.mentioned?.map((actor) => [actor.type, actor.label]).sort()).toEqual(
      [
        ['agent', 'backend-agent'],
        ['user', bobName()],
      ].sort(),
    );

    const agentMentions = await mentionsOf(asAgent());
    expect(agentMentions).toHaveLength(1);
    expect(agentMentions[0]).toMatchObject({
      by: { type: 'user', label: 'Alice' },
      title: 'Who owns the gateway config?',
      discussionId,
      unread: true,
    });
    expect(await mentionsOf(asBob())).toHaveLength(1);
    expect(await mentionsOf(asAlice())).toEqual([]);
  });

  it('is one item, not two, for somebody already in the thread', async () => {
    await discussions.postDiscussionMessage({ workspaceId, discussionId, actor: asAgent(), body: 'It does.' });
    await discussions.postDiscussionMessage({
      workspaceId,
      discussionId,
      actor: asAlice(),
      body: 'Thanks @BACKEND-AGENT — then please document it.',
    });
    const items = (await inboxOf(asAgent())).items.filter((item) => item.discussionId === discussionId);
    expect(items.map((item) => item.kind)).toEqual(['mention', 'mention']);
  });

  it('tells nobody that they mentioned themselves', async () => {
    const posted = await discussions.postDiscussionMessage({
      workspaceId,
      discussionId,
      actor: asAgent(),
      body: 'Noting for @backend-agent (me): done in version 4.',
    });
    expect(posted.message.mentioned).toEqual([]);
  });

  it('ignores a name inside code', async () => {
    const posted = await discussions.postDiscussionMessage({
      workspaceId,
      discussionId,
      actor: asAlice(),
      body: 'The annotation is `@backend-agent` in the config, nothing to do with the agent.',
    });
    expect(posted.message.mentioned).toEqual([]);
  });

  it('works in comments and lands on the thread', async () => {
    const page = await pagesService.createPage({
      workspaceId,
      spaceId: openSpaceId,
      actor: { type: 'user', id: alice.userId },
      title: 'Gateway config',
      body: 'The gateway reads `SESSION_COOKIE`.',
      kind: 'human',
    });
    const thread = await comments.openComment({
      workspaceId,
      pageId: page.id,
      actor: asAlice(),
      body: `@[${bobName()}] is this still true?`,
    });
    expect(thread.root.mentioned?.map((actor) => actor.label)).toEqual([bobName()]);
    const reply = await comments.replyToComment({
      workspaceId,
      threadId: thread.root.id,
      actor: asBob(),
      body: 'Asking @backend-agent.',
    });
    expect(reply.mentioned?.map((actor) => actor.label)).toEqual(['backend-agent']);

    const forBob = (await mentionsOf(asBob())).find((item) => item.pageId === page.id);
    expect(forBob).toMatchObject({ title: 'Gateway config', threadId: thread.root.id });
    const forAgent = (await mentionsOf(asAgent())).find((item) => item.pageId === page.id);
    expect(forAgent).toMatchObject({ threadId: thread.root.id, by: { type: 'user', label: 'Bob' } });

    const { toInboxItemResource } = await import('@/lib/inbox/serialize');
    expect(toInboxItemResource(forAgent!)['url']).toMatch(new RegExp(`#thread-${thread.root.id}$`));

    // A deleted page takes the mention out with it.
    await pagesService.deletePage({ workspaceId, pageId: page.id, actor: { type: 'user', id: alice.userId } });
    expect((await mentionsOf(asAgent())).some((item) => item.pageId === page.id)).toBe(false);
  });

  it('does not reach somebody who cannot see the space', async () => {
    const opened = await discussions.openDiscussion({
      workspaceId,
      spaceId: closedSpaceId,
      actor: asAlice(),
      title: 'A closed-space mention',
      body: `@[${bobName()}] you should not be able to read this.`,
    });
    // Stored — who a name meant is decided when it is written…
    expect(opened.message.mentioned?.map((actor) => actor.label)).toEqual([bobName()]);
    // …and shown only under the reader's visibility.
    expect((await mentionsOf(asBob(), [openSpaceId])).some((item) => item.title === 'A closed-space mention')).toBe(false);
    const overRest = await json(
      await inboxRoute.GET(new Request(`${BASE}/api/v1/inbox?unread=false`, { headers: { cookie: bob.cookie } })),
    );
    expect(JSON.stringify(overRest.body)).not.toContain('closed-space');
  });

  it('never resolves a name from another workspace, or a revoked token', async () => {
    const posted = await discussions.postDiscussionMessage({
      workspaceId,
      discussionId,
      actor: asAlice(),
      body: `@[admin ${suiteTag}-o] are you there?`,
    });
    expect(posted.message.mentioned).toEqual([]);

    await db
      .update(schema.agentTokens)
      .set({ revokedAt: new Date() })
      .where(drizzle.eq(schema.agentTokens.id, agentId));
    const afterRevoke = await discussions.postDiscussionMessage({
      workspaceId,
      discussionId,
      actor: asAlice(),
      body: '@backend-agent once more',
    });
    expect(afterRevoke.message.mentioned).toEqual([]);
    await db.update(schema.agentTokens).set({ revokedAt: null }).where(drizzle.eq(schema.agentTokens.id, agentId));
  });

  it('goes when the discussion goes', async () => {
    await discussions.deleteDiscussion({
      workspaceId,
      discussionId,
      actor: { type: 'user', id: alice.userId, label: 'Alice' },
      isAdmin: true,
    });
    expect((await mentionsOf(asAgent())).some((item) => item.discussionId === discussionId)).toBe(false);
    const left = await db
      .select({ id: schema.mentions.id })
      .from(schema.mentions)
      .innerJoin(schema.discussionMessages, drizzle.eq(schema.discussionMessages.id, schema.mentions.messageId))
      .where(drizzle.eq(schema.discussionMessages.discussionId, discussionId));
    expect(left).toEqual([]);
  });

  it('says who was reached over REST, so an agent knows a name missed', async () => {
    const opened = await discussions.openDiscussion({
      workspaceId,
      spaceId: openSpaceId,
      actor: asAlice(),
      title: 'REST mention',
      body: 'Opening.',
    });
    const response = await json(
      await messagesRoute.POST(
        new Request(`${BASE}/api/v1/discussions/${opened.discussion.id}/messages`, {
          method: 'POST',
          headers: { cookie: bob.cookie, origin: BASE, 'content-type': 'application/json' },
          body: JSON.stringify({ body: '@backend-agent and @ghost' }),
        }),
        { params: Promise.resolve({ id: opened.discussion.id }) },
      ),
    );
    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).toContain('"mentioned":[{"type":"agent","label":"backend-agent"}]');
  });
});
