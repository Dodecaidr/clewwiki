import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

// Route modules are imported for their types here and loaded lazily below:
// they read configuration at module scope, so they must not be evaluated
// before the environment is set up.
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as PageClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';
import type * as NotesRoute from '@/app/api/v1/pages/[id]/notes/route';
import type * as PresenceRoute from '@/app/api/v1/claims/route';
import type * as ClaimRoute from '@/app/api/v1/claims/[claimId]/route';
import type * as AuditRoute from '@/app/api/v1/audit/route';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping claims suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
// The concurrency rounds below spend a lot of requests on one token; the limit
// is not what this suite is testing.
process.env.AGENT_TOKEN_RATE_LIMIT_MAX = '100000';

const BASE = 'http://localhost:3000';

/** How many times the concurrent-claim race is repeated. */
const CONCURRENCY_ROUNDS = 20;

describe.skipIf(!probe.reachable)('claims, presence and notes', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let dz: typeof DrizzleOrm;

  let pagesRoute: typeof PagesRoute;
  let pageRoute: typeof PageRoute;
  let pageClaimsRoute: typeof PageClaimsRoute;
  let notesRoute: typeof NotesRoute;
  let presenceRoute: typeof PresenceRoute;
  let claimRoute: typeof ClaimRoute;
  let auditRoute: typeof AuditRoute;

  const suiteTag = `cl-${randomUUID().slice(0, 8)}`;
  const workspaceIds: string[] = [];

  let workspaceId: string;
  let otherWorkspaceId: string;
  let adminUserId = '';

  // Two writers in the same workspace: the pair every concurrency test needs.
  let alice = '';
  let bob = '';
  let carol = '';
  let readOnly = '';
  let auditReader = '';
  let foreignToken = '';

  async function seedToken(options: {
    workspaceId: string;
    name: string;
    scopes: string[];
  }): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId: options.workspaceId,
      name: options.name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes: options.scopes,
    });
    return generated.token;
  }

  function request(token: string, path: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  const pageParams = (id: string) => ({ params: Promise.resolve({ id }) });
  const claimParams = (claimId: string) => ({ params: Promise.resolve({ claimId }) });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type JsonRecord = Record<string, any>;
  interface Answer {
    status: number;
    json: JsonRecord;
  }

  async function createPage(token: string, body: Record<string, unknown>): Promise<Answer> {
    const response = await pagesRoute.POST(
      request(token, '/api/v1/pages', { method: 'POST', body: JSON.stringify(body) }),
    );
    return { status: response.status, json: await response.json() };
  }

  /** A fresh page nothing else in the suite touches. */
  async function newPage(body = 'first'): Promise<{ pageId: string; contentHash: string }> {
    const created = await createPage(alice, {
      title: 'Claim target',
      path: `/${suiteTag}-${randomUUID().slice(0, 8)}`,
      body,
    });
    expect(created.status).toBe(201);
    return {
      pageId: created.json.page_id as string,
      contentHash: created.json.content_hash as string,
    };
  }

  async function claim(
    token: string,
    pageId: string,
    body: Record<string, unknown> = {},
  ): Promise<Answer> {
    const response = await pageClaimsRoute.POST(
      request(token, `/api/v1/pages/${pageId}/claims`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      pageParams(pageId),
    );
    return { status: response.status, json: await response.json() };
  }

  async function renew(token: string, claimId: string, body: Record<string, unknown> = {}) {
    const response = await claimRoute.PATCH(
      request(token, `/api/v1/claims/${claimId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
      claimParams(claimId),
    );
    return { status: response.status, json: await response.json() };
  }

  async function release(token: string, claimId: string, query = '') {
    const response = await claimRoute.DELETE(
      request(token, `/api/v1/claims/${claimId}${query}`, { method: 'DELETE' }),
      claimParams(claimId),
    );
    return { status: response.status, json: await response.json() };
  }

  async function write(
    token: string,
    pageId: string,
    body: Record<string, unknown>,
  ): Promise<Answer> {
    const response = await pageRoute.PATCH(
      request(token, `/api/v1/pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
      pageParams(pageId),
    );
    return { status: response.status, json: await response.json() };
  }

  async function postNote(token: string, pageId: string, body: Record<string, unknown>) {
    const response = await notesRoute.POST(
      request(token, `/api/v1/pages/${pageId}/notes`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      pageParams(pageId),
    );
    return { status: response.status, json: await response.json() };
  }

  async function listNotes(token: string, pageId: string) {
    const response = await notesRoute.GET(
      request(token, `/api/v1/pages/${pageId}/notes`),
      pageParams(pageId),
    );
    return { status: response.status, json: await response.json() };
  }

  async function presence(token: string) {
    const response = await presenceRoute.GET(request(token, '/api/v1/claims'));
    return { status: response.status, json: await response.json() };
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    dz = await import('drizzle-orm');
    db = schema.getDatabase();

    pagesRoute = await import('@/app/api/v1/pages/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    pageClaimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');
    notesRoute = await import('@/app/api/v1/pages/[id]/notes/route');
    presenceRoute = await import('@/app/api/v1/claims/route');
    claimRoute = await import('@/app/api/v1/claims/[claimId]/route');
    auditRoute = await import('@/app/api/v1/audit/route');

    const [primary] = await db
      .insert(schema.workspaces)
      .values({ name: `Primary ${suiteTag}`, slug: `${suiteTag}-primary` })
      .returning({ id: schema.workspaces.id });
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `${suiteTag}-other` })
      .returning({ id: schema.workspaces.id });

    workspaceId = primary!.id;
    otherWorkspaceId = other!.id;
    workspaceIds.push(workspaceId, otherWorkspaceId);

    adminUserId = `user-${randomUUID()}`;
    await db.insert(schema.users).values({
      id: adminUserId,
      name: `Admin ${suiteTag}`,
      email: `${suiteTag}@example.test`,
    });
    await db
      .insert(schema.memberships)
      .values({ workspaceId, userId: adminUserId, role: 'admin' });

    const writeScopes = ['pages:read', 'pages:write'];
    alice = await seedToken({ workspaceId, name: 'alice', scopes: writeScopes });
    bob = await seedToken({ workspaceId, name: 'bob', scopes: writeScopes });
    carol = await seedToken({ workspaceId, name: 'carol', scopes: writeScopes });
    readOnly = await seedToken({ workspaceId, name: 'reader', scopes: ['pages:read'] });
    auditReader = await seedToken({
      workspaceId,
      name: 'auditor',
      scopes: ['pages:read', 'audit:read'],
    });
    foreignToken = await seedToken({
      workspaceId: otherWorkspaceId,
      name: 'foreign',
      scopes: writeScopes,
    });
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { eq, inArray } = dz;
    if (workspaceIds.length > 0) {
      // Claims, notes, pages, tokens and audit rows all cascade from the
      // workspace; the user row does not, so it goes separately.
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds));
    }
    if (adminUserId) {
      await db.delete(schema.users).where(eq(schema.users.id, adminUserId));
    }
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  /* ---------------------------------------------------------------- */

  describe('concurrency', () => {
    it(`resolves ${CONCURRENCY_ROUNDS} concurrent races on one page to one winner each`, async () => {
      const outcomes: Array<{ created: number; conflicted: number }> = [];

      for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
        const { pageId } = await newPage();

        // Fired together, not one after the other: the two requests are in
        // flight at the same moment, contending for the same page row in two
        // separate database transactions. That is the whole guarantee.
        const [first, second] = await Promise.all([
          claim(alice, pageId),
          claim(bob, pageId),
        ]);

        const statuses = [first.status, second.status].sort((a, b) => a - b);
        expect(statuses).toEqual([201, 409]);

        const winner = first.status === 201 ? first : second;
        const loser = first.status === 201 ? second : first;

        expect(loser.json.error.code).toBe('conflict');
        // The loser is told who has it, since when and until when, so it can
        // wait rather than spin.
        expect(loser.json.error.details.held_by).toBe(winner.json.held_by);
        expect(loser.json.error.details.claim_id).toBe(winner.json.claim_id);
        expect(typeof loser.json.error.details.since).toBe('string');
        expect(typeof loser.json.error.details.expires_at).toBe('string');

        const rows = await db
          .select()
          .from(schema.claims)
          .where(
            dz.and(dz.eq(schema.claims.pageId, pageId), dz.isNull(schema.claims.releasedAt)),
          );
        expect(rows).toHaveLength(1);

        outcomes.push({
          created: statuses.filter((status) => status === 201).length,
          conflicted: statuses.filter((status) => status === 409).length,
        });
      }

      expect(outcomes).toHaveLength(CONCURRENCY_ROUNDS);
      expect(outcomes.every((round) => round.created === 1 && round.conflicted === 1)).toBe(true);
    });

    it(`resolves ${CONCURRENCY_ROUNDS} page-versus-section races to one winner each`, async () => {
      for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
        const { pageId } = await newPage();

        // A page-level claim and a section claim on the same page overlap by
        // definition — the rule the partial unique indexes cannot express on
        // their own, and the reason the check runs under the page row lock.
        const [whole, section] = await Promise.all([
          claim(alice, pageId),
          claim(bob, pageId, { section_id: 'api-reference' }),
        ]);

        const statuses = [whole.status, section.status].sort((a, b) => a - b);
        expect(statuses).toEqual([201, 409]);
      }
    });

    it('lets two writers hold different sections of one page at once', async () => {
      const { pageId } = await newPage();

      const [overview, reference] = await Promise.all([
        claim(alice, pageId, { section_id: 'overview' }),
        claim(bob, pageId, { section_id: 'api-reference' }),
      ]);

      expect(overview.status).toBe(201);
      expect(reference.status).toBe(201);
      expect(overview.json.section_id).toBe('overview');
      expect(reference.json.section_id).toBe('api-reference');

      // And a third writer wanting the whole page is refused: a page-level
      // claim overlaps every section claim on the page.
      const whole = await claim(carol, pageId);
      expect(whole.status).toBe(409);
    });

    it('treats re-claiming your own lease as a heartbeat, not a conflict', async () => {
      const { pageId } = await newPage();
      const first = await claim(alice, pageId);
      expect(first.status).toBe(201);

      const again = await claim(alice, pageId);
      expect(again.status).toBe(200);
      expect(again.json.claim_id).toBe(first.json.claim_id);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('lease lifetime', () => {
    it('expires by TTL and frees the page for someone else', async () => {
      const { pageId } = await newPage();

      const taken = await claim(alice, pageId, { ttl_seconds: 1 });
      expect(taken.status).toBe(201);

      const blocked = await claim(bob, pageId);
      expect(blocked.status).toBe(409);

      await sleep(1_200);

      // No sweep has run; expiry is applied by the very call that needs the
      // answer, which is what keeps a lapsed lease from blocking a page.
      const afterExpiry = await claim(bob, pageId);
      expect(afterExpiry.status).toBe(201);

      // The lapsed claim is *released*, not merely ignored — so the partial
      // unique index describes the same set of rows the service does.
      const { eq } = dz;
      const [lapsed] = await db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, taken.json.claim_id as string));
      expect(lapsed!.releaseReason).toBe('expired');
      expect(lapsed!.releasedAt).not.toBeNull();
    });

    it('refuses to renew a lease that has already lapsed', async () => {
      const { pageId } = await newPage();
      const taken = await claim(alice, pageId, { ttl_seconds: 1 });
      await sleep(1_200);

      const renewed = await renew(alice, taken.json.claim_id as string);
      expect(renewed.status).toBe(404);
      expect(renewed.json.error.code).toBe('not_found');
    });

    it('extends a live lease by heartbeat', async () => {
      const { pageId } = await newPage();
      const taken = await claim(alice, pageId, { ttl_seconds: 60 });
      const before = new Date(taken.json.expires_at as string).getTime();

      await sleep(50);
      const renewed = await renew(alice, taken.json.claim_id as string, { ttl_seconds: 300 });

      expect(renewed.status).toBe(200);
      expect(new Date(renewed.json.expires_at as string).getTime()).toBeGreaterThan(before);
    });

    it('will not let another actor renew or release a lease', async () => {
      const { pageId } = await newPage();
      const taken = await claim(alice, pageId);
      const claimId = taken.json.claim_id as string;

      expect((await renew(bob, claimId)).status).toBe(403);
      expect((await release(bob, claimId)).status).toBe(403);
    });

    it('releases idempotently', async () => {
      const { pageId } = await newPage();
      const taken = await claim(alice, pageId);
      const claimId = taken.json.claim_id as string;

      const first = await release(alice, claimId);
      expect(first.status).toBe(200);
      expect(first.json.already_released).toBe(false);

      const second = await release(alice, claimId);
      expect(second.status).toBe(200);
      expect(second.json.already_released).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('the write protocol', () => {
    it('refuses a write with no claim at all', async () => {
      const page = await newPage();
      const refused = await write(alice, page.pageId, {
        body: 'rewritten',
        base_content_hash: page.contentHash,
      });

      expect(refused.status).toBe(409);
      expect(refused.json.error.code).toBe('conflict');
      expect(refused.json.error.details.reason).toBe('claim_required');
    });

    it('refuses a write under someone else claim', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);

      const refused = await write(bob, page.pageId, {
        body: 'rewritten',
        claim_id: taken.json.claim_id,
        base_content_hash: page.contentHash,
      });

      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe('forbidden');
      expect(refused.json.error.details.held_by).toBe('alice');
    });

    it('refuses a write under a lease that has lapsed', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId, { ttl_seconds: 1 });
      await sleep(1_200);

      const refused = await write(alice, page.pageId, {
        body: 'rewritten',
        claim_id: taken.json.claim_id,
        base_content_hash: page.contentHash,
      });

      expect(refused.status).toBe(404);
      expect(refused.json.error.code).toBe('not_found');
    });

    it('refuses a write whose base hash is no longer current', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);
      const claimId = taken.json.claim_id as string;

      const first = await write(alice, page.pageId, {
        body: 'second',
        claim_id: claimId,
        base_content_hash: page.contentHash,
      });
      expect(first.status).toBe(200);

      const stale = await write(alice, page.pageId, {
        body: 'third',
        claim_id: claimId,
        base_content_hash: page.contentHash,
      });

      expect(stale.status).toBe(409);
      expect(stale.json.error.code).toBe('stale_base');
      expect(stale.json.error.details.your_base_hash).toBe(page.contentHash);
      expect(stale.json.error.details.current_content_hash).toBe(first.json.content_hash);
    });

    it('lets the holder write twice in a row under one lease', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);
      const claimId = taken.json.claim_id as string;

      const first = await write(alice, page.pageId, {
        body: 'second',
        claim_id: claimId,
        base_content_hash: page.contentHash,
      });
      expect(first.status).toBe(200);

      // The holder's own write is not an intervening edit, so the lease moves
      // to the hash it produced.
      const second = await write(alice, page.pageId, {
        body: 'third',
        claim_id: claimId,
        base_content_hash: first.json.content_hash,
      });
      expect(second.status).toBe(200);
      expect(second.json.version).toBe(3);
    });

    it('requires a base hash on every write', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);

      const refused = await write(alice, page.pageId, {
        body: 'rewritten',
        claim_id: taken.json.claim_id,
      });
      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe('validation');
    });

    it('accepts a write held under a section claim on the same page', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId, { section_id: 'overview' });

      const written = await write(alice, page.pageId, {
        body: 'section rewrite',
        claim_id: taken.json.claim_id,
        base_content_hash: page.contentHash,
      });
      expect(written.status).toBe(200);
    });

    it('refuses a claim that belongs to a different page', async () => {
      const first = await newPage();
      const second = await newPage();
      const taken = await claim(alice, first.pageId);

      const refused = await write(alice, second.pageId, {
        body: 'rewritten',
        claim_id: taken.json.claim_id,
        base_content_hash: second.contentHash,
      });
      expect(refused.status).toBe(409);
      expect(refused.json.error.details.reason).toBe('claim_page_mismatch');
    });
  });

  /* ---------------------------------------------------------------- */

  describe('presence and notes', () => {
    it('lists an active claim with its holder, target and notes', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId, { section_id: 'overview' });
      const claimId = taken.json.claim_id as string;

      const noted = await postNote(alice, page.pageId, {
        claim_id: claimId,
        text: 'Rewriting the overview, leave it alone for ten minutes.',
      });
      expect(noted.status).toBe(201);

      const board = await presence(readOnly);
      expect(board.status).toBe(200);

      const entry = board.json.claims.find((row: JsonRecord) => row.claim_id === claimId);
      expect(entry).toBeDefined();
      expect(entry.held_by).toBe('alice');
      expect(entry.actor_type).toBe('agent');
      expect(entry.page_id).toBe(page.pageId);
      expect(entry.section_id).toBe('overview');
      expect(typeof entry.since).toBe('string');
      expect(typeof entry.expires_at).toBe('string');
      expect(entry.notes).toHaveLength(1);
      expect(entry.notes[0].text).toContain('Rewriting the overview');
      expect(entry.notes[0].author).toBe('alice');
    });

    it('deletes the notes of a claim when it is released', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);
      const claimId = taken.json.claim_id as string;

      await postNote(alice, page.pageId, { claim_id: claimId, text: 'Working here.' });
      expect((await listNotes(readOnly, page.pageId)).json.notes).toHaveLength(1);

      const released = await release(alice, claimId);
      expect(released.json.notes_deleted).toBe(1);

      expect((await listNotes(readOnly, page.pageId)).json.notes).toHaveLength(0);

      // Gone from the table, not merely filtered out of the answer.
      const { eq } = dz;
      const rows = await db
        .select()
        .from(schema.claimNotes)
        .where(eq(schema.claimNotes.claimId, claimId));
      expect(rows).toHaveLength(0);
    });

    it('drops a claim from the board as soon as it is released', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);
      const claimId = taken.json.claim_id as string;

      expect(
        (await presence(readOnly)).json.claims.some((row: JsonRecord) => row.claim_id === claimId),
      ).toBe(true);

      await release(alice, claimId);

      expect(
        (await presence(readOnly)).json.claims.some((row: JsonRecord) => row.claim_id === claimId),
      ).toBe(false);
    });

    it('refuses a note on a claim held by someone else', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);

      const refused = await postNote(bob, page.pageId, {
        claim_id: taken.json.claim_id,
        text: 'Not mine to annotate.',
      });
      expect(refused.status).toBe(403);
    });

    it('refuses a note on a claim that is no longer active', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);
      const claimId = taken.json.claim_id as string;
      await release(alice, claimId);

      const refused = await postNote(alice, page.pageId, {
        claim_id: claimId,
        text: 'Too late.',
      });
      expect(refused.status).toBe(409);
    });

    it('rejects a note longer than the contract allows', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);

      const refused = await postNote(alice, page.pageId, {
        claim_id: taken.json.claim_id,
        text: 'x'.repeat(2_001),
      });
      expect(refused.status).toBe(400);
    });

    it('shows the claim on the page and marks the tree node claimed', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);

      const read = await pageRoute.GET(
        request(readOnly, `/api/v1/pages/${page.pageId}`),
        pageParams(page.pageId),
      );
      const body = await read.json();
      expect(body.claim.claim_id).toBe(taken.json.claim_id);
      expect(body.claim.held_by).toBe('alice');

      const tree = await pagesRoute.GET(request(readOnly, '/api/v1/pages?depth=5'));
      const nodes = (await tree.json()).nodes as JsonRecord[];
      const node = nodes.find((entry) => entry.page_id === page.pageId);
      expect(node?.claimed).toBe(true);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('force release', () => {
    it('lets an administrator take a claim away, and records it', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);
      const claimId = taken.json.claim_id as string;
      await postNote(alice, page.pageId, { claim_id: claimId, text: 'Mid-edit.' });

      const { releaseClaim } = await import('@/lib/claims/service');
      await releaseClaim({
        workspaceId,
        claimId,
        actor: { type: 'user', id: adminUserId, label: 'Admin' },
        force: true,
      });

      const { and, eq } = dz;
      const [row] = await db
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.id, claimId));
      expect(row!.releaseReason).toBe('forced');
      expect(row!.releasedBy).toBe(adminUserId);

      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.target, claimId),
            eq(schema.auditLog.action, 'claim.force_released'),
          ),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorId).toBe(adminUserId);
      expect(audit[0]!.workspaceId).toBe(workspaceId);

      // The page is claimable again, and the notes went with the claim.
      expect((await claim(bob, page.pageId)).status).toBe(201);
      expect((await listNotes(readOnly, page.pageId)).json.notes).toHaveLength(0);
    });

    it('never lets an agent token force-release someone else claim', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);

      const refused = await release(bob, taken.json.claim_id as string, '?force=true');
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe('forbidden');
    });
  });

  /* ---------------------------------------------------------------- */

  describe('audit', () => {
    it('records both outcomes of a claim conflict', async () => {
      const page = await newPage();
      const winner = await claim(alice, page.pageId);
      const loser = await claim(bob, page.pageId);
      expect(loser.status).toBe(409);

      const response = await auditRoute.GET(
        request(auditReader, `/api/v1/audit?target=${page.pageId}&limit=200`),
      );
      expect(response.status).toBe(200);
      const entries = (await response.json()).entries as JsonRecord[];

      // The rejection is aimed at the page, the success at the claim it made.
      expect(entries.some((entry) => entry.action === 'claim.rejected')).toBe(true);

      const success = await auditRoute.GET(
        request(auditReader, `/api/v1/audit?target=${winner.json.claim_id}&limit=50`),
      );
      const successEntries = (await success.json()).entries as JsonRecord[];
      expect(successEntries.some((entry) => entry.action === 'claim.acquired')).toBe(true);
    });

    it('records a write refused for a stale hash', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);

      await write(alice, page.pageId, {
        body: 'second',
        claim_id: taken.json.claim_id,
        base_content_hash: page.contentHash,
      });
      const stale = await write(alice, page.pageId, {
        body: 'third',
        claim_id: taken.json.claim_id,
        base_content_hash: page.contentHash,
      });
      expect(stale.status).toBe(409);

      const { and, eq } = dz;
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.target, page.pageId),
            eq(schema.auditLog.action, 'page.write_rejected'),
          ),
        );
      expect(rows).toHaveLength(1);
      expect((rows[0]!.metadata as Record<string, unknown>).reason).toBe('stale_base');
    });

    it('refuses the audit log to a token without audit:read', async () => {
      const response = await auditRoute.GET(request(alice, '/api/v1/audit'));
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('insufficient_scope');
    });
  });

  /* ---------------------------------------------------------------- */

  describe('workspace isolation', () => {
    it('will not claim, renew or release across workspaces', async () => {
      const page = await newPage();
      expect((await claim(foreignToken, page.pageId)).status).toBe(404);

      const taken = await claim(alice, page.pageId);
      const claimId = taken.json.claim_id as string;

      expect((await renew(foreignToken, claimId)).status).toBe(404);
      expect((await release(foreignToken, claimId)).status).toBe(404);
      expect(
        (await postNote(foreignToken, page.pageId, { claim_id: claimId, text: 'hello' })).status,
      ).toBe(404);
    });

    it('never shows another workspace claims on the presence board', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);

      const board = await presence(foreignToken);
      expect(board.status).toBe(200);
      expect(
        board.json.claims.some((row: JsonRecord) => row.claim_id === taken.json.claim_id),
      ).toBe(false);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('scope enforcement', () => {
    it('refuses every claim write to a read-only token', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId);
      const claimId = taken.json.claim_id as string;

      expect((await claim(readOnly, page.pageId)).status).toBe(403);
      expect((await renew(readOnly, claimId)).status).toBe(403);
      expect((await release(readOnly, claimId)).status).toBe(403);
      expect(
        (await postNote(readOnly, page.pageId, { claim_id: claimId, text: 'no' })).status,
      ).toBe(403);
    });

    it('requires pages:read for presence and for notes', async () => {
      const noScope = await seedToken({
        workspaceId,
        name: 'nothing',
        scopes: ['identity:read'],
      });
      const page = await newPage();

      expect((await presence(noScope)).status).toBe(403);
      expect((await listNotes(noScope, page.pageId)).status).toBe(403);
    });

    it('refuses presence without credentials', async () => {
      const response = await presenceRoute.GET(new Request(`${BASE}/api/v1/claims`));
      expect(response.status).toBe(401);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('the sweep', () => {
    it('ends leases nobody asked about', async () => {
      const page = await newPage();
      const taken = await claim(alice, page.pageId, { ttl_seconds: 1 });
      const claimId = taken.json.claim_id as string;
      await postNote(alice, page.pageId, { claim_id: claimId, text: 'about to lapse' });

      await sleep(1_200);

      const { expireStaleClaims } = await import('@/lib/claims/service');
      const { expired } = await expireStaleClaims();
      expect(expired).toBeGreaterThanOrEqual(1);

      const { eq } = dz;
      const [row] = await db.select().from(schema.claims).where(eq(schema.claims.id, claimId));
      expect(row!.releaseReason).toBe('expired');

      const notes = await db
        .select()
        .from(schema.claimNotes)
        .where(eq(schema.claimNotes.claimId, claimId));
      expect(notes).toHaveLength(0);
    });
  });
});
