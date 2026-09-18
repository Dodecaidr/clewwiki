import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as DiscussionsRoute from '@/app/api/v1/spaces/[key]/discussions/route';
import type * as DiscussionRoute from '@/app/api/v1/discussions/[id]/route';
import type * as MessagesRoute from '@/app/api/v1/discussions/[id]/messages/route';
import type * as ResolveRoute from '@/app/api/v1/discussions/[id]/resolve/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as DrizzleOrm from 'drizzle-orm';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping discussions suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '10000';
// Small enough that the message limiter can be exercised in a test without
// posting twenty messages; every other test resets the buckets first.
process.env.DISCUSSION_MESSAGE_RATE_LIMIT_MAX = '5';
process.env.DISCUSSION_MESSAGE_RATE_LIMIT_WINDOW = '60';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

describe.skipIf(!probe.reachable)('discussions and decisions', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  let discussionsRoute: typeof DiscussionsRoute;
  let discussionRoute: typeof DiscussionRoute;
  let messagesRoute: typeof MessagesRoute;
  let resolveRoute: typeof ResolveRoute;
  let pageRoute: typeof PageRoute;
  let pagesRoute: typeof PagesRoute;

  let resetMessageBudget: () => void;
  let sweepDiscussions: (now?: Date) => Promise<{ closed: number; deleted: number }>;

  const suiteTag = `dis-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  const userIds: string[] = [];

  /** `DSA` is the main space, `DSB` the one a restricted token cannot see. */
  let dsaId = '';
  let dsbId = '';
  let everywhere = '';
  let secondAgent = '';
  let onlyA = '';
  let readOnly = '';

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

  async function open(
    token: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: JsonRecord }> {
    return json(
      await discussionsRoute.POST(
        bearer(token, `/api/v1/spaces/${key}/discussions`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        keyParams(key),
      ),
    );
  }

  async function post(
    token: string,
    id: string,
    body: string,
  ): Promise<{ status: number; body: JsonRecord }> {
    return json(
      await messagesRoute.POST(
        bearer(token, `/api/v1/discussions/${id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        }),
        idParams(id),
      ),
    );
  }

  async function resolve(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: JsonRecord }> {
    return json(
      await resolveRoute.POST(
        bearer(token, `/api/v1/discussions/${id}/resolve`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        idParams(id),
      ),
    );
  }

  async function auditActions(target: string): Promise<string[]> {
    const rows = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(drizzle.eq(schema.auditLog.target, target))
      .orderBy(drizzle.asc(schema.auditLog.createdAt));
    return rows.map((row) => row.action);
  }

  async function auditRow(target: string, action: string): Promise<JsonRecord | null> {
    const [row] = await db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditLog.target, target),
          drizzle.eq(schema.auditLog.action, action),
        ),
      )
      .limit(1);
    return (row?.metadata as JsonRecord | null) ?? null;
  }

  /** Pushes a discussion's deadline into the past, the way time would. */
  async function expireNow(id: string): Promise<void> {
    await db
      .update(schema.discussions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(drizzle.eq(schema.discussions.id, id));
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    discussionsRoute = await import('@/app/api/v1/spaces/[key]/discussions/route');
    discussionRoute = await import('@/app/api/v1/discussions/[id]/route');
    messagesRoute = await import('@/app/api/v1/discussions/[id]/messages/route');
    resolveRoute = await import('@/app/api/v1/discussions/[id]/resolve/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    pagesRoute = await import('@/app/api/v1/pages/route');
    ({ resetMessageBudget } = await import('@/lib/discussions/rate-limit'));
    ({ sweepDiscussions } = await import('@/lib/discussions/service'));

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Discussions ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning();
    workspaceId = workspace!.id;

    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Elsewhere ${suiteTag}`, slug: `${suiteTag}-other` })
      .returning();
    otherWorkspaceId = other!.id;

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    userIds.push(admin.userId, editor.userId);

    const [dsa] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: 'DSA', name: 'Alpha' })
      .returning();
    const [dsb] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: 'DSB', name: 'Beta' })
      .returning();
    dsaId = dsa!.id;
    dsbId = dsb!.id;

    everywhere = await seedToken('backend-agent', ['pages:read', 'pages:write'], null);
    secondAgent = await seedToken('frontend-agent', ['pages:read', 'pages:write'], null);
    onlyA = await seedToken('only-a', ['pages:read', 'pages:write'], [dsaId]);
    readOnly = await seedToken('read-only', ['pages:read'], null);
  });

  beforeEach(() => {
    if (probe.reachable) resetMessageBudget();
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    const { eq, inArray } = drizzle;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
    if (userIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
  });

  /* ---------------- the whole arc ---------------- */

  describe('open → discuss → resolve', () => {
    it('carries a question from two agents to a decision page under /decisions', async () => {
      const page = await json(
        await pagesRoute.POST(
          bearer(everywhere, '/api/v1/pages', {
            method: 'POST',
            body: JSON.stringify({ space: 'DSA', title: 'Session handling', kind: 'technical' }),
          }),
        ),
      );
      expect(page.status).toBe(201);

      const opened = await open(everywhere, 'DSA', {
        title: 'Auth contract: breaking change to /session',
        body: 'I am dropping the legacy cookie. Does anything of yours read it?',
        page_id: page.body.page_id,
      });
      expect(opened.status).toBe(201);
      expect(opened.body).toMatchObject({
        status: 'open',
        cleanup: 'closed_when_idle',
        page_id: page.body.page_id,
        opened_by: { type: 'agent', label: 'backend-agent' },
        closed_for_inactivity: false,
      });
      // The deadline is the idle window, not a nullable "maybe later".
      expect(new Date(opened.body.expires_at).getTime()).toBeGreaterThan(Date.now());
      const id = opened.body.discussion_id as string;

      // A second, different token answers: this is the whole point of the
      // feature, so the thread has to record two distinct participants.
      const replied = await post(secondAgent, id, 'The web client reads it on first load.');
      expect(replied.status).toBe(201);
      expect(replied.body.message.author.label).toBe('frontend-agent');

      const thread = await json(
        await discussionRoute.GET(bearer(readOnly, `/api/v1/discussions/${id}`), idParams(id)),
      );
      expect(thread.status).toBe(200);
      expect(thread.body.message_count).toBe(2);
      expect(thread.body.messages.map((m: JsonRecord) => m.author.label)).toEqual([
        'backend-agent',
        'frontend-agent',
      ]);
      expect(thread.body.participants.map((p: JsonRecord) => p.label).sort()).toEqual([
        'backend-agent',
        'frontend-agent',
      ]);

      const resolved = await resolve(everywhere, id, {
        decision: 'Drop the legacy cookie in 2.0 and ship a migration note.',
        context: 'The web client still reads it on first load.',
        options: 'Keep it, deprecate it for a release, drop it now.',
        consequences: 'The web client needs a release before the API ships 2.0.',
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ status: 'resolved', cleanup: 'deleted' });
      expect(resolved.body.decision_page.created).toBe(true);
      expect(resolved.body.decision_page_id).toBe(resolved.body.decision_page.page_id);

      // The decision page is under /decisions, titled from the thread, and says
      // exactly what the caller wrote — nothing was summarised for it.
      const decisionPage = await json(
        await pageRoute.GET(
          bearer(readOnly, `/api/v1/pages/${resolved.body.decision_page.page_id}`),
          idParams(resolved.body.decision_page.page_id as string),
        ),
      );
      expect(decisionPage.status).toBe(200);
      expect(decisionPage.body.path).toMatch(/^\/decisions\//);
      expect(decisionPage.body.title).toBe('Auth contract: breaking change to /session');
      expect(decisionPage.body.body).toContain('## Decision');
      expect(decisionPage.body.body).toContain('Drop the legacy cookie in 2.0');
      expect(decisionPage.body.body).toContain('## Options considered');
      expect(decisionPage.body.body).toContain('Participants: backend-agent, frontend-agent.');
      expect(decisionPage.body.body).toContain('From the discussion');
      // It links back to nothing: the thread is going to be deleted.
      expect(decisionPage.body.body).not.toContain('/discussions/');

      // The parent page exists and was recorded in the space settings, so the
      // next resolution files its page in the same place.
      const [space] = await db
        .select({ settings: schema.spaces.settings })
        .from(schema.spaces)
        .where(drizzle.eq(schema.spaces.id, dsaId));
      expect(space?.settings.decisions_page_id).toBeTruthy();
      const parent = await json(
        await pageRoute.GET(
          bearer(readOnly, `/api/v1/pages/${space!.settings.decisions_page_id}`),
          idParams(space!.settings.decisions_page_id as string),
        ),
      );
      expect(parent.body.path).toBe('/decisions');
      expect(decisionPage.body.parent_id).toBe(space!.settings.decisions_page_id);

      expect(await auditActions(id)).toEqual([
        'discussion.opened',
        'discussion.message',
        'discussion.resolved',
      ]);
      const resolvedAudit = await auditRow(id, 'discussion.resolved');
      expect(resolvedAudit).toMatchObject({
        decision_page_id: resolved.body.decision_page.page_id,
        message_count: 2,
      });
    });

    it('files a second decision under the same parent', async () => {
      const opened = await open(everywhere, 'DSA', {
        title: 'Where do runbooks live?',
        body: 'OPS or here?',
      });
      const resolved = await resolve(everywhere, opened.body.discussion_id as string, {
        decision: 'Runbooks live in the ops space.',
      });
      const [space] = await db
        .select({ settings: schema.spaces.settings })
        .from(schema.spaces)
        .where(drizzle.eq(schema.spaces.id, dsaId));
      const page = await json(
        await pageRoute.GET(
          bearer(readOnly, `/api/v1/pages/${resolved.body.decision_page.page_id}`),
          idParams(resolved.body.decision_page.page_id as string),
        ),
      );
      expect(page.body.parent_id).toBe(space!.settings.decisions_page_id);
      // Only the block the caller filled in shows up.
      expect(page.body.body).toContain('## Decision');
      expect(page.body.body).not.toContain('## Context');
    });

    it('refuses a resolution with no decision, and leaves the thread open', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Empty decision', body: 'Question.' });
      const id = opened.body.discussion_id as string;
      const refused = await resolve(everywhere, id, { decision: '   ' });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('validation');

      const still = await json(
        await discussionRoute.GET(bearer(readOnly, `/api/v1/discussions/${id}`), idParams(id)),
      );
      expect(still.body.status).toBe('open');
      expect(still.body.decision_page_id).toBeNull();
    });

    it('refuses a message on a resolved thread, naming the decision page instead', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Settled already', body: 'Question.' });
      const id = opened.body.discussion_id as string;
      const resolved = await resolve(everywhere, id, { decision: 'Yes.' });

      const refused = await post(secondAgent, id, 'One more thought.');
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('conflict');
      expect(refused.body.error.details.decision_page_id).toBe(
        resolved.body.decision_page.page_id,
      );
    });
  });

  /* ---------------- sweeps ---------------- */

  describe('lifecycle', () => {
    it('closes an idle discussion with no decision, and says so in the audit log', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Nobody answered', body: 'Anyone?' });
      const id = opened.body.discussion_id as string;
      await expireNow(id);

      const swept = await sweepDiscussions();
      expect(swept.closed).toBeGreaterThanOrEqual(1);

      const after = await json(
        await discussionRoute.GET(bearer(readOnly, `/api/v1/discussions/${id}`), idParams(id)),
      );
      expect(after.body).toMatchObject({
        status: 'resolved',
        resolved_by: 'system',
        decision_page_id: null,
        closed_for_inactivity: true,
        cleanup: 'deleted',
      });
      // The deadline moved on to the deletion date.
      expect(new Date(after.body.expires_at).getTime()).toBeGreaterThan(Date.now());
      expect(await auditActions(id)).toContain('discussion.expired');
      expect(await auditRow(id, 'discussion.expired')).toMatchObject({
        by: 'system',
        title: 'Nobody answered',
        idle_days: 14,
      });
    });

    it('deletes a resolved discussion and its messages, and keeps the decision page', async () => {
      const opened = await open(everywhere, 'DSA', {
        title: 'Retention: what survives',
        body: 'This message should not survive.',
      });
      const id = opened.body.discussion_id as string;
      await post(secondAgent, id, 'Neither should this one.');
      const resolved = await resolve(everywhere, id, {
        decision: 'The decision survives; the thread does not.',
      });
      const decisionPageId = resolved.body.decision_page.page_id as string;

      await expireNow(id);
      const swept = await sweepDiscussions();
      expect(swept.deleted).toBeGreaterThanOrEqual(1);

      const gone = await json(
        await discussionRoute.GET(bearer(readOnly, `/api/v1/discussions/${id}`), idParams(id)),
      );
      expect(gone.status).toBe(404);

      const messages = await db
        .select({ id: schema.discussionMessages.id })
        .from(schema.discussionMessages)
        .where(drizzle.eq(schema.discussionMessages.discussionId, id));
      expect(messages).toEqual([]);

      // The page is untouched, still readable and still holding the decision.
      const page = await json(
        await pageRoute.GET(
          bearer(readOnly, `/api/v1/pages/${decisionPageId}`),
          idParams(decisionPageId),
        ),
      );
      expect(page.status).toBe(200);
      expect(page.body.body).toContain('The decision survives; the thread does not.');

      // The deletion row carries what the deleted row no longer can.
      expect(await auditRow(id, 'discussion.deleted')).toMatchObject({
        by: 'system',
        title: 'Retention: what survives',
        decision_page_id: decisionPageId,
        messages_deleted: 2,
      });
    });

    it('expires lazily on access, so a listing never shows a thread that should be gone', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Lazy expiry', body: 'Question.' });
      const id = opened.body.discussion_id as string;
      await expireNow(id);

      // No sweep runs here: the listing itself applies the deadline.
      const listed = await json(
        await discussionsRoute.GET(
          bearer(readOnly, '/api/v1/spaces/DSA/discussions?status=open'),
          keyParams('DSA'),
        ),
      );
      expect(listed.status).toBe(200);
      expect(listed.body.discussions.map((d: JsonRecord) => d.discussion_id)).not.toContain(id);

      const read = await json(
        await discussionRoute.GET(bearer(readOnly, `/api/v1/discussions/${id}`), idParams(id)),
      );
      expect(read.body.status).toBe('resolved');
      expect(read.body.closed_for_inactivity).toBe(true);
    });

    it('honours a space’s own retention windows', async () => {
      await db
        .update(schema.spaces)
        .set({ settings: { discussion_idle_days: 1, discussion_retention_days: 1 } })
        .where(drizzle.eq(schema.spaces.id, dsbId));

      const opened = await open(everywhere, 'DSB', { title: 'One day', body: 'Question.' });
      const expiresAt = new Date(opened.body.expires_at).getTime();
      const openedAt = new Date(opened.body.opened_at).getTime();
      expect(Math.round((expiresAt - openedAt) / (24 * 60 * 60 * 1000))).toBe(1);

      // Put the settings back so the later space-isolation tests see defaults.
      await db
        .update(schema.spaces)
        .set({ settings: {} })
        .where(drizzle.eq(schema.spaces.id, dsbId));
    });
  });

  /* ---------------- scoping ---------------- */

  describe('scoping', () => {
    it('keeps a space’s discussions out of another space’s listing', async () => {
      const a = await open(everywhere, 'DSA', { title: 'Only in Alpha', body: 'Question.' });
      const b = await open(everywhere, 'DSB', { title: 'Only in Beta', body: 'Question.' });

      const listedA = await json(
        await discussionsRoute.GET(
          bearer(readOnly, '/api/v1/spaces/DSA/discussions'),
          keyParams('DSA'),
        ),
      );
      const ids = listedA.body.discussions.map((d: JsonRecord) => d.discussion_id);
      expect(ids).toContain(a.body.discussion_id);
      expect(ids).not.toContain(b.body.discussion_id);
    });

    it('answers 404 for a space a restricted token cannot see, not 403', async () => {
      const listed = await json(
        await discussionsRoute.GET(
          bearer(onlyA, '/api/v1/spaces/DSB/discussions'),
          keyParams('DSB'),
        ),
      );
      expect(listed.status).toBe(404);
      expect(listed.body.error.code).toBe('not_found');

      const refused = await open(onlyA, 'DSB', { title: 'Nope', body: 'Question.' });
      expect(refused.status).toBe(404);
    });

    it('hides a discussion in a space the token is not allowed into', async () => {
      const inB = await open(everywhere, 'DSB', { title: 'Beta only', body: 'Question.' });
      const id = inB.body.discussion_id as string;

      const read = await json(
        await discussionRoute.GET(bearer(onlyA, `/api/v1/discussions/${id}`), idParams(id)),
      );
      expect(read.status).toBe(404);

      const wrote = await post(onlyA, id, 'Should not reach this.');
      expect(wrote.status).toBe(404);
    });

    it('needs pages:read to list and pages:write to open or reply', async () => {
      const listed = await json(
        await discussionsRoute.GET(
          bearer(readOnly, '/api/v1/spaces/DSA/discussions'),
          keyParams('DSA'),
        ),
      );
      expect(listed.status).toBe(200);

      const refused = await open(readOnly, 'DSA', { title: 'Read only', body: 'Question.' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('insufficient_scope');

      const opened = await open(everywhere, 'DSA', { title: 'Scope check', body: 'Question.' });
      const replied = await post(readOnly, opened.body.discussion_id as string, 'Hello.');
      expect(replied.status).toBe(403);

      const resolved = await resolve(readOnly, opened.body.discussion_id as string, {
        decision: 'No.',
      });
      expect(resolved.status).toBe(403);
    });

    it('refuses a page from another space as the subject of a discussion', async () => {
      const elsewhere = await json(
        await pagesRoute.POST(
          bearer(everywhere, '/api/v1/pages', {
            method: 'POST',
            body: JSON.stringify({ space: 'DSB', title: 'Beta page', kind: 'technical' }),
          }),
        ),
      );
      const refused = await open(everywhere, 'DSA', {
        title: 'Wrong space',
        body: 'Question.',
        page_id: elsewhere.body.page_id,
      });
      expect(refused.status).toBe(404);
    });
  });

  /* ---------------- limits ---------------- */

  describe('limits', () => {
    it('refuses a message past the byte cap, counting octets', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Big message', body: 'Question.' });
      const id = opened.body.discussion_id as string;
      const refused = await post(everywhere, id, 'я'.repeat(4_097));
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('validation');
      expect(refused.body.error.details?.max_bytes ?? refused.body.error.details).toBeTruthy();
    });

    it('caps the messages in one discussion, telling the caller to resolve it', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Message cap', body: 'First.' });
      const id = opened.body.discussion_id as string;

      // Filled in directly: the cap is what is under test, not the 199 calls it
      // would otherwise take to reach it.
      await db.insert(schema.discussionMessages).values(
        Array.from({ length: 199 }, (_unused, index) => ({
          discussionId: id,
          workspaceId,
          authorType: 'agent' as const,
          authorId: 'seed',
          authorLabel: 'seed-agent',
          body: `filler ${index}`,
        })),
      );

      const refused = await post(everywhere, id, 'One too many.');
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('validation');
      expect(refused.body.error.message).toMatch(/200 messages/);
      expect(refused.body.error.details.max_messages).toBe(200);
    });

    it('caps the discussions open in one space', async () => {
      const [capped] = await db
        .insert(schema.spaces)
        .values({ workspaceId, key: 'DSC', name: 'Capped' })
        .returning();

      const now = new Date();
      await db.insert(schema.discussions).values(
        Array.from({ length: 100 }, (_unused, index) => ({
          workspaceId,
          spaceId: capped!.id,
          title: `Seeded ${index}`,
          status: 'open' as const,
          openedByType: 'agent' as const,
          openedById: 'seed',
          openedByLabel: 'seed-agent',
          lastActivityAt: now,
          expiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
        })),
      );

      const refused = await open(everywhere, 'DSC', { title: 'One too many', body: 'Question.' });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('validation');
      expect(refused.body.error.details.max_open).toBe(100);

      await db.delete(schema.spaces).where(drizzle.eq(schema.spaces.id, capped!.id));
    });

    it('rate limits message posting per actor, with a retry hint', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Rate limit', body: 'First.' });
      const id = opened.body.discussion_id as string;

      resetMessageBudget();
      const outcomes: number[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const result = await post(everywhere, id, `message ${attempt}`);
        outcomes.push(result.status);
      }
      expect(outcomes.filter((status) => status === 201).length).toBe(5);
      const limited = outcomes.filter((status) => status === 429);
      expect(limited.length).toBe(2);

      const refused = await post(everywhere, id, 'once more');
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('rate_limited');
      expect(refused.body.error.details.retry_after_seconds).toBeGreaterThan(0);

      // The bucket is per actor, so another token is unaffected.
      const other = await post(secondAgent, id, 'from another agent');
      expect(other.status).toBe(201);
    });
  });

  /* ---------------- deletion ---------------- */

  describe('deletion', () => {
    async function remove(
      request: Request,
      id: string,
    ): Promise<{ status: number; body: JsonRecord }> {
      return json(await discussionRoute.DELETE(request, idParams(id)));
    }

    it('lets the opener delete their own thread, keeping the decision page', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Mine to withdraw', body: 'Question.' });
      const id = opened.body.discussion_id as string;
      const resolved = await resolve(everywhere, id, { decision: 'Settled.' });
      const decisionPageId = resolved.body.decision_page.page_id as string;

      const deleted = await remove(
        bearer(everywhere, `/api/v1/discussions/${id}`, { method: 'DELETE' }),
        id,
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body).toMatchObject({
        deleted: true,
        title: 'Mine to withdraw',
        decision_page_id: decisionPageId,
      });

      const page = await json(
        await pageRoute.GET(
          bearer(readOnly, `/api/v1/pages/${decisionPageId}`),
          idParams(decisionPageId),
        ),
      );
      expect(page.status).toBe(200);

      expect(await auditRow(id, 'discussion.deleted')).toMatchObject({
        by: 'opener',
        title: 'Mine to withdraw',
        decision_page_id: decisionPageId,
      });
    });

    it('refuses a writer who is neither an administrator nor the opener', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Not yours', body: 'Question.' });
      const id = opened.body.discussion_id as string;

      const refused = await remove(
        bearer(secondAgent, `/api/v1/discussions/${id}`, { method: 'DELETE' }),
        id,
      );
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('forbidden');

      // An editor is a person, but still not the opener.
      const byEditor = await remove(
        cookie(editor, `/api/v1/discussions/${id}`, { method: 'DELETE' }),
        id,
      );
      expect(byEditor.status).toBe(403);
    });

    it('lets a workspace administrator delete anybody’s thread', async () => {
      const opened = await open(everywhere, 'DSA', { title: 'Admin housekeeping', body: 'Q.' });
      const id = opened.body.discussion_id as string;

      const deleted = await remove(
        cookie(admin, `/api/v1/discussions/${id}`, { method: 'DELETE' }),
        id,
      );
      expect(deleted.status).toBe(200);
      expect(await auditRow(id, 'discussion.deleted')).toMatchObject({ by: 'admin' });

      const gone = await json(
        await discussionRoute.GET(bearer(readOnly, `/api/v1/discussions/${id}`), idParams(id)),
      );
      expect(gone.status).toBe(404);
    });
  });
});
