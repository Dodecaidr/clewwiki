import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as CommentRoute from '@/app/api/v1/comments/[commentId]/route';
import type * as RepliesRoute from '@/app/api/v1/comments/[commentId]/replies/route';
import type * as SpaceCommentsRoute from '@/app/api/v1/spaces/[key]/comments/route';
import type * as ClaimRoute from '@/app/api/v1/claims/[claimId]/route';
import type * as ClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';
import type * as CommentsRoute from '@/app/api/v1/pages/[id]/comments/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as DrizzleOrm from 'drizzle-orm';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping comments suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '10000';
// Small enough to exercise without posting twenty comments; other tests reset it.
process.env.DISCUSSION_MESSAGE_RATE_LIMIT_MAX = '6';
process.env.DISCUSSION_MESSAGE_RATE_LIMIT_WINDOW = '60';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;
type Caller = string | TestAccount;

describe.skipIf(!probe.reachable)('comments on paragraphs', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  let commentRoute: typeof CommentRoute;
  let repliesRoute: typeof RepliesRoute;
  let spaceCommentsRoute: typeof SpaceCommentsRoute;
  let commentsRoute: typeof CommentsRoute;
  let resetMessageBudget: () => void;
  let claimRoute: typeof ClaimRoute;
  let claimsRoute: typeof ClaimsRoute;
  let pageRoute: typeof PageRoute;
  let pagesRoute: typeof PagesRoute;

  const suiteTag = `cmt-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  let outsider: TestAccount;
  const userIds: string[] = [];

  /** `CMA` is the main space, `CMB` the one a restricted token cannot see. */
  let rvaId = '';
  let writer = '';
  let secondWriter = '';
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

  /** A request from an agent token or from a signed-in person, whichever `caller` is. */
  function as(caller: Caller, target: string, init: RequestInit = {}): Request {
    const headers: Record<string, string> =
      typeof caller === 'string'
        ? { Authorization: `Bearer ${caller}` }
        : // A session mutation is only accepted as JSON from its own origin,
          // body or no body.
          { cookie: caller.cookie, origin: BASE, 'Content-Type': 'application/json' };
    if (init.body) headers['Content-Type'] = 'application/json';
    return new Request(`${BASE}${target}`, { ...init, headers });
  }

  const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });
  const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

  async function json(response: Response): Promise<{ status: number; body: JsonRecord }> {
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as JsonRecord) };
  }

  async function create(caller: Caller, space: string, title: string, body: string): Promise<JsonRecord> {
    const created = await json(
      await pagesRoute.POST(
        as(caller, '/api/v1/pages', {
          method: 'POST',
          body: JSON.stringify({ space, title, body, kind: 'technical' }),
        }),
      ),
    );
    expect(created.status).toBe(201);
    return created.body;
  }

  async function claim(caller: Caller, pageId: string): Promise<JsonRecord> {
    const claimed = await json(
      await claimsRoute.POST(
        as(caller, `/api/v1/pages/${pageId}/claims`, { method: 'POST', body: JSON.stringify({}) }),
        idParams(pageId),
      ),
    );
    expect(claimed.status, JSON.stringify(claimed.body)).toBeLessThan(300);
    return claimed.body;
  }

  async function release(caller: Caller, claimId: string): Promise<void> {
    await claimRoute.DELETE(
      as(caller, `/api/v1/claims/${claimId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ claimId }) },
    );
  }

  /** The whole write protocol: claim, write, release. Returns the page as written. */
  async function write(
    caller: Caller,
    pageId: string,
    patch: { body?: string; title?: string },
  ): Promise<JsonRecord> {
    const lease = await claim(caller, pageId);
    const written = await json(
      await pageRoute.PATCH(
        as(caller, `/api/v1/pages/${pageId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...patch,
            claim_id: lease.claim_id,
            base_content_hash: lease.base_content_hash,
          }),
        }),
        idParams(pageId),
      ),
    );
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    await release(caller, lease.claim_id as string);
    return written.body;
  }

  const commentParams = (commentId: string) => ({ params: Promise.resolve({ commentId }) });

  async function comment(caller: Caller, pageId: string, body: Record<string, unknown>) {
    return json(
      await commentsRoute.POST(
        as(caller, `/api/v1/pages/${pageId}/comments`, { method: 'POST', body: JSON.stringify(body) }),
        idParams(pageId),
      ),
    );
  }

  async function threads(caller: Caller, pageId: string, query = '') {
    return json(
      await commentsRoute.GET(as(caller, `/api/v1/pages/${pageId}/comments${query}`), idParams(pageId)),
    );
  }

  async function reply(caller: Caller, threadId: string, body: string) {
    return json(
      await repliesRoute.POST(
        as(caller, `/api/v1/comments/${threadId}/replies`, { method: 'POST', body: JSON.stringify({ body }) }),
        commentParams(threadId),
      ),
    );
  }

  async function resolve(caller: Caller, threadId: string, resolved: boolean) {
    return json(
      await commentRoute.PATCH(
        as(caller, `/api/v1/comments/${threadId}`, { method: 'PATCH', body: JSON.stringify({ resolved }) }),
        commentParams(threadId),
      ),
    );
  }

  async function remove(caller: Caller, commentId: string) {
    return json(
      await commentRoute.DELETE(
        as(caller, `/api/v1/comments/${commentId}`, { method: 'DELETE' }),
        commentParams(commentId),
      ),
    );
  }

  async function spaceThreads(caller: Caller, key: string, query = '') {
    return json(
      await spaceCommentsRoute.GET(as(caller, `/api/v1/spaces/${key}/comments${query}`), keyParams(key)),
    );
  }

  async function auditRow(target: string, action: string): Promise<JsonRecord | null> {
    const [row] = await db
      .select({ metadata: schema.auditLog.metadata, actorType: schema.auditLog.actorType })
      .from(schema.auditLog)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditLog.target, target),
          drizzle.eq(schema.auditLog.action, action),
        ),
      )
      .limit(1);
    return row ? { ...(row.metadata as JsonRecord), actor_type: row.actorType } : null;
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    commentRoute = await import('@/app/api/v1/comments/[commentId]/route');
    repliesRoute = await import('@/app/api/v1/comments/[commentId]/replies/route');
    spaceCommentsRoute = await import('@/app/api/v1/spaces/[key]/comments/route');
    commentsRoute = await import('@/app/api/v1/pages/[id]/comments/route');
    claimRoute = await import('@/app/api/v1/claims/[claimId]/route');
    claimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    ({ resetMessageBudget } = await import('@/lib/discussions/rate-limit'));
    pagesRoute = await import('@/app/api/v1/pages/route');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Reviews ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning();
    workspaceId = workspace!.id;
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Elsewhere ${suiteTag}`, slug: `${suiteTag}-other` })
      .returning();
    otherWorkspaceId = other!.id;

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    outsider = await createTestAccount({
      db,
      schema,
      workspaceId: otherWorkspaceId,
      role: 'admin',
      tag: `${suiteTag}-o`,
    });
    userIds.push(admin.userId, editor.userId, outsider.userId);

    const [rva] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: 'CMA', name: 'Alpha' })
      .returning();
    await db.insert(schema.spaces).values({ workspaceId, key: 'CMB', name: 'Beta' });
    rvaId = rva!.id;

    writer = await seedToken('docs-agent', ['pages:read', 'pages:write'], null);
    secondWriter = await seedToken('api-agent', ['pages:read', 'pages:write'], null);
    onlyA = await seedToken('only-a', ['pages:read', 'pages:write'], [rvaId]);
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

  const BODY = '# Tokens\n\nAgent tokens are hashed with MD5.\n\n1. Create a token.\n2. Put it in the environment.\n\nTokens expire after thirty days.\n';

  /* ---------------- anchoring ---------------- */

  describe('anchoring', () => {
    it('attaches to a block of the version the commenter read, and follows it', async () => {
      const created = await create(writer, 'CMA', 'Anchored by index', BODY);
      const id = created.page_id as string;

      const opened = await comment(editor, id, { body: 'MD5 is not acceptable here.', block_index: 1 });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      expect(opened.body).toMatchObject({
        status: 'open',
        written_on_version: 1,
        author: { type: 'user' },
        anchor: {
          state: 'current',
          block_index: 1,
          line_start: 3,
          line_end: 3,
          quote: 'Agent tokens are hashed with MD5.',
        },
        replies: [],
      });

      // Something is added above: the comment moves down with its paragraph.
      await write(writer, id, { body: BODY.replace('# Tokens\n', '# Tokens\n\nAn introduction.\n') });
      const moved = await threads(readOnly, id);
      expect(moved.body.current_version).toBe(2);
      expect(moved.body.threads[0].anchor).toMatchObject({ state: 'current', block_index: 2, line_start: 5 });

      // The paragraph itself is rewritten: outdated, with the excerpt kept.
      await write(writer, id, { body: BODY.replace('hashed with MD5', 'hashed with SHA-256') });
      const outdated = await threads(readOnly, id);
      expect(outdated.body.threads[0].anchor).toEqual({
        state: 'outdated',
        quote: 'Agent tokens are hashed with MD5.',
        written_on_version: 1,
      });
    });

    it('counts blocks in the version given, not in the current one', async () => {
      const created = await create(editor, 'CMA', 'Read an older version', BODY);
      const id = created.page_id as string;
      await write(writer, id, { body: `New first paragraph.\n\n${BODY}` });

      const opened = await comment(editor, id, { body: 'About the list item.', block_index: 3, version: 1 });
      expect(opened.status).toBe(201);
      expect(opened.body.anchor).toMatchObject({
        state: 'current',
        block_index: 4,
        quote: '2. Put it in the environment.',
      });

      expect((await comment(editor, id, { body: 'x', block_index: 40 })).status).toBe(400);
      expect((await comment(editor, id, { body: 'x', block_index: 0, version: 9 })).status).toBe(404);
    });

    it('finds the paragraph an agent quotes, and refuses a quote that is nowhere or everywhere', async () => {
      const created = await create(editor, 'CMA', 'Anchored by quote', BODY);
      const id = created.page_id as string;

      const opened = await comment(writer, id, { body: 'Is thirty days still right?', quote: 'expire after thirty' });
      expect(opened.status).toBe(201);
      expect(opened.body).toMatchObject({
        author: { type: 'agent', label: 'docs-agent' },
        anchor: { state: 'current', quote: 'Tokens expire after thirty days.' },
      });

      const nowhere = await comment(writer, id, { body: 'x', quote: 'rotated monthly' });
      expect(nowhere.status).toBe(400);
      expect(nowhere.body.error.details.reason).toBe('quote_not_found');
      const everywhere = await comment(writer, id, { body: 'x', quote: 'oken' });
      expect(everywhere.status).toBe(400);
      expect(everywhere.body.error.details).toMatchObject({ reason: 'quote_ambiguous' });
      expect((await comment(writer, id, { body: 'x', quote: 'MD5', block_index: 1 })).status).toBe(400);
    });

    it('takes a comment about the page as a whole', async () => {
      const created = await create(editor, 'CMA', 'Whole page', BODY);
      const opened = await comment(editor, created.page_id as string, { body: 'Needs a diagram.' });
      expect(opened.status).toBe(201);
      expect(opened.body.anchor).toEqual({ state: 'page' });
    });
  });

  /* ---------------- threads ---------------- */

  describe('threads', () => {
    it('carry a reviewer’s remark, the agent’s answer and the reviewer’s resolution', async () => {
      const created = await create(editor, 'CMA', 'The whole arc', BODY);
      const id = created.page_id as string;
      const opened = await comment(editor, id, { body: 'Use SHA-256.', block_index: 1 });
      const threadId = opened.body.thread_id as string;

      // This is what an agent reads before it starts work in the space.
      const waiting = await spaceThreads(writer, 'CMA');
      const entry = waiting.body.threads.find((t: JsonRecord) => t.thread_id === threadId);
      expect(entry).toMatchObject({
        status: 'open',
        body: 'Use SHA-256.',
        page: { page_id: id, title: 'The whole arc' },
        anchor: { state: 'current', line_start: 3 },
      });

      const answered = await reply(writer, threadId, 'Changed in version 2.');
      expect(answered.status).toBe(201);
      expect(answered.body).toMatchObject({ thread_id: threadId, author: { label: 'docs-agent' } });

      // A reply's id is not a thread.
      const nested = await reply(writer, answered.body.comment_id as string, 'again');
      expect(nested.status).toBe(400);
      expect(nested.body.error.details.thread_id).toBe(threadId);

      const done = await resolve(editor, threadId, true);
      expect(done.status).toBe(200);
      expect(done.body.status).toBe('resolved');
      expect((await resolve(admin, threadId, true)).body.status).toBe('resolved');

      expect((await threads(readOnly, id)).body.threads).toEqual([]);
      const kept = await threads(readOnly, id, '?status=resolved');
      expect(kept.body.threads[0]).toMatchObject({
        status: 'resolved',
        resolved_by: { type: 'user' },
        replies: [{ body: 'Changed in version 2.' }],
      });

      const late = await reply(writer, threadId, 'one more thing');
      expect(late.status).toBe(409);
      expect((await resolve(editor, threadId, false)).body.status).toBe('open');
      expect((await reply(writer, threadId, 'one more thing')).status).toBe(201);

      expect(await auditRow(threadId, 'comment.opened')).toMatchObject({ page_id: id, anchored: true });
      expect(await auditRow(threadId, 'comment.resolved')).toMatchObject({ actor_type: 'user' });
      expect(JSON.stringify(await auditRow(threadId, 'comment.opened'))).not.toContain('SHA-256');
    });

    it('do not let an agent resolve what a person asked for', async () => {
      const created = await create(editor, 'CMA', 'Who resolves', BODY);
      const id = created.page_id as string;
      const byPerson = await comment(editor, id, { body: 'Fix this.', block_index: 1 });
      const byAgent = await comment(writer, id, { body: 'Is this still true?', block_index: 4 });

      const refused = await resolve(writer, byPerson.body.thread_id as string, true);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('forbidden');
      expect((await threads(admin, id)).body.threads).toHaveLength(2);

      // An agent's own question, or another agent's, is theirs to close.
      expect((await resolve(secondWriter, byAgent.body.thread_id as string, true)).status).toBe(200);
      expect((await resolve(editor, byPerson.body.thread_id as string, true)).status).toBe(200);
    });

    it('are deleted by their author or an administrator, replies included', async () => {
      const created = await create(editor, 'CMA', 'Deleting', BODY);
      const id = created.page_id as string;
      const opened = await comment(writer, id, { body: 'Mine.', block_index: 0 });
      const threadId = opened.body.thread_id as string;
      const answer = await reply(editor, threadId, 'An answer.');

      expect((await remove(secondWriter, threadId)).status).toBe(403);
      expect((await remove(editor, threadId)).status).toBe(403);
      expect((await remove(editor, answer.body.comment_id as string)).body.deleted).toBe(1);

      await reply(editor, threadId, 'Another answer.');
      const gone = await remove(admin, threadId);
      expect(gone.status).toBe(200);
      expect(gone.body.deleted).toBe(2);
      expect((await threads(admin, id, '?status=all')).body.threads).toEqual([]);
    });
  });

  /* ---------------- limits and scoping ---------------- */

  describe('limits and scoping', () => {
    it('validates bodies and needs pages:write', async () => {
      const created = await create(editor, 'CMA', 'Validation', BODY);
      const id = created.page_id as string;
      expect((await comment(editor, id, { body: '   ' })).status).toBe(400);
      expect((await comment(editor, id, { body: 'я'.repeat(4_097) })).status).toBe(400);
      expect((await comment(editor, id, { body: 'ok', extra: 1 })).status).toBe(400);
      expect((await comment(readOnly, id, { body: 'ok' })).status).toBe(403);
      expect((await threads(readOnly, id, '?status=closed')).status).toBe(400);
    });

    it('spends the same per-actor budget as discussion messages', async () => {
      const created = await create(editor, 'CMA', 'Flooded', BODY);
      const id = created.page_id as string;
      const statuses: number[] = [];
      for (let index = 0; index < 8; index += 1) {
        statuses.push((await comment(writer, id, { body: `remark ${index}` })).status);
      }
      expect(statuses.filter((status) => status === 201)).toHaveLength(6);
      expect(statuses.filter((status) => status === 429)).toHaveLength(2);
      // Somebody else's budget is their own.
      expect((await comment(secondWriter, id, { body: 'still fine' })).status).toBe(201);
    });

    it('hides another workspace’s comments, and another space’s from a restricted token', async () => {
      const created = await create(editor, 'CMB', 'Elsewhere', BODY);
      const id = created.page_id as string;
      const opened = await comment(editor, id, { body: 'Private.', block_index: 1 });
      const threadId = opened.body.thread_id as string;

      for (const caller of [outsider, onlyA] as Caller[]) {
        expect((await threads(caller, id)).status).toBe(404);
        expect((await comment(caller, id, { body: 'x' })).status).toBe(404);
        expect((await reply(caller, threadId, 'x')).status).toBe(404);
        expect((await resolve(caller, threadId, true)).status).toBe(404);
        expect((await remove(caller, threadId)).status).toBe(404);
        expect((await spaceThreads(caller, 'CMB')).status).toBe(404);
      }
      expect((await spaceThreads(onlyA, 'CMA')).status).toBe(200);
      const inA = await spaceThreads(admin, 'CMA', '?status=all&limit=200');
      expect(inA.body.threads.map((t: JsonRecord) => t.thread_id)).not.toContain(threadId);
      expect((await threads(admin, id)).body.threads).toHaveLength(1);
    });

    it('go with the page', async () => {
      const created = await create(editor, 'CMA', 'Short-lived', BODY);
      const id = created.page_id as string;
      const opened = await comment(editor, id, { body: 'Soon gone.' });
      await db.delete(schema.pages).where(drizzle.eq(schema.pages.id, id));
      const [row] = await db
        .select({ id: schema.pageComments.id })
        .from(schema.pageComments)
        .where(drizzle.eq(schema.pageComments.id, opened.body.thread_id as string));
      expect(row).toBeUndefined();
    });
  });
});
