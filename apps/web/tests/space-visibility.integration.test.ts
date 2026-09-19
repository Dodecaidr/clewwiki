import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';
import type * as DrizzleOrm from 'drizzle-orm';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping space visibility suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '10000';
process.env.DISCUSSION_MESSAGE_RATE_LIMIT_MAX = '10000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;
type Caller = string | TestAccount;
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

describe.skipIf(!probe.reachable)('restricted spaces', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  const suiteTag = `vis-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let admin: TestAccount;
  let member: TestAccount;
  let stranger: TestAccount;
  let foreigner: TestAccount;
  const userIds: string[] = [];

  /** `OPEN` is visible to the whole workspace; `SECRET` is restricted to its members. */
  let secretId = '';
  let unlimitedToken = '';
  let openOnlyToken = '';

  /** A page in each space, and what hangs off the one in `SECRET`. */
  let openPage = '';
  let secretPage = '';
  let secretThread = '';
  let secretDiscussion = '';

  function as(caller: Caller, target: string, init: RequestInit = {}): Request {
    const headers: Record<string, string> =
      typeof caller === 'string'
        ? { Authorization: `Bearer ${caller}` }
        : { cookie: caller.cookie, origin: BASE, 'Content-Type': 'application/json' };
    if (init.body) headers['Content-Type'] = 'application/json';
    return new Request(`${BASE}${target}`, { ...init, headers });
  }

  /** Calls a route module's handler the way the server would, and reads the answer. */
  async function call(
    module: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    caller: Caller,
    target: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<{ status: number; body: JsonRecord }> {
    const route = (await import(/* @vite-ignore */ `@/app/api/v1/${module}/route`)) as Record<string, Handler>;
    const handler = route[method];
    if (!handler) throw new Error(`${module} has no ${method}`);
    const response = await handler(
      as(caller, target, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      { params: Promise.resolve(params) },
    );
    const text = await response.text();
    let parsed: JsonRecord = {};
    try {
      parsed = text === '' ? {} : (JSON.parse(text) as JsonRecord);
    } catch {
      parsed = { raw: text.slice(0, 200) };
    }
    return { status: response.status, body: parsed };
  }

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

  async function restrict(restricted: boolean) {
    return call('spaces/[key]', 'PATCH', admin, '/api/v1/spaces/SECRET', { key: 'SECRET' }, { restricted });
  }

  async function setMembers(ids: string[], caller: Caller = admin) {
    return call('spaces/[key]/members', 'PUT', caller, '/api/v1/spaces/SECRET/members', { key: 'SECRET' }, { user_ids: ids });
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Visibility ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning();
    workspaceId = workspace!.id;
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Elsewhere ${suiteTag}`, slug: `${suiteTag}-other` })
      .returning();
    otherWorkspaceId = other!.id;

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: `${suiteTag}-a` });
    member = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: `${suiteTag}-m` });
    stranger = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: `${suiteTag}-s` });
    foreigner = await createTestAccount({ db, schema, workspaceId: otherWorkspaceId, role: 'admin', tag: `${suiteTag}-f` });
    userIds.push(admin.userId, member.userId, stranger.userId, foreigner.userId);

    const [open] = await db.insert(schema.spaces).values({ workspaceId, key: 'OPEN', name: 'Open' }).returning();
    const [secret] = await db.insert(schema.spaces).values({ workspaceId, key: 'SECRET', name: 'Secret' }).returning();
    secretId = secret!.id;

    unlimitedToken = await seedToken('everywhere', ['pages:read', 'pages:write'], null);
    openOnlyToken = await seedToken('open-only', ['pages:read', 'pages:write'], [open!.id]);

    // Everything is created while the space is still open, by somebody who will
    // not be a member: what is hidden later is content they wrote themselves.
    const made = await call('pages', 'POST', stranger, '/api/v1/pages', {}, { space: 'OPEN', title: 'Public page', body: 'open\n' });
    openPage = made.body.page_id as string;
    const hidden = await call('pages', 'POST', stranger, '/api/v1/pages', {}, {
      space: 'SECRET',
      title: 'Salary bands',
      body: 'A sentence about salaries.\n',
    });
    secretPage = hidden.body.page_id as string;
    const thread = await call('pages/[id]/comments', 'POST', stranger, `/api/v1/pages/${secretPage}/comments`, { id: secretPage }, { body: 'a remark' });
    secretThread = thread.body.thread_id as string;
    const discussion = await call('spaces/[key]/discussions', 'POST', stranger, '/api/v1/spaces/SECRET/discussions', { key: 'SECRET' }, {
      title: 'A question',
      body: 'first message',
    });
    secretDiscussion = discussion.body.discussion_id as string;
    expect([made.status, hidden.status, thread.status, discussion.status]).toEqual([201, 201, 201, 201]);

    await setMembers([member.userId]);
    expect((await restrict(true)).status).toBe(200);
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    const { eq, inArray } = drizzle;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  });

  /** Every way over REST to reach something in the restricted space. */
  function everyDoor(caller: Caller) {
    const p = { id: secretPage };
    const k = { key: 'SECRET' };
    return [
      ['space', call('spaces/[key]', 'GET', caller, '/api/v1/spaces/SECRET', k)],
      ['space export', call('spaces/[key]/export', 'GET', caller, '/api/v1/spaces/SECRET/export?format=md', k)],
      ['space rules', call('spaces/[key]/rules', 'GET', caller, '/api/v1/spaces/SECRET/rules', k)],
      ['space skills', call('spaces/[key]/skills', 'GET', caller, '/api/v1/spaces/SECRET/skills', k)],
      ['space discussions', call('spaces/[key]/discussions', 'GET', caller, '/api/v1/spaces/SECRET/discussions', k)],
      ['space comments', call('spaces/[key]/comments', 'GET', caller, '/api/v1/spaces/SECRET/comments', k)],
      ['space changes', call('spaces/[key]/changes', 'GET', caller, '/api/v1/spaces/SECRET/changes', k)],
      ['space reviews', call('spaces/[key]/reviews', 'GET', caller, '/api/v1/spaces/SECRET/reviews', k)],
      ['page tree of the space', call('pages', 'GET', caller, '/api/v1/pages?space=SECRET')],
      ['create a page in it', call('pages', 'POST', caller, '/api/v1/pages', {}, { space: 'SECRET', title: 'x' })],
      ['page', call('pages/[id]', 'GET', caller, `/api/v1/pages/${secretPage}`, p)],
      ['page subtree', call('pages/[id]/tree', 'GET', caller, `/api/v1/pages/${secretPage}/tree`, p)],
      ['page versions', call('pages/[id]/versions', 'GET', caller, `/api/v1/pages/${secretPage}/versions`, p)],
      ['one version', call('pages/[id]/versions/[version]', 'GET', caller, `/api/v1/pages/${secretPage}/versions/1`, { ...p, version: '1' })],
      ['page diff', call('pages/[id]/diff', 'GET', caller, `/api/v1/pages/${secretPage}/diff?from=0`, p)],
      ['page review', call('pages/[id]/review', 'GET', caller, `/api/v1/pages/${secretPage}/review`, p)],
      ['page comments', call('pages/[id]/comments', 'GET', caller, `/api/v1/pages/${secretPage}/comments`, p)],
      ['comment on it', call('pages/[id]/comments', 'POST', caller, `/api/v1/pages/${secretPage}/comments`, p, { body: 'x' })],
      ['reply in its thread', call('comments/[commentId]/replies', 'POST', caller, `/api/v1/comments/${secretThread}/replies`, { commentId: secretThread }, { body: 'x' })],
      ['resolve its thread', call('comments/[commentId]', 'PATCH', caller, `/api/v1/comments/${secretThread}`, { commentId: secretThread }, { resolved: true })],
      ['page claims', call('pages/[id]/claims', 'GET', caller, `/api/v1/pages/${secretPage}/claims`, p)],
      ['claim it', call('pages/[id]/claims', 'POST', caller, `/api/v1/pages/${secretPage}/claims`, p, {})],
      ['page notes', call('pages/[id]/notes', 'GET', caller, `/api/v1/pages/${secretPage}/notes`, p)],
      ['page anchors', call('pages/[id]/anchors', 'GET', caller, `/api/v1/pages/${secretPage}/anchors`, p)],
      ['page export', call('export/[id]', 'GET', caller, `/api/v1/export/${secretPage}?format=md`, p)],
      ['discussion', call('discussions/[id]', 'GET', caller, `/api/v1/discussions/${secretDiscussion}`, { id: secretDiscussion })],
      ['post in the discussion', call('discussions/[id]/messages', 'POST', caller, `/api/v1/discussions/${secretDiscussion}/messages`, { id: secretDiscussion }, { body: 'x' })],
    ] as const;
  }

  describe('to somebody who is not a member', () => {
    it('does not exist: every way in answers 404', async () => {
      for (const [name, pending] of everyDoor(stranger)) {
        const answer = await pending;
        expect(answer.status, `${name} → ${JSON.stringify(answer.body).slice(0, 160)}`).toBe(404);
      }
    });

    it('is not joined as a live session either', async () => {
      const join = await call(
        'pages/[id]/collab',
        'GET',
        stranger,
        `/api/v1/pages/${secretPage}/collab?client=${randomUUID()}&y=7`,
        { id: secretPage },
      );
      expect(join.status).toBe(404);
    });

    it('is left out of every listing', async () => {
      const spaces = await call('spaces', 'GET', stranger, '/api/v1/spaces');
      expect(spaces.body.spaces.map((s: JsonRecord) => s.key)).toEqual(['OPEN']);

      const tree = await call('pages', 'GET', stranger, '/api/v1/pages');
      expect(JSON.stringify(tree.body)).not.toContain(secretPage);

      const found = await call('search', 'GET', stranger, '/api/v1/search?q=salaries');
      expect(found.status).toBe(200);
      expect(found.body.results ?? found.body.hits ?? []).toEqual([]);

      const me = await call('me', 'GET', stranger, '/api/v1/me');
      expect(JSON.stringify(me.body)).not.toContain('SECRET');

      const presence = await call('claims', 'GET', stranger, '/api/v1/claims');
      expect(JSON.stringify(presence.body)).not.toContain(secretPage);
    });

    it('cannot be linked to from a page they can see', async () => {
      const linked = await call('pages/[id]/link', 'POST', stranger, `/api/v1/pages/${openPage}/link`, { id: openPage }, {
        linked_page_id: secretPage,
      });
      expect([400, 404]).toContain(linked.status);
      const page = await call('pages/[id]', 'GET', stranger, `/api/v1/pages/${openPage}`, { id: openPage });
      expect(JSON.stringify(page.body)).not.toContain(secretPage);
    });

    it('still leaves them the rest of the workspace', async () => {
      const page = await call('pages/[id]', 'GET', stranger, `/api/v1/pages/${openPage}`, { id: openPage });
      expect(page.status).toBe(200);
      expect((await call('spaces/[key]', 'GET', stranger, '/api/v1/spaces/OPEN', { key: 'OPEN' })).status).toBe(200);
    });
  });

  describe('to a member, and to an administrator', () => {
    it('is a space like any other', async () => {
      for (const caller of [member, admin]) {
        const space = await call('spaces/[key]', 'GET', caller, '/api/v1/spaces/SECRET', { key: 'SECRET' });
        expect(space.status).toBe(200);
        expect(space.body.restricted).toBe(true);
        const page = await call('pages/[id]', 'GET', caller, `/api/v1/pages/${secretPage}`, { id: secretPage });
        expect(page.status).toBe(200);
        const spaces = await call('spaces', 'GET', caller, '/api/v1/spaces');
        expect(spaces.body.spaces.map((s: JsonRecord) => s.key).sort()).toEqual(['OPEN', 'SECRET']);
      }
      const found = await call('search', 'GET', member, '/api/v1/search?q=salaries');
      expect(JSON.stringify(found.body)).toContain(secretPage);
    });

    it('lets a member write there as their workspace role allows', async () => {
      const created = await call('pages', 'POST', member, '/api/v1/pages', {}, { space: 'SECRET', title: 'By a member' });
      expect(created.status).toBe(201);
    });
  });

  describe('tokens', () => {
    it('reach it when they are unlimited, and not when they are limited to other spaces', async () => {
      const page = await call('pages/[id]', 'GET', unlimitedToken, `/api/v1/pages/${secretPage}`, { id: secretPage });
      expect(page.status).toBe(200);
      const limited = await call('pages/[id]', 'GET', openOnlyToken, `/api/v1/pages/${secretPage}`, { id: secretPage });
      expect(limited.status).toBe(404);
    });
  });

  describe('membership', () => {
    it('is managed by workspace administrators who are signed in, and nobody else', async () => {
      for (const caller of [member, stranger, unlimitedToken] as Caller[]) {
        const read = await call('spaces/[key]/members', 'GET', caller, '/api/v1/spaces/SECRET/members', { key: 'SECRET' });
        expect(read.status).toBe(403);
        expect((await setMembers([], caller)).status).toBe(403);
        const opened = await call('spaces/[key]', 'PATCH', caller, '/api/v1/spaces/SECRET', { key: 'SECRET' }, { restricted: false });
        expect([403, 404]).toContain(opened.status);
      }
      const listed = await call('spaces/[key]/members', 'GET', admin, '/api/v1/spaces/SECRET/members', { key: 'SECRET' });
      expect(listed.body.members.map((m: JsonRecord) => m.user_id)).toEqual([member.userId]);
      expect((await call('spaces/[key]/members', 'GET', foreigner, '/api/v1/spaces/SECRET/members', { key: 'SECRET' })).status).toBe(404);
    });

    it('takes only people of this workspace', async () => {
      const refused = await setMembers([member.userId, foreigner.userId]);
      expect(refused.status).toBe(400);
      expect(refused.body.error.details.unknown_user_ids).toEqual([foreigner.userId]);
      const still = await call('spaces/[key]/members', 'GET', admin, '/api/v1/spaces/SECRET/members', { key: 'SECRET' });
      expect(still.body.members).toHaveLength(1);
    });

    it('takes effect at once, both ways, and is audited', async () => {
      expect((await setMembers([member.userId, stranger.userId])).status).toBe(200);
      const now = await call('pages/[id]', 'GET', stranger, `/api/v1/pages/${secretPage}`, { id: secretPage });
      expect(now.status).toBe(200);

      expect((await setMembers([member.userId])).status).toBe(200);
      const gone = await call('pages/[id]', 'GET', stranger, `/api/v1/pages/${secretPage}`, { id: secretPage });
      expect(gone.status).toBe(404);

      const rows = await db
        .select({ metadata: schema.auditLog.metadata })
        .from(schema.auditLog)
        .where(
          drizzle.and(
            drizzle.eq(schema.auditLog.target, secretId),
            drizzle.eq(schema.auditLog.action, 'space.members_changed'),
          ),
        );
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(rows.map((row) => row.metadata))).toContain(stranger.userId);
    });

    it('means nothing while the space is open, and is kept for when it is not', async () => {
      expect((await restrict(false)).status).toBe(200);
      const open = await call('pages/[id]', 'GET', stranger, `/api/v1/pages/${secretPage}`, { id: secretPage });
      expect(open.status).toBe(200);
      const spaces = await call('spaces', 'GET', stranger, '/api/v1/spaces');
      expect(spaces.body.spaces).toHaveLength(2);

      expect((await restrict(true)).status).toBe(200);
      const closed = await call('pages/[id]', 'GET', stranger, `/api/v1/pages/${secretPage}`, { id: secretPage });
      expect(closed.status).toBe(404);
      const kept = await call('spaces/[key]/members', 'GET', admin, '/api/v1/spaces/SECRET/members', { key: 'SECRET' });
      expect(kept.body.members.map((m: JsonRecord) => m.user_id)).toEqual([member.userId]);
    });
  });
});
