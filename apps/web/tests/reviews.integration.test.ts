import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as ChangesRoute from '@/app/api/v1/spaces/[key]/changes/route';
import type * as ReviewsRoute from '@/app/api/v1/spaces/[key]/reviews/route';
import type * as ClaimRoute from '@/app/api/v1/claims/[claimId]/route';
import type * as ClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';
import type * as DiffRoute from '@/app/api/v1/pages/[id]/diff/route';
import type * as ReviewRoute from '@/app/api/v1/pages/[id]/review/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as VersionRoute from '@/app/api/v1/pages/[id]/versions/[version]/route';
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as DrizzleOrm from 'drizzle-orm';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping reviews suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '10000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;
type Caller = string | TestAccount;

describe.skipIf(!probe.reachable)('review after agents', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  let changesRoute: typeof ChangesRoute;
  let reviewsRoute: typeof ReviewsRoute;
  let claimRoute: typeof ClaimRoute;
  let claimsRoute: typeof ClaimsRoute;
  let diffRoute: typeof DiffRoute;
  let reviewRoute: typeof ReviewRoute;
  let pageRoute: typeof PageRoute;
  let versionRoute: typeof VersionRoute;
  let pagesRoute: typeof PagesRoute;

  const suiteTag = `rev-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  let outsider: TestAccount;
  const userIds: string[] = [];

  /** `RVA` is the main space, `RVB` the one a restricted token cannot see. */
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

  async function reviewState(caller: Caller, pageId: string) {
    return json(await reviewRoute.GET(as(caller, `/api/v1/pages/${pageId}/review`), idParams(pageId)));
  }

  async function decide(caller: Caller, pageId: string, body: Record<string, unknown>) {
    return json(
      await reviewRoute.POST(
        as(caller, `/api/v1/pages/${pageId}/review`, { method: 'POST', body: JSON.stringify(body) }),
        idParams(pageId),
      ),
    );
  }

  async function pending(caller: Caller, key: string) {
    return json(await reviewsRoute.GET(as(caller, `/api/v1/spaces/${key}/reviews`), keyParams(key)));
  }

  async function changes(caller: Caller, key: string, query = '') {
    return json(
      await changesRoute.GET(as(caller, `/api/v1/spaces/${key}/changes${query}`), keyParams(key)),
    );
  }

  async function diff(caller: Caller, pageId: string, query: string) {
    return json(
      await diffRoute.GET(as(caller, `/api/v1/pages/${pageId}/diff${query}`), idParams(pageId)),
    );
  }

  async function page(caller: Caller, pageId: string) {
    return json(await pageRoute.GET(as(caller, `/api/v1/pages/${pageId}`), idParams(pageId)));
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

    changesRoute = await import('@/app/api/v1/spaces/[key]/changes/route');
    reviewsRoute = await import('@/app/api/v1/spaces/[key]/reviews/route');
    claimRoute = await import('@/app/api/v1/claims/[claimId]/route');
    claimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');
    diffRoute = await import('@/app/api/v1/pages/[id]/diff/route');
    reviewRoute = await import('@/app/api/v1/pages/[id]/review/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    versionRoute = await import('@/app/api/v1/pages/[id]/versions/[version]/route');
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
      .values({ workspaceId, key: 'RVA', name: 'Alpha' })
      .returning();
    await db.insert(schema.spaces).values({ workspaceId, key: 'RVB', name: 'Beta' });
    rvaId = rva!.id;

    writer = await seedToken('docs-agent', ['pages:read', 'pages:write'], null);
    secondWriter = await seedToken('api-agent', ['pages:read', 'pages:write'], null);
    onlyA = await seedToken('only-a', ['pages:read', 'pages:write'], [rvaId]);
    readOnly = await seedToken('read-only', ['pages:read'], null);
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

  /* ---------------- what is pending ---------------- */

  describe('what waits for a review', () => {
    it('is what agents wrote after the newest version a person wrote', async () => {
      const created = await create(editor, 'RVA', 'Token storage', 'Tokens are hashed with MD5.\n');
      const id = created.page_id as string;

      const untouched = await reviewState(readOnly, id);
      expect(untouched.status).toBe(200);
      expect(untouched.body).toMatchObject({
        current_version: 1,
        baseline_version: 1,
        pending: false,
        pending_revisions: [],
        reviews: [],
      });

      await write(writer, id, { body: 'Tokens are hashed with SHA-256.\n' });
      await write(secondWriter, id, { body: 'Tokens are hashed with SHA-256.\n\nRotated monthly.\n' });

      const state = await reviewState(readOnly, id);
      expect(state.body).toMatchObject({ current_version: 3, baseline_version: 1, pending: true });
      expect(
        state.body.pending_revisions.map((r: JsonRecord) => [r.version, r.author.label, r.review_status]),
      ).toEqual([
        [2, 'docs-agent', 'pending'],
        [3, 'api-agent', 'pending'],
      ]);

      const queue = await pending(readOnly, 'RVA');
      expect(queue.status).toBe(200);
      const entry = queue.body.pending.find((p: JsonRecord) => p.page_id === id);
      expect(entry).toMatchObject({
        current_version: 3,
        baseline_version: 1,
        created_by_agent: false,
        revision_count: 2,
        lines_added: 3,
        lines_removed: 1,
      });
      // Newest author first, and each only once.
      expect(entry.authors.map((a: JsonRecord) => a.label)).toEqual(['api-agent', 'docs-agent']);
    });

    it('is settled by a person editing the page, without a decision', async () => {
      const created = await create(editor, 'RVA', 'Edited over', 'one\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'one\ntwo\n' });
      expect((await reviewState(admin, id)).body.pending).toBe(true);

      await write(editor, id, { body: 'one\ntwo\nthree\n' });
      const state = await reviewState(admin, id);
      expect(state.body).toMatchObject({ pending: false, baseline_version: 3, reviews: [] });

      const feed = await changes(admin, 'RVA');
      const statuses = feed.body.changes
        .filter((c: JsonRecord) => c.page_id === id)
        .map((c: JsonRecord) => [c.version, c.author.type, c.review_status]);
      expect(statuses).toEqual([
        [3, 'user', 'none'],
        [2, 'agent', 'edited'],
        [1, 'user', 'none'],
      ]);
    });

    it('includes a page an agent created, with no baseline', async () => {
      const created = await create(writer, 'RVA', 'Born from an agent', 'first\nsecond\n');
      const id = created.page_id as string;

      const state = await reviewState(admin, id);
      expect(state.body).toMatchObject({ baseline_version: 0, pending: true, current_version: 1 });

      const queue = await pending(admin, 'RVA');
      expect(queue.body.pending.find((p: JsonRecord) => p.page_id === id)).toMatchObject({
        created_by_agent: true,
        baseline_version: 0,
        lines_added: 2,
        lines_removed: 0,
      });
    });
  });

  /* ---------------- diff and versions ---------------- */

  describe('diff and versions', () => {
    it('compares two versions, and the current one with any earlier', async () => {
      const created = await create(editor, 'RVA', 'Diffed', 'alpha\nbeta\ngamma\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'alpha\nBETA\ngamma\ndelta\n', title: 'Diffed twice' });

      const result = await diff(readOnly, id, '?from=1');
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        from: { version: 1, title: 'Diffed' },
        to: { version: 2, title: 'Diffed twice' },
        title_changed: true,
        identical: false,
        coarse: false,
        lines_added: 2,
        lines_removed: 1,
      });
      expect(result.body.hunks[0].lines.map((l: JsonRecord) => [l.kind, l.text])).toEqual([
        ['context', 'alpha'],
        ['removed', 'beta'],
        ['added', 'BETA'],
        ['context', 'gamma'],
        ['added', 'delta'],
      ]);

      const fromNothing = await diff(readOnly, id, '?from=0&to=1');
      expect(fromNothing.body).toMatchObject({ from: null, lines_added: 3, lines_removed: 0 });
    });

    it('refuses a range that is backwards, empty or past the history', async () => {
      const created = await create(editor, 'RVA', 'Ranges', 'x\n');
      const id = created.page_id as string;
      expect((await diff(readOnly, id, '?from=1&to=1')).status).toBe(400);
      expect((await diff(readOnly, id, '?from=-1')).status).toBe(400);
      expect((await diff(readOnly, id, '')).status).toBe(400);
      expect((await diff(readOnly, id, '?from=1&to=9')).status).toBe(404);
    });

    it('returns an old version with its body', async () => {
      const created = await create(editor, 'RVA', 'Versions', 'original\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'rewritten\n' });

      const first = await json(
        await versionRoute.GET(as(readOnly, `/api/v1/pages/${id}/versions/1`), {
          params: Promise.resolve({ id, version: '1' }),
        }),
      );
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ version: 1, body: 'original\n', author: { type: 'user' } });

      for (const version of ['7', '0', 'latest']) {
        const missing = await versionRoute.GET(
          as(readOnly, `/api/v1/pages/${id}/versions/${version}`),
          { params: Promise.resolve({ id, version }) },
        );
        expect(missing.status, version).toBe(404);
      }
    });
  });

  /* ---------------- deciding ---------------- */

  describe('accepting', () => {
    it('settles the pending range, leaves the page alone and is audited', async () => {
      const created = await create(editor, 'RVA', 'Accepted', 'v1\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'v2\n' });
      await write(writer, id, { body: 'v3\n' });

      const accepted = await decide(editor, id, { decision: 'accept', version: 3, note: '  Looks right.  ' });
      expect(accepted.status).toBe(201);
      expect(accepted.body).toMatchObject({
        decision: 'accepted',
        from_version: 1,
        to_version: 3,
        result_version: null,
        note: 'Looks right.',
        current_version: 3,
        reviewer: { id: editor.userId },
      });

      const after = await page(admin, id);
      expect(after.body).toMatchObject({ version: 3, body: 'v3\n' });

      const state = await reviewState(readOnly, id);
      expect(state.body).toMatchObject({ pending: false, baseline_version: 3 });
      expect(state.body.reviews).toHaveLength(1);
      expect((await pending(admin, 'RVA')).body.pending.map((p: JsonRecord) => p.page_id)).not.toContain(id);

      const feed = await changes(admin, 'RVA', '?author=agent');
      expect(
        feed.body.changes.filter((c: JsonRecord) => c.page_id === id).map((c: JsonRecord) => c.review_status),
      ).toEqual(['accepted', 'accepted']);

      expect(await auditRow(id, 'page.review_accepted')).toMatchObject({
        actor_type: 'user',
        from_version: 1,
        to_version: 3,
      });

      // The next agent write is pending again, against the accepted version.
      await write(writer, id, { body: 'v4\n' });
      expect((await reviewState(admin, id)).body).toMatchObject({ pending: true, baseline_version: 3 });
    });

    it('refuses a decision about a version that is no longer the newest', async () => {
      const created = await create(editor, 'RVA', 'Moved on', 'v1\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'v2\n' });
      await write(writer, id, { body: 'v3\n' });

      for (const decision of ['accept', 'revert']) {
        const stale = await decide(admin, id, { decision, version: 2 });
        expect(stale.status, decision).toBe(409);
        expect(stale.body.error.code).toBe('stale_base');
        expect(stale.body.error.details).toMatchObject({ current_version: 3, reviewed_version: 2 });
      }
      expect((await reviewState(admin, id)).body.reviews).toEqual([]);
    });

    it('refuses when nothing is pending', async () => {
      const created = await create(editor, 'RVA', 'Nothing to do', 'v1\n');
      const id = created.page_id as string;
      for (const decision of ['accept', 'revert']) {
        const refused = await decide(admin, id, { decision, version: 1 });
        expect(refused.status, decision).toBe(409);
        expect(refused.body.error.details.reason).toBe('nothing_pending');
      }
    });
  });

  describe('reverting', () => {
    it('writes the baseline back as a new version by the reviewer and keeps the history', async () => {
      const created = await create(editor, 'RVA', 'Reverted', 'kept\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'broken\n', title: 'Reverted (broken)' });
      await write(secondWriter, id, { body: 'more broken\n' });

      const reverted = await decide(admin, id, {
        decision: 'revert',
        version: 3,
        note: 'The storage section was deleted.',
      });
      expect(reverted.status, JSON.stringify(reverted.body)).toBe(201);
      expect(reverted.body).toMatchObject({
        decision: 'reverted',
        from_version: 1,
        to_version: 3,
        result_version: 4,
        current_version: 4,
      });

      const after = await page(readOnly, id);
      expect(after.body).toMatchObject({ version: 4, body: 'kept\n', title: 'Reverted' });

      // An agent finds out what happened to its change, and why.
      const state = await reviewState(writer, id);
      expect(state.body).toMatchObject({ pending: false, baseline_version: 4 });
      expect(state.body.reviews[0]).toMatchObject({
        decision: 'reverted',
        note: 'The storage section was deleted.',
      });

      const feed = await changes(writer, 'RVA');
      expect(
        feed.body.changes
          .filter((c: JsonRecord) => c.page_id === id)
          .map((c: JsonRecord) => [c.version, c.review_status]),
      ).toEqual([
        [4, 'none'],
        [3, 'reverted'],
        [2, 'reverted'],
        [1, 'none'],
      ]);

      expect(await auditRow(id, 'page.review_reverted')).toMatchObject({ result_version: 4 });
      // The revert released its own lease: the agent can write again at once.
      await write(writer, id, { body: 'second attempt\n' });
    });

    it('is refused with the holder named while an agent holds a claim', async () => {
      const created = await create(editor, 'RVA', 'Held', 'v1\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'v2\n' });
      const lease = await claim(writer, id);

      const refused = await decide(admin, id, { decision: 'revert', version: 2 });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('conflict');
      expect(JSON.stringify(refused.body.error)).toContain('docs-agent');
      expect((await page(admin, id)).body).toMatchObject({ version: 2, body: 'v2\n' });
      expect((await reviewState(admin, id)).body.reviews).toEqual([]);

      await release(writer, lease.claim_id as string);
      expect((await decide(admin, id, { decision: 'revert', version: 2 })).status).toBe(201);
    });

    it('has nothing to go back to for a page an agent created', async () => {
      const created = await create(writer, 'RVA', 'No baseline', 'text\n');
      const id = created.page_id as string;

      const refused = await decide(admin, id, { decision: 'revert', version: 1 });
      expect(refused.status).toBe(409);
      expect(refused.body.error.details.reason).toBe('no_baseline');

      const accepted = await decide(admin, id, { decision: 'accept', version: 1 });
      expect(accepted.status).toBe(201);
      expect(accepted.body).toMatchObject({ from_version: 0, to_version: 1 });
    });

    it('lets the reviewer keep a lease they already held', async () => {
      const created = await create(editor, 'RVA', 'Open in the editor', 'v1\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'v2\n' });
      const lease = await claim(admin, id);

      expect((await decide(admin, id, { decision: 'revert', version: 2 })).status).toBe(201);

      const [row] = await db
        .select({ releasedAt: schema.claims.releasedAt })
        .from(schema.claims)
        .where(drizzle.eq(schema.claims.id, lease.claim_id as string));
      expect(row?.releasedAt).toBeNull();
      await release(admin, lease.claim_id as string);
    });
  });

  /* ---------------- who may ---------------- */

  describe('who may review', () => {
    it('is never an agent token, whatever its scopes', async () => {
      const created = await create(editor, 'RVA', 'Agents cannot decide', 'v1\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'v2\n' });

      for (const decision of ['accept', 'revert']) {
        const refused = await decide(writer, id, { decision, version: 2 });
        expect(refused.status, decision).toBe(403);
        expect(refused.body.error.code).toBe('forbidden');
      }
      expect((await decide(readOnly, id, { decision: 'accept', version: 2 })).status).toBe(403);
      expect((await reviewState(admin, id)).body).toMatchObject({ pending: true, reviews: [] });
    });

    it('needs the session’s own origin', async () => {
      const created = await create(editor, 'RVA', 'Cross-site', 'v1\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'v2\n' });

      const forged = await reviewRoute.POST(
        new Request(`${BASE}/api/v1/pages/${id}/review`, {
          method: 'POST',
          headers: {
            cookie: admin.cookie,
            origin: 'https://evil.example',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ decision: 'accept', version: 2 }),
        }),
        idParams(id),
      );
      expect(forged.status).toBe(403);
      expect((await reviewState(admin, id)).body.pending).toBe(true);
    });

    it('validates the body', async () => {
      const created = await create(editor, 'RVA', 'Validation', 'v1\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'v2\n' });

      expect((await decide(admin, id, { decision: 'approve', version: 2 })).status).toBe(400);
      expect((await decide(admin, id, { decision: 'accept' })).status).toBe(400);
      expect((await decide(admin, id, { decision: 'accept', version: 2, extra: true })).status).toBe(400);
      const long = await decide(admin, id, { decision: 'accept', version: 2, note: 'x'.repeat(2_001) });
      expect(long.status).toBe(400);
    });
  });

  /* ---------------- scoping ---------------- */

  describe('scoping', () => {
    it('hides another workspace’s pages and spaces from every endpoint', async () => {
      const created = await create(editor, 'RVA', 'Private to the workspace', 'v1\n');
      const id = created.page_id as string;
      await write(writer, id, { body: 'v2\n' });

      expect((await reviewState(outsider, id)).status).toBe(404);
      expect((await diff(outsider, id, '?from=1')).status).toBe(404);
      expect((await decide(outsider, id, { decision: 'accept', version: 2 })).status).toBe(404);
      expect((await pending(outsider, 'RVA')).status).toBe(404);
      expect((await changes(outsider, 'RVA')).status).toBe(404);
      expect((await reviewState(admin, id)).body.pending).toBe(true);
    });

    it('keeps a space-restricted token inside its spaces', async () => {
      const created = await create(writer, 'RVB', 'In the other space', 'v1\n');
      const id = created.page_id as string;

      expect((await pending(onlyA, 'RVB')).status).toBe(404);
      expect((await changes(onlyA, 'RVB')).status).toBe(404);
      expect((await reviewState(onlyA, id)).status).toBe(404);
      expect((await diff(onlyA, id, '?from=0')).status).toBe(404);
      expect((await pending(onlyA, 'RVA')).status).toBe(200);

      // And the listing of one space never carries another's pages.
      const inA = await pending(admin, 'RVA');
      expect(inA.body.pending.map((p: JsonRecord) => p.page_id)).not.toContain(id);
    });
  });

  /* ---------------- the feed ---------------- */

  describe('the change feed', () => {
    it('pages through revisions written in the same instant without losing any', async () => {
      const [space] = await db
        .insert(schema.spaces)
        .values({ workspaceId, key: 'RVF', name: 'Feed' })
        .returning();
      const stamp = new Date('2026-01-01T00:00:00.000Z');
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const [row] = await db
          .insert(schema.pages)
          .values({
            workspaceId,
            spaceId: space!.id,
            path: `/bulk-${index}`,
            title: `Bulk ${index}`,
            body: '',
            contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            createdByType: 'agent',
            createdById: randomUUID(),
            updatedByType: 'agent',
            updatedById: randomUUID(),
          })
          .returning({ id: schema.pages.id });
        ids.push(row!.id);
        await db.insert(schema.pageRevisions).values({
          pageId: row!.id,
          version: 1,
          title: `Bulk ${index}`,
          body: '',
          contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          authorType: 'agent',
          authorId: randomUUID(),
          createdAt: stamp,
        });
      }

      const seen: string[] = [];
      let query = '?limit=3';
      for (let round = 0; round < 5; round += 1) {
        const part = await changes(admin, 'RVF', query);
        expect(part.status).toBe(200);
        seen.push(...part.body.changes.map((c: JsonRecord) => c.page_id as string));
        if (!part.body.next_before) break;
        query = `?limit=3&before=${encodeURIComponent(part.body.next_before as string)}`;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen)).toEqual(new Set(ids));

      // A token that no longer exists is still told apart by the start of its id.
      const first = await changes(admin, 'RVF', '?limit=1');
      expect(first.body.changes[0].author.label).toMatch(/^[0-9a-f]{8}$/);

      expect((await changes(admin, 'RVF', '?before=yesterday')).status).toBe(400);
      expect((await changes(admin, 'RVF', '?limit=0')).status).toBe(400);
    });
  });
});
