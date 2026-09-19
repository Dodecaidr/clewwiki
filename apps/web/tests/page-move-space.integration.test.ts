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
  console.warn(`[integration] skipping page move suite: ${probe.reason}`);
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

describe.skipIf(!probe.reachable)('moving a page to another space', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  const suiteTag = `mv-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  let outsider: TestAccount;
  const userIds: string[] = [];
  const spaceIds: Record<string, string> = {};

  let moverToken = '';
  let writerToken = '';
  let srcOnlyToken = '';

  function as(caller: Caller, target: string, init: RequestInit = {}): Request {
    const headers: Record<string, string> =
      typeof caller === 'string'
        ? { Authorization: `Bearer ${caller}` }
        : { cookie: caller.cookie, origin: BASE, 'Content-Type': 'application/json' };
    if (init.body) headers['Content-Type'] = 'application/json';
    return new Request(`${BASE}${target}`, { ...init, headers });
  }

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

  async function seedToken(name: string, scopes: string[], limitedTo: string[] | null): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId,
      name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes,
      spaceIds: limitedTo,
    });
    return generated.token;
  }

  async function makeSpace(key: string): Promise<void> {
    const [row] = await db.insert(schema.spaces).values({ workspaceId, key, name: key }).returning();
    spaceIds[key] = row!.id;
  }

  async function makePage(space: string, title: string, extra: JsonRecord = {}, caller: Caller = editor): Promise<string> {
    const made = await call('pages', 'POST', caller, '/api/v1/pages', {}, { space, title, body: `${title}\n`, ...extra });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.page_id as string;
  }

  function move(caller: Caller, pageId: string, body: JsonRecord) {
    return call('pages/[id]/move', 'POST', caller, `/api/v1/pages/${pageId}/move`, { id: pageId }, body);
  }

  function getPage(caller: Caller, pageId: string) {
    return call('pages/[id]', 'GET', caller, `/api/v1/pages/${pageId}`, { id: pageId });
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Moves ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning();
    workspaceId = workspace!.id;

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: `${suiteTag}-a` });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: `${suiteTag}-e` });
    outsider = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: `${suiteTag}-o` });
    userIds.push(admin.userId, editor.userId, outsider.userId);

    for (const key of ['SRC', 'DST', 'OLD', 'VAULT']) await makeSpace(key);

    moverToken = await seedToken('mover', ['pages:read', 'pages:write', 'pages:delete'], null);
    writerToken = await seedToken('writer', ['pages:read', 'pages:write'], null);
    srcOnlyToken = await seedToken('src-only', ['pages:read', 'pages:write', 'pages:delete'], [spaceIds.SRC!]);
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    const { eq, inArray } = drizzle;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  });

  it('takes the subtree along, under a parent in the target, and changes no content', async () => {
    const root = await makePage('SRC', 'Billing');
    const child = await makePage('SRC', 'Invoices', { parent_id: root });
    const grandchild = await makePage('SRC', 'Refunds', { parent_id: child });
    const section = await makePage('DST', 'Backend');
    const before = (await getPage(editor, grandchild)).body;

    const moved = await move(editor, root, { space: 'DST', parent_id: section });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.pages_moved).toBe(3);
    expect(moved.body.previous_path).toBe('/billing');
    expect(moved.body.page.path).toBe('/backend/billing');
    expect(moved.body.page.space.key).toBe('DST');
    expect(moved.body.page.parent_id).toBe(section);
    expect(moved.body.page.body).toBeUndefined();
    expect(moved.body.unlinked_page_ids).toEqual([]);

    const after = (await getPage(editor, grandchild)).body;
    expect(after.space.key).toBe('DST');
    expect(after.path).toBe('/backend/billing/invoices/refunds');
    expect(after.parent_id).toBe(child);
    expect(after.version).toBe(before.version);
    expect(after.content_hash).toBe(before.content_hash);

    const source = await call('pages', 'GET', editor, '/api/v1/pages?space=SRC');
    expect(JSON.stringify(source.body)).not.toContain(root);

    const { and, eq } = drizzle;
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.workspaceId, workspaceId), eq(schema.auditLog.action, 'page.moved_to_space')));
    expect(audit.some((row) => row.target === root)).toBe(true);
  });

  it('goes to the top level by default, and by parent_path when asked', async () => {
    const top = await makePage('SRC', 'Glossary');
    const first = await move(moverToken, top, { space: 'DST' });
    expect(first.status).toBe(200);
    expect(first.body.page.path).toBe('/glossary');
    expect(first.body.page.parent_id).toBeNull();

    await makePage('DST', 'Runbooks');
    const second = await makePage('SRC', 'Oncall');
    const byPath = await move(moverToken, second, { space: 'DST', parent_path: 'runbooks' });
    expect(byPath.status).toBe(200);
    expect(byPath.body.page.path).toBe('/runbooks/oncall');
  });

  it('carries comments and reviews into the target space', async () => {
    const page = await makePage('SRC', 'Commented');
    const thread = await call('pages/[id]/comments', 'POST', editor, `/api/v1/pages/${page}/comments`, { id: page }, { body: 'a remark' });
    expect(thread.status).toBe(201);

    expect((await move(editor, page, { space: 'DST' })).status).toBe(200);

    const { eq } = drizzle;
    const rows = await db.select().from(schema.pageComments).where(eq(schema.pageComments.pageId, page));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.spaceId === spaceIds.DST)).toBe(true);

    const inTarget = await call('spaces/[key]/comments', 'GET', editor, '/api/v1/spaces/DST/comments', { key: 'DST' });
    expect(JSON.stringify(inTarget.body)).toContain(page);
    const inSource = await call('spaces/[key]/comments', 'GET', editor, '/api/v1/spaces/SRC/comments', { key: 'SRC' });
    expect(JSON.stringify(inSource.body)).not.toContain(page);
  });

  it('is refused for what is not a move between spaces, and for callers who may not', async () => {
    const page = await makePage('SRC', 'Stays');
    const section = await makePage('SRC', 'Section in source');

    const same = await move(editor, page, { space: 'SRC' });
    expect(same.status).toBe(400);
    const both = await move(editor, page, { space: 'DST', parent_id: section, parent_path: 'x' });
    expect(both.status).toBe(400);
    const nowhere = await move(editor, page, { space: 'NOPE' });
    expect(nowhere.status).toBe(404);
    // A parent that exists, but not in the target space.
    const wrongParent = await move(editor, page, { space: 'DST', parent_id: section });
    expect(wrongParent.status).toBe(404);
    const missing = await move(editor, randomUUID(), { space: 'DST' });
    expect(missing.status).toBe(404);

    // Leaving a space is scoped like a subtree delete.
    const noDelete = await move(writerToken, page, { space: 'DST' });
    expect(noDelete.status).toBe(403);
    // A token has to reach both spaces; the one it cannot see does not exist.
    const blind = await move(srcOnlyToken, page, { space: 'DST' });
    expect(blind.status).toBe(404);
    expect(blind.body.error?.message ?? blind.body.message).toMatch(/Space not found/);

    expect((await getPage(editor, page)).body.space.key).toBe('SRC');
  });

  it('is refused when the target already uses a path, even below a free root', async () => {
    const root = await makePage('SRC', 'Payments');
    await makePage('SRC', 'Cards', { parent_id: root });
    // Placed by path, with no page above it.
    await makePage('DST', 'Orphan', { path: 'payments/cards' });

    const refused = await move(editor, root, { space: 'DST' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.paths).toEqual(['/payments/cards']);
    expect((await getPage(editor, root)).body.space.key).toBe('SRC');
  });

  it("is refused under somebody else's claim in the subtree, and goes ahead under the mover's own", async () => {
    const root = await makePage('SRC', 'Claimed tree');
    const child = await makePage('SRC', 'Claimed child', { parent_id: root });

    const theirs = await call('pages/[id]/claims', 'POST', outsider, `/api/v1/pages/${child}/claims`, { id: child }, {});
    expect(theirs.status).toBe(201);
    const refused = await move(admin, root, { space: 'DST' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.claims[0].page_id).toBe(child);

    const released = await call('claims/[claimId]', 'DELETE', outsider, `/api/v1/claims/${theirs.body.claim_id}`, { claimId: theirs.body.claim_id });
    expect(released.status).toBeLessThan(300);

    const mine = await call('pages/[id]/claims', 'POST', editor, `/api/v1/pages/${root}/claims`, { id: root }, {});
    expect(mine.status).toBe(201);
    const moved = await move(editor, root, { space: 'DST' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    // The claim names the page, and the page kept its id: the write still goes through.
    const current = (await getPage(editor, root)).body;
    const written = await call('pages/[id]', 'PATCH', editor, `/api/v1/pages/${root}`, { id: root }, {
      body: 'written after the move\n',
      claim_id: mine.body.claim_id,
      base_content_hash: current.content_hash,
    });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
  });

  it('is refused into an archived space, and for a page the source space still uses', async () => {
    const page = await makePage('SRC', 'For the archive');
    expect((await call('spaces/[key]/archive', 'POST', admin, '/api/v1/spaces/OLD/archive', { key: 'OLD' })).status).toBeLessThan(300);
    const archived = await move(admin, page, { space: 'OLD' });
    expect(archived.status).toBe(409);

    const home = await makePage('SRC', 'Home of the source');
    const below = await makePage('SRC', 'Rules of the source', { parent_id: home });
    const set = await call('spaces/[key]', 'PATCH', admin, '/api/v1/spaces/SRC', { key: 'SRC' }, { rules_page_id: below });
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    // The designated page is below the one being moved.
    const refused = await move(admin, home, { space: 'DST' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.designated).toEqual([{ role: 'rules_page', page_id: below }]);

    await call('spaces/[key]', 'PATCH', admin, '/api/v1/spaces/SRC', { key: 'SRC' }, { rules_page_id: null });
    expect((await move(admin, home, { space: 'DST' })).status).toBe(200);
  });

  it('breaks a pair it would split, on both sides, and keeps one that moves whole', async () => {
    const technical = await makePage('SRC', 'Spec', { kind: 'technical' });
    const human = await makePage('SRC', 'Spec explained', { kind: 'human', link_to_page_id: technical });

    const split = await move(editor, technical, { space: 'DST' });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    expect([...split.body.unlinked_page_ids].sort()).toEqual([technical, human].sort());
    expect((await getPage(editor, technical)).body.linked_page ?? null).toBeNull();
    expect((await getPage(editor, human)).body.linked_page ?? null).toBeNull();

    const root = await makePage('SRC', 'Pair root');
    const a = await makePage('SRC', 'Pair tech', { parent_id: root, kind: 'technical' });
    const b = await makePage('SRC', 'Pair human', { parent_id: root, kind: 'human', link_to_page_id: a });
    const whole = await move(editor, root, { space: 'DST' });
    expect(whole.status).toBe(200);
    expect(whole.body.unlinked_page_ids).toEqual([]);
    expect((await getPage(editor, a)).body.linked_page.page_id).toBe(b);
  });

  it('refuses a subtree whose paths would pass the depth limit in the target', async () => {
    let parent: string | null = null;
    for (let level = 0; level < 11; level += 1) {
      parent = await makePage('DST', `Deep ${level}`, parent ? { parent_id: parent } : {});
    }
    const root = await makePage('SRC', 'Too deep');
    await makePage('SRC', 'Deeper still', { parent_id: root });

    const refused = await move(editor, root, { space: 'DST', parent_id: parent });
    expect(refused.status).toBe(400);
    expect((await getPage(editor, root)).body.space.key).toBe('SRC');
  });

  it('leaves a deleted child behind, and restore refuses it once its parent is elsewhere', async () => {
    const root = await makePage('SRC', 'Parent that leaves');
    const child = await makePage('SRC', 'Child deleted first', { parent_id: root });
    expect((await call('pages/[id]', 'DELETE', admin, `/api/v1/pages/${child}`, { id: child })).status).toBe(200);

    // The parent keeps the very path it had, which is what a path comparison alone would accept.
    expect((await move(admin, root, { space: 'DST' })).status).toBe(200);

    const restored = await call('pages/[id]/restore', 'POST', admin, `/api/v1/pages/${child}/restore`, { id: child });
    expect(restored.status).toBe(409);
  });

  it('hides the page, and what hangs off it, once it is in a space the viewer cannot see', async () => {
    await call('spaces/[key]/members', 'PUT', admin, '/api/v1/spaces/VAULT/members', { key: 'VAULT' }, { user_ids: [editor.userId] });
    expect((await call('spaces/[key]', 'PATCH', admin, '/api/v1/spaces/VAULT', { key: 'VAULT' }, { restricted: true })).status).toBe(200);

    const page = await makePage('SRC', 'Going private', {}, outsider);
    const thread = await call('pages/[id]/comments', 'POST', outsider, `/api/v1/pages/${page}/comments`, { id: page }, { body: 'mine' });
    const threadId = thread.body.thread_id as string;

    // Somebody who cannot see the vault cannot put anything into it, or learn that it is there.
    const blind = await move(outsider, page, { space: 'VAULT' });
    expect(blind.status).toBe(404);

    expect((await move(editor, page, { space: 'VAULT' })).status).toBe(200);

    expect((await getPage(outsider, page)).status).toBe(404);
    const reply = await call('comments/[commentId]/replies', 'POST', outsider, `/api/v1/comments/${threadId}/replies`, { commentId: threadId }, { body: 'x' });
    expect(reply.status).toBe(404);
    // And they cannot pull it back out.
    expect((await move(outsider, page, { space: 'SRC' })).status).toBe(404);

    expect((await getPage(editor, page)).status).toBe(200);
  });
});
