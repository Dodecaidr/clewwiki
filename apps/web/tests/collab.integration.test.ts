import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as CollabRoute from '@/app/api/v1/pages/[id]/collab/route';
import type * as CollabRooms from '@/lib/collab/rooms';
import type * as ProviderModule from '@/components/editor/collab/provider';
import type * as ClaimRoute from '@/app/api/v1/claims/[claimId]/route';
import type * as ClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as DrizzleOrm from 'drizzle-orm';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping collab suite: ${probe.reason}`);
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

describe.skipIf(!probe.reachable)('live editing sessions', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  let collabRoute: typeof CollabRoute;
  let collabRooms: typeof CollabRooms;
  let providerModule: typeof ProviderModule;
  let claimRoute: typeof ClaimRoute;
  let claimsRoute: typeof ClaimsRoute;
  let pageRoute: typeof PageRoute;
  let pagesRoute: typeof PagesRoute;

  const suiteTag = `col-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  let outsider: TestAccount;
  const userIds: string[] = [];

  /** `CLA` is the main space, `CLB` the one a restricted token cannot see. */
  let rvaId = '';
  let writer = '';
  let onlyA = '';

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

  async function page(caller: Caller, pageId: string) {
    return json(await pageRoute.GET(as(caller, `/api/v1/pages/${pageId}`), idParams(pageId)));
  }


  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
  const unb64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

  interface SseEvent {
    event: string;
    data: JsonRecord;
  }

  /**
   * A browser in a session: its own Yjs document, a stream of server-sent events
   * read off the route's response, and the `POST`s a provider would make.
   */
  class Browser {
    readonly doc = new Y.Doc();
    readonly awareness = new Awareness(this.doc);
    readonly clientId = randomUUID();
    readonly events: SseEvent[] = [];
    status = 0;
    private abort = new AbortController();
    private waiters: Array<() => void> = [];

    constructor(
      readonly who: Caller,
      readonly pageId: string,
    ) {}

    get text(): string {
      return this.doc.getText('t').toString();
    }

    async join(): Promise<SseEvent | null> {
      const request = as(
        this.who,
        `/api/v1/pages/${this.pageId}/collab?client=${this.clientId}&y=${this.doc.clientID}`,
        { signal: this.abort.signal },
      );
      const response = await collabRoute.GET(request, idParams(this.pageId));
      this.status = response.status;
      if (response.status !== 200 || !response.body) return null;
      void this.read(response.body.getReader());
      return this.next('hello');
    }

    private async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            cut = buffer.indexOf('\n\n');
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (!event || !data) continue;
            const parsed = { event, data: JSON.parse(data) as JsonRecord };
            // What a provider does with what it hears.
            if (event === 'hello' && parsed.data.state) Y.applyUpdate(this.doc, unb64(parsed.data.state), 'remote');
            if (event === 'update') Y.applyUpdate(this.doc, unb64(parsed.data.update), 'remote');
            this.events.push(parsed);
            for (const wake of this.waiters.splice(0)) wake();
          }
        }
      } catch {
        // Closed from this side.
      }
    }

    /** The next event of this name that has not been taken yet. */
    async next(name: string, timeoutMs = 3_000): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = this.events.findIndex((entry) => entry.event === name);
        if (index !== -1) return this.events.splice(index, 1)[0]!;
        if (Date.now() > deadline) throw new Error(`no "${name}" event; saw ${this.events.map((e) => e.event).join(',')}`);
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    }

    async post(message: Record<string, unknown>, who: Caller = this.who) {
      return json(
        await collabRoute.POST(
          as(who, `/api/v1/pages/${this.pageId}/collab`, {
            method: 'POST',
            body: JSON.stringify({ client: this.clientId, ...message }),
          }),
          idParams(this.pageId),
        ),
      );
    }

    /** Types into the shared text and sends only what changed. */
    async type(index: number, value: string, kind: 'update' | 'seed' = 'update') {
      const before = Y.encodeStateVector(this.doc);
      this.doc.getText('t').insert(index, value);
      return this.post({ kind, update: b64(Y.encodeStateAsUpdate(this.doc, before)) });
    }

    async save(body: string, extra: Record<string, unknown> = {}) {
      return this.post({ kind: 'save', body, state_vector: b64(Y.encodeStateVector(this.doc)), ...extra });
    }

    close(): void {
      this.abort.abort();
    }
  }

  const browsers: Browser[] = [];
  function browser(who: Caller, pageId: string): Browser {
    const made = new Browser(who, pageId);
    browsers.push(made);
    return made;
  }

  async function settle(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition was not reached');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function activeClaims(pageId: string) {
    return db
      .select({ holderId: schema.claims.holderId, holderLabel: schema.claims.holderLabel })
      .from(schema.claims)
      .where(drizzle.and(drizzle.eq(schema.claims.pageId, pageId), drizzle.isNull(schema.claims.releasedAt)));
  }

  async function revisions(pageId: string) {
    return db
      .select({ version: schema.pageRevisions.version, authorId: schema.pageRevisions.authorId, body: schema.pageRevisions.body })
      .from(schema.pageRevisions)
      .where(drizzle.eq(schema.pageRevisions.pageId, pageId))
      .orderBy(schema.pageRevisions.version);
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    collabRoute = await import('@/app/api/v1/pages/[id]/collab/route');
    collabRooms = await import('@/lib/collab/rooms');
    providerModule = await import('@/components/editor/collab/provider');
    claimRoute = await import('@/app/api/v1/claims/[claimId]/route');
    claimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
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
      .values({ workspaceId, key: 'CLA', name: 'Alpha' })
      .returning();
    await db.insert(schema.spaces).values({ workspaceId, key: 'CLB', name: 'Beta' });
    rvaId = rva!.id;

    writer = await seedToken('docs-agent', ['pages:read', 'pages:write'], null);
    onlyA = await seedToken('only-a', ['pages:read', 'pages:write'], [rvaId]);
  });

  afterEach(async () => {
    for (const browser of browsers.splice(0)) browser.close();
    if (probe.reachable) await collabRooms.closeAllRooms();
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

  /* ---------------- one room, one claim ---------------- */

  describe('a session', () => {
    it('is opened by the first person in, who builds the document, and holds one claim for everybody', async () => {
      const created = await create(editor, 'CLA', 'Shared page', 'base\n');
      const id = created.page_id as string;

      const dana = browser(admin, id);
      const hello = await dana.join();
      expect(hello?.data).toMatchObject({
        seeded: false,
        seed: true,
        state: null,
        status: 'live',
        unsaved: false,
        base: { version: 1, content_hash: created.content_hash },
      });
      expect(hello?.data.participants).toHaveLength(1);

      const held = await activeClaims(id);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ holderId: `collab:${id}` });
      expect(held[0]?.holderLabel).toMatch(/^Live session: admin /);

      // To an agent the session is a writer like any other: CONFLICT, with names.
      const refused = await json(
        await claimsRoute.POST(
          as(writer, `/api/v1/pages/${id}/claims`, { method: 'POST', body: JSON.stringify({}) }),
          idParams(id),
        ),
      );
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body.error)).toContain('Live session');

      expect((await dana.type(0, 'base', 'seed')).status).toBe(200);

      const lee = browser(editor, id);
      const second = await lee.join();
      expect(second?.data).toMatchObject({ seeded: true, seed: false, status: 'live' });
      expect(lee.text).toBe('base');
      expect((await dana.next('participants')).data.participants).toHaveLength(2);
      expect((await activeClaims(id))[0]?.holderLabel).toMatch(/admin .*, editor /);
      expect(await activeClaims(id)).toHaveLength(1);
    });

    it('merges what two people type at once, and never echoes an edit to its author', async () => {
      const created = await create(editor, 'CLA', 'Typed together', '');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'middle', 'seed');
      const lee = browser(editor, id);
      await lee.join();

      await Promise.all([dana.type(0, 'start '), lee.type(6, ' end')]);
      await settle(() => dana.text === 'start middle end' && lee.text === 'start middle end');

      expect(dana.events.filter((e) => e.event === 'update').every((e) => e.data.from === lee.clientId)).toBe(true);
    });

    it('builds the document once, whoever else tries', async () => {
      const created = await create(editor, 'CLA', 'Seeded once', 'x');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      const lee = browser(editor, id);
      const [first, second] = [await dana.join(), await lee.join()];
      expect([first?.data.seed, second?.data.seed]).toEqual([true, false]);

      // Lee was not asked and seeds anyway; then Dana does, and again.
      expect((await lee.type(0, 'page', 'seed')).status).toBe(200);
      expect((await dana.type(0, 'page', 'seed')).status).toBe(200);
      expect((await dana.type(0, 'again', 'seed')).status).toBe(200);
      await settle(() => lee.text.includes('page'));
      const fresh = browser(admin, id);
      await fresh.join();
      expect(fresh.text).toBe('page');
    });

    it('hands the job of building the document on when whoever had it leaves', async () => {
      const created = await create(editor, 'CLA', 'Seeder leaves', 'x');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      const lee = browser(editor, id);
      await dana.join();
      await lee.join();
      dana.close();
      await lee.next('seed');
      expect((await lee.type(0, 'x', 'seed')).status).toBe(200);
      expect((await lee.type(1, 'y')).status).toBe(200);
    });
  });

  /* ---------------- saving ---------------- */

  describe('saving', () => {
    it('writes a revision by whoever saved, under the session’s claim, and tells everybody', async () => {
      const created = await create(editor, 'CLA', 'Saved together', 'v1\n');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'v1', 'seed');
      const lee = browser(editor, id);
      await lee.join();
      await lee.type(2, ' and more');
      await settle(() => dana.text === 'v1 and more');

      const saved = await lee.save('v1 and more\n');
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body).toMatchObject({ written: true, version: 2, body: 'v1 and more\n' });

      const history = await revisions(id);
      expect(history.map((r) => [r.version, r.authorId])).toEqual([
        [1, editor.userId],
        [2, editor.userId],
      ]);
      const told = await dana.next('saved');
      expect(told.data).toMatchObject({ version: 2, unsaved: false, by: { user_id: editor.userId } });
      // The session keeps the page: saving is not leaving.
      expect(await activeClaims(id)).toHaveLength(1);

      // Everybody autosaves on the same idle timer; the same text is one revision.
      const again = await dana.save('v1 and more\n');
      expect(again.body).toMatchObject({ written: false, version: 2 });
      expect(await revisions(id)).toHaveLength(2);

      // And a second real save goes through under the same claim.
      await dana.type(0, '# ');
      expect((await dana.save('# v1 and more\n')).body).toMatchObject({ written: true, version: 3 });
      expect((await revisions(id))[2]?.authorId).toBe(admin.userId);
    });

    it('stays unsaved when somebody typed after the saver serialised', async () => {
      const created = await create(editor, 'CLA', 'Save race', 'a');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'a', 'seed');
      const lee = browser(editor, id);
      await lee.join();

      // Dana serialises, then Lee's edit reaches the room before her save does.
      const vector = b64(Y.encodeStateVector(dana.doc));
      await lee.type(1, 'b');
      const saved = await dana.post({ kind: 'save', body: 'a\n', state_vector: vector });
      expect(saved.body.written).toBe(true);
      expect((await lee.next('saved')).data.unsaved).toBe(true);

      await settle(() => dana.text === 'ab');
      await dana.save('ab\n');
      expect((await lee.next('saved')).data.unsaved).toBe(false);
    });

    it('runs the same validation as any other write', async () => {
      const created = await create(editor, 'CLA', 'Invalid chart', 'ok\n');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'ok', 'seed');
      const refused = await dana.save('```chart\nnot json\n```\n');
      expect(refused.status).toBe(400);
      expect(await revisions(id)).toHaveLength(1);
    });
  });

  /* ---------------- leaving, pausing, resuming ---------------- */

  describe('leaving and pausing', () => {
    it('gives the page back at once when the last person leaves with nothing unsaved', async () => {
      const created = await create(editor, 'CLA', 'Left clean', 'x\n');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'x', 'seed');
      dana.close();
      await settle(async () => (await activeClaims(id)).length === 0);
      expect(collabRooms.roomParticipants(id)).toEqual([]);
      await write(writer, id, { body: 'an agent writes\n' });
    });

    it('keeps unsaved text for whoever opens the page next, and the claim until it lapses', async () => {
      const created = await create(editor, 'CLA', 'Left unsaved', 'x\n');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'x', 'seed');
      await dana.type(1, ' unsaved words');
      dana.close();
      await settle(() => collabRooms.roomParticipants(id).length === 0);
      await settle(async () => {
        const [row] = await db
          .select({ pageId: schema.pageCollabStates.pageId })
          .from(schema.pageCollabStates)
          .where(drizzle.eq(schema.pageCollabStates.pageId, id));
        return row !== undefined;
      });
      expect(await activeClaims(id)).toHaveLength(1);

      const lee = browser(editor, id);
      const hello = await lee.join();
      expect(hello?.data).toMatchObject({ seeded: true, seed: false, unsaved: true });
      expect(lee.text).toBe('x unsaved words');
    });

    it('throws unsaved text away when the page was written in the meantime', async () => {
      const created = await create(editor, 'CLA', 'Overtaken', 'x\n');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'x', 'seed');
      await dana.type(1, ' lost');
      dana.close();
      await settle(() => collabRooms.roomParticipants(id).length === 0);

      // The session's claim lapses, and an agent takes the page.
      await db
        .update(schema.claims)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(drizzle.eq(schema.claims.pageId, id));
      await write(writer, id, { body: 'the agent’s text\n' });

      const lee = browser(editor, id);
      const hello = await lee.join();
      expect(hello?.data).toMatchObject({ seeded: false, seed: true, unsaved: false, base: { version: 2 } });
      const [row] = await db
        .select({ pageId: schema.pageCollabStates.pageId })
        .from(schema.pageCollabStates)
        .where(drizzle.eq(schema.pageCollabStates.pageId, id));
      expect(row).toBeUndefined();
    });

    it('pauses an idle session so that agents get the page, and resets it if they used it', async () => {
      const created = await create(editor, 'CLA', 'Forgotten tab', 'x\n');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'x', 'seed');

      await collabRooms.ageRoomForTests(id, 10 * 60 * 1000);
      expect((await dana.next('status')).data).toMatchObject({ status: 'paused' });
      expect(await activeClaims(id)).toHaveLength(0);

      // Nothing happened while it was paused: typing simply takes the page back.
      expect((await dana.type(1, 'y')).status).toBe(200);
      expect((await dana.next('status')).data.status).toBe('live');
      await dana.save('xy\n');

      await collabRooms.ageRoomForTests(id, 10 * 60 * 1000);
      await dana.next('status');
      await write(writer, id, { body: 'rewritten by an agent\n' });

      // The document is about a text that no longer exists: load the page again.
      const refused = await dana.type(2, 'z');
      expect(refused.status).toBe(409);
      expect((await dana.next('reset')).data.reason).toBe('page_changed');
      expect((await page(admin, id)).body.body).toBe('rewritten by an agent\n');
    });

    it('is paused from the start when an agent holds the page, and says who', async () => {
      const created = await create(editor, 'CLA', 'Agent first', 'x\n');
      const id = created.page_id as string;
      const lease = await claim(writer, id);

      const dana = browser(admin, id);
      const hello = await dana.join();
      expect(hello?.data).toMatchObject({ status: 'paused', held_by: 'docs-agent' });
      const refused = await dana.type(0, 'x', 'seed');
      expect(refused.status).toBe(409);
      expect(refused.body.error.details).toMatchObject({ reason: 'paused', held_by: 'docs-agent' });

      await release(writer, lease.claim_id as string);
      expect((await dana.post({ kind: 'resume' })).body.status).toBe('live');
      expect((await dana.type(0, 'x', 'seed')).status).toBe(200);
    });
  });

  /* ---------------- cursors ---------------- */

  describe('cursors', () => {
    it('relays a person’s own cursor, removes it when they leave, and refuses anybody else’s', async () => {
      const created = await create(editor, 'CLA', 'Cursors', 'x');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'x', 'seed');
      const lee = browser(editor, id);
      await lee.join();
      expect((await dana.next('participants')).data.participants).toHaveLength(2);

      lee.awareness.setLocalState({ cursor: { anchor: 1, head: 1 } });
      const own = b64(encodeAwarenessUpdate(lee.awareness, [lee.doc.clientID]));
      expect((await lee.post({ kind: 'awareness', update: own })).status).toBe(200);
      expect((await dana.next('awareness')).data.update).toBe(own);

      // Lee speaks for Dana's cursor.
      const forged = new Awareness(new Y.Doc());
      forged.clientID = dana.doc.clientID;
      forged.setLocalState({ cursor: { anchor: 0, head: 0 } });
      const spoof = await lee.post({
        kind: 'awareness',
        update: b64(encodeAwarenessUpdate(forged, [dana.doc.clientID])),
      });
      expect(spoof.status).toBe(403);

      lee.close();
      await dana.next('awareness'); // the removal of Lee's cursor
      expect((await dana.next('participants')).data.participants).toHaveLength(1);
    });
  });

  /* ---------------- the browser's provider, against the real routes ---------------- */

  describe('the provider', () => {
    /**
     * `EventSource` and `fetch` as a browser has them, wired to the route
     * handlers and signed in as one person. The provider under test is the real
     * one; only the network is replaced.
     */
    function browserFor(who: TestAccount) {
      const sources: FakeEventSource[] = [];

      class FakeEventSource {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;
        readyState = 0;
        onerror: (() => void) | null = null;
        private listeners = new Map<string, Array<(event: { data: string }) => void>>();
        private abort = new AbortController();
        private closedByPage = false;

        constructor(readonly url: string) {
          sources.push(this);
          void this.open();
        }

        addEventListener(name: string, listener: (event: { data: string }) => void): void {
          this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
        }

        private async open(): Promise<void> {
          this.abort = new AbortController();
          const target = new URL(this.url, BASE);
          const response = await collabRoute.GET(
            as(who, `${target.pathname}${target.search}`, { signal: this.abort.signal }),
            idParams(target.pathname.split('/')[4]!),
          );
          if (response.status !== 200 || !response.body) {
            this.readyState = 2;
            this.onerror?.();
            return;
          }
          this.readyState = 1;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let cut = buffer.indexOf('\n\n');
              while (cut !== -1) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                cut = buffer.indexOf('\n\n');
                const name = /^event: (.+)$/m.exec(block)?.[1];
                const data = /^data: (.+)$/m.exec(block)?.[1];
                if (name && data) for (const listener of this.listeners.get(name) ?? []) listener({ data });
              }
            }
          } catch {
            // The stream was cut.
          }
        }

        /** The network drops; a browser reconnects the same source by itself. */
        drop(): void {
          this.abort.abort();
          this.readyState = 0;
          this.onerror?.();
        }

        reconnect(): void {
          if (!this.closedByPage) void this.open();
        }

        close(): void {
          this.closedByPage = true;
          this.readyState = 2;
          this.abort.abort();
        }
      }

      const fetchAs = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const target = new URL(String(input), BASE);
        return collabRoute.POST(
          as(who, target.pathname, { method: 'POST', body: init?.body as string }),
          idParams(target.pathname.split('/')[4]!),
        );
      };

      return { FakeEventSource, fetchAs, sources };
    }

    const initialState = (text: string) => (): Uint8Array => {
      const doc = new Y.Doc();
      doc.getText('t').insert(0, text);
      return Y.encodeStateAsUpdate(doc);
    };

    function provide(who: TestAccount, pageId: string, text: string) {
      const fake = browserFor(who);
      vi.stubGlobal('EventSource', fake.FakeEventSource);
      const provider = new providerModule.SessionProvider({
        pageId,
        buildInitialState: initialState(text),
        onChange: () => undefined,
      });
      // Every request this provider makes is made as this person.
      (provider as unknown as { post: (message: Record<string, unknown>) => Promise<Response | null> }).post = async (
        message,
      ) =>
        fake.fetchAs(`/api/v1/pages/${pageId}/collab`, {
          body: JSON.stringify({ client: provider.clientId, ...message }),
        });
      providers.push(provider);
      return { provider, sources: fake.sources };
    }

    const providers: Array<InstanceType<typeof ProviderModule.SessionProvider>> = [];
    afterEach(() => {
      for (const provider of providers.splice(0)) provider.destroy();
      vi.unstubAllGlobals();
    });

    const textOf = (provider: InstanceType<typeof ProviderModule.SessionProvider>): string =>
      provider.doc.getText('t').toString();

    it('builds the document once and keeps two people in step', async () => {
      const created = await create(editor, 'CLA', 'Provider pair', 'page');
      const id = created.page_id as string;

      const dana = provide(admin, id, 'page');
      await settle(() => dana.provider.state.ready);
      const lee = provide(editor, id, 'page');
      await settle(() => lee.provider.state.ready && textOf(lee.provider) === 'page');

      dana.provider.doc.getText('t').insert(0, 'A ');
      lee.provider.doc.getText('t').insert(4, ' B');
      await settle(() => textOf(dana.provider) === textOf(lee.provider) && textOf(dana.provider).length === 8);
      expect(textOf(dana.provider)).toContain('page');
      // The page is there once: only one of them built it.
      expect(textOf(dana.provider).match(/page/g)).toHaveLength(1);
      expect(dana.provider.state.participants).toHaveLength(2);
      expect(dana.provider.participantOf(lee.provider.doc.clientID)?.name).toMatch(/^editor /);
    });

    it('sends what was typed while the stream was down, once it is back', async () => {
      const created = await create(editor, 'CLA', 'Provider offline', 'x');
      const id = created.page_id as string;
      const dana = provide(admin, id, 'x');
      await settle(() => dana.provider.state.ready);
      const lee = provide(editor, id, 'x');
      await settle(() => lee.provider.state.ready && textOf(lee.provider) === 'x');

      dana.sources[0]!.drop();
      await settle(() => dana.provider.state.status === 'offline');
      await settle(() => collabRooms.roomParticipants(id).length === 1);
      dana.provider.doc.getText('t').insert(1, ' typed offline');
      // The server no longer knows the connection, so the edit cannot be sent.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(textOf(lee.provider)).toBe('x');

      dana.sources[0]!.reconnect();
      await settle(() => textOf(lee.provider) === 'x typed offline');
      expect(dana.provider.state.status).toBe('live');
    });

    it('keeps edits while the page is somebody else’s, and sends them when it is not', async () => {
      const created = await create(editor, 'CLA', 'Provider paused', 'x');
      const id = created.page_id as string;
      const dana = provide(admin, id, 'x');
      await settle(() => dana.provider.state.ready);

      // The session goes idle, gives the page back, and an agent claims it.
      await collabRooms.ageRoomForTests(id, 10 * 60 * 1000);
      await settle(() => dana.provider.state.status === 'paused');
      const lease = await claim(writer, id);

      dana.provider.doc.getText('t').insert(1, ' kept');
      await settle(() => dana.provider.state.heldBy === 'docs-agent');
      expect(await dana.provider.resume()).toBe(false);

      await release(writer, lease.claim_id as string);
      expect(await dana.provider.resume()).toBe(true);
      const lee = provide(editor, id, 'x');
      await settle(() => textOf(lee.provider) === 'x kept');
    });

    it('stops when the page was rewritten under it', async () => {
      const created = await create(editor, 'CLA', 'Provider reset', 'x');
      const id = created.page_id as string;
      const dana = provide(admin, id, 'x');
      await settle(() => dana.provider.state.ready);
      await collabRooms.ageRoomForTests(id, 10 * 60 * 1000);
      await settle(() => dana.provider.state.status === 'paused');
      await write(writer, id, { body: 'rewritten\n' });

      dana.provider.doc.getText('t').insert(1, '!');
      await settle(() => dana.provider.state.status === 'reset');
      expect(dana.provider.state.ready).toBe(false);
    });
  });

  /* ---------------- who may ---------------- */

  describe('who may be in a session', () => {
    it('is never an agent token, and never somebody from another workspace or space', async () => {
      const created = await create(editor, 'CLA', 'People only', 'x');
      const id = created.page_id as string;
      const elsewhere = await create(editor, 'CLB', 'Other space', 'x');

      const agent = browser(writer, id);
      expect(await agent.join()).toBeNull();
      expect(agent.status).toBe(403);
      expect((await agent.post({ kind: 'resume' })).status).toBe(403);

      const stranger = browser(outsider, id);
      await stranger.join();
      expect(stranger.status).toBe(404);

      const restricted = browser(onlyA, elsewhere.page_id as string);
      await restricted.join();
      expect([403, 404]).toContain(restricted.status);
      expect(await activeClaims(id)).toHaveLength(0);
    });

    it('is ended for everybody when who may see the space changes, and only members come back', async () => {
      const created = await create(editor, 'CLA', 'Access changed', 'x');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'x', 'seed');
      const lee = browser(editor, id);
      await lee.join();
      await lee.type(1, ' unsaved');
      await settle(() => dana.text === 'x unsaved');

      const { setSpaceMembers } = await import('@/lib/spaces/visibility');
      const { updateSpace } = await import('@/lib/spaces/service');
      const actor = { type: 'user' as const, id: admin.userId };
      await setSpaceMembers({ workspaceId, spaceId: rvaId, actor, userIds: [] });
      await updateSpace({ workspaceId, spaceId: rvaId, actor, restricted: true });
      try {
        // The room is gone and with it both streams; nothing typed was lost.
        expect(collabRooms.roomParticipants(id)).toEqual([]);

        // The editor is not a member and cannot come back; the administrator can,
        // and finds the text as it was left.
        const leeAgain = browser(editor, id);
        await leeAgain.join();
        expect(leeAgain.status).toBe(404);
        const danaAgain = browser(admin, id);
        const hello = await danaAgain.join();
        expect(hello?.data).toMatchObject({ seeded: true, unsaved: true });
        expect(danaAgain.text).toBe('x unsaved');
      } finally {
        await updateSpace({ workspaceId, spaceId: rvaId, actor, restricted: false });
      }
    });

    it('takes messages only from a browser that joined, as the person who joined', async () => {
      const created = await create(editor, 'CLA', 'Not joined', 'x');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'x', 'seed');

      const ghost = browser(editor, id);
      expect((await ghost.type(0, 'y')).status).toBe(404);
      // Dana's client id, presented by somebody else who may see the page.
      expect((await dana.post({ kind: 'update', update: b64(Y.encodeStateAsUpdate(dana.doc)) }, editor)).status).toBe(404);
      expect((await dana.post({ kind: 'save', body: 'stolen\n', state_vector: 'AA==' }, editor)).status).toBe(404);
      expect(dana.text).toBe('x');
    });

    it('validates what it is sent', async () => {
      const created = await create(editor, 'CLA', 'Validation', 'x');
      const id = created.page_id as string;
      const dana = browser(admin, id);
      await dana.join();
      await dana.type(0, 'x', 'seed');

      expect((await dana.post({ kind: 'update', update: 'not base64 !!' })).status).toBe(400);
      expect((await dana.post({ kind: 'update', update: b64(new Uint8Array([9, 9, 9, 9])) })).status).toBe(400);
      expect((await dana.post({ kind: 'teleport' })).status).toBe(400);
      expect((await dana.post({ kind: 'update', update: 'AA==', extra: 1 })).status).toBe(400);
      expect(dana.text).toBe('x');
      // And the room still works afterwards.
      expect((await dana.type(1, 'y')).status).toBe(200);
    });
  });
});
