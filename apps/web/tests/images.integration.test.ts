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
  console.warn(`[integration] skipping image suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '10000';
process.env.DISCUSSION_MESSAGE_RATE_LIMIT_MAX = '10000';
process.env.IMAGE_UPLOAD_RATE_LIMIT_MAX = '10000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;
type Caller = string | TestAccount;
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes that start as a PNG and are otherwise unique to `seed`. */
function png(seed: string, size = 64): Uint8Array {
  const out = new Uint8Array(Math.max(size, 16 + seed.length));
  out.set(PNG_SIGNATURE, 0);
  out.set(new TextEncoder().encode(seed), 12);
  return out;
}

describe.skipIf(!probe.reachable)('images in pages', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  const suiteTag = `img-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let admin: TestAccount;
  let author: TestAccount;
  let other: TestAccount;
  const userIds: string[] = [];
  const spaceIds: Record<string, string> = {};
  let writerToken = '';
  let deleterToken = '';
  let readerToken = '';

  type Answer = { status: number; body: JsonRecord; headers: Headers; bytes: Uint8Array };

  function credentials(caller: Caller): Record<string, string> {
    return typeof caller === 'string' ? { Authorization: `Bearer ${caller}` } : { cookie: caller.cookie, origin: BASE };
  }

  async function run(module: string, method: string, request: Request, params: Record<string, string>): Promise<Answer> {
    const route = (await import(/* @vite-ignore */ `@/app/api/v1/${module}/route`)) as Record<string, Handler>;
    const response = await route[method]!(request, { params: Promise.resolve(params) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let body: JsonRecord = {};
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as JsonRecord;
    } catch {
      body = {};
    }
    return { status: response.status, body, headers: response.headers, bytes };
  }

  function json(module: string, method: string, caller: Caller, target: string, params: Record<string, string> = {}, payload?: unknown) {
    const headers = { ...credentials(caller), 'Content-Type': 'application/json' };
    return run(module, method, new Request(`${BASE}${target}`, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), params);
  }

  function upload(
    caller: Caller,
    where: { page: string } | { space: string },
    bytes: Uint8Array,
    overrides: Record<string, string | null> = {},
  ) {
    const headers: Record<string, string> = {
      ...credentials(caller),
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
    };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) delete headers[name];
      else headers[name] = value;
    }
    const request = (target: string) => new Request(`${BASE}${target}`, { method: 'POST', headers, body: bytes.slice().buffer as ArrayBuffer });
    return 'page' in where
      ? run('pages/[id]/images', 'POST', request(`/api/v1/pages/${where.page}/images`), { id: where.page })
      : run('spaces/[key]/images', 'POST', request(`/api/v1/spaces/${where.space}/images`), { key: where.space });
  }

  function fetchImage(caller: Caller, imageId: string, extra: Record<string, string> = {}) {
    return run('images/[imageId]', 'GET', new Request(`${BASE}/api/v1/images/${imageId}`, { headers: { ...credentials(caller), ...extra } }), { imageId });
  }

  async function makePage(space: string, title: string, caller: Caller, body = `${title}\n`): Promise<string> {
    const made = await json('pages', 'POST', caller, '/api/v1/pages', {}, { space, title, body });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.page_id as string;
  }

  async function seedToken(name: string, scopes: string[]): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({ workspaceId, name, prefix: generated.prefix, tokenHash: generated.tokenHash, scopes, spaceIds: null });
    return generated.token;
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    const [workspace] = await db.insert(schema.workspaces).values({ name: `Images ${suiteTag}`, slug: `${suiteTag}-ws` }).returning();
    workspaceId = workspace!.id;
    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: `${suiteTag}-a` });
    author = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: `${suiteTag}-w` });
    other = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: `${suiteTag}-o` });
    userIds.push(admin.userId, author.userId, other.userId);

    for (const key of ['DOCS', 'VAULT']) {
      const [row] = await db.insert(schema.spaces).values({ workspaceId, key, name: key }).returning();
      spaceIds[key] = row!.id;
    }
    writerToken = await seedToken('writer', ['pages:read', 'pages:write']);
    deleterToken = await seedToken('deleter', ['pages:read', 'pages:write', 'pages:delete']);
    readerToken = await seedToken('reader', ['pages:read']);
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    delete process.env.IMAGE_MAX_UPLOAD_MB;
    delete process.env.IMAGE_STORE_MAX_MB;
    const { eq, inArray } = drizzle;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  });

  it('stores an upload and serves it back as what its bytes are, fenced in', async () => {
    const page = await makePage('DOCS', 'With a picture', author);
    const picture = png('first');

    const made = await upload(author, { page }, picture);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.url).toBe(`/api/v1/images/${made.body.image_id}`);
    expect(made.body.content_type).toBe('image/png');
    expect(made.body.bytes).toBe(picture.byteLength);
    expect(made.body.page_id).toBe(page);

    const served = await fetchImage(other, made.body.image_id);
    expect(served.status).toBe(200);
    expect([...served.bytes]).toEqual([...picture]);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(served.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(served.headers.get('cache-control')).toBe('private, no-cache');

    const again = await fetchImage(other, made.body.image_id, { 'If-None-Match': served.headers.get('etag')! });
    expect(again.status).toBe(304);
    expect(again.bytes.byteLength).toBe(0);

    // The same screenshot pasted twice is one image.
    const twice = await upload(author, { page }, picture);
    expect(twice.status).toBe(200);
    expect(twice.body.image_id).toBe(made.body.image_id);

    const listed = await json('pages/[id]/images', 'GET', readerToken, `/api/v1/pages/${page}/images`, { id: page });
    expect(listed.body.images.map((image: JsonRecord) => image.image_id)).toEqual([made.body.image_id]);
  });

  it('takes the type from the bytes, never from what was declared', async () => {
    const page = await makePage('DOCS', 'Not pictures', author);
    const text = (value: string) => new TextEncoder().encode(value);

    const html = await upload(author, { page }, text('<!doctype html><script>alert(1)</script>'));
    expect(html.status).toBe(400);
    const svg = await upload(author, { page }, text('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'));
    expect(svg.status).toBe(400);
    const empty = await upload(writerToken, { page }, new Uint8Array(0));
    expect(empty.status).toBe(400);

    // A JPEG declared as a PNG is stored, and served, as the JPEG it is.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const mislabelled = await upload(writerToken, { page }, jpeg);
    expect(mislabelled.status).toBe(201);
    expect(mislabelled.body.content_type).toBe('image/jpeg');
    expect((await fetchImage(writerToken, mislabelled.body.image_id)).headers.get('content-type')).toBe('image/jpeg');
  });

  it('refuses an upload by its declared size, and one that declares none', async () => {
    const page = await makePage('DOCS', 'Sizes', author);
    const small = png('sizes');
    expect((await upload(author, { page }, small, { 'Content-Length': String(50 * 1024 * 1024) })).status).toBe(413);
    expect((await upload(author, { page }, small, { 'Content-Length': null })).status).toBe(411);

    process.env.IMAGE_MAX_UPLOAD_MB = '1';
    const big = png('too big', 1024 * 1024 + 1);
    // Declared honestly, and declared smaller than it is: both stop at the limit.
    expect((await upload(author, { page }, big)).status).toBe(413);
    expect((await upload(author, { page }, big, { 'Content-Length': '100' })).status).toBe(413);
    delete process.env.IMAGE_MAX_UPLOAD_MB;
  });

  it('is refused across origins, as JSON, and without the scope to write', async () => {
    const page = await makePage('DOCS', 'Who may upload', author);
    const picture = png('who');
    expect((await upload(author, { page }, picture, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await upload(author, { page }, picture, { origin: null })).status).toBe(403);
    expect((await upload(author, { page }, picture, { 'Content-Type': 'multipart/form-data; boundary=x' })).status).toBe(403);
    expect((await upload(readerToken, { page }, picture)).status).toBe(403);
    expect((await upload(writerToken, { page: randomUUID() }, picture)).status).toBe(404);
  });

  it('keeps an image for a page that does not exist yet to its uploader, and hands it to the page', async () => {
    const waiting = await upload(author, { space: 'DOCS' }, png('for a new page'));
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(201);
    expect(waiting.body.page_id).toBeNull();
    const imageId = waiting.body.image_id as string;

    expect((await fetchImage(author, imageId)).status).toBe(200);
    expect((await fetchImage(other, imageId)).status).toBe(404);
    expect((await fetchImage(admin, imageId)).status).toBe(404);

    // Somebody else's page naming it attaches nothing.
    await makePage('DOCS', 'Not the author', other, `![x](/api/v1/images/${imageId})\n`);
    expect((await fetchImage(other, imageId)).status).toBe(404);

    const page = await makePage('DOCS', 'The new page', author, `Look:\n\n![shot](/api/v1/images/${imageId})\n`);
    const { eq } = drizzle;
    const [row] = await db.select().from(schema.pageImages).where(eq(schema.pageImages.id, imageId));
    expect(row!.pageId).toBe(page);
    expect((await fetchImage(other, imageId)).status).toBe(200);
  });

  it('sweeps an image no page claimed within a day, and only that', async () => {
    const stale = await upload(author, { space: 'DOCS' }, png('stale'));
    const fresh = await upload(author, { space: 'DOCS' }, png('fresh'));
    const page = await makePage('DOCS', 'Old but attached', author);
    const attached = await upload(author, { page }, png('attached'));

    const { inArray } = drizzle;
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await db.update(schema.pageImages).set({ createdAt: twoDaysAgo }).where(inArray(schema.pageImages.id, [stale.body.image_id, attached.body.image_id]));

    const { sweepUnattachedImages } = await import('@/lib/images/sweep');
    expect((await sweepUnattachedImages()).removed).toBeGreaterThanOrEqual(1);

    expect((await fetchImage(author, stale.body.image_id)).status).toBe(404);
    expect((await fetchImage(author, fresh.body.image_id)).status).toBe(200);
    expect((await fetchImage(author, attached.body.image_id)).status).toBe(200);
  });

  it('is as visible as its page: hidden in a restricted space, following a move, gone with a delete', async () => {
    const page = await makePage('DOCS', 'Travels', author);
    const made = await upload(author, { page }, png('travels'));
    const imageId = made.body.image_id as string;
    expect((await fetchImage(other, imageId)).status).toBe(200);

    await json('spaces/[key]/members', 'PUT', admin, '/api/v1/spaces/VAULT/members', { key: 'VAULT' }, { user_ids: [author.userId] });
    expect((await json('spaces/[key]', 'PATCH', admin, '/api/v1/spaces/VAULT', { key: 'VAULT' }, { restricted: true })).status).toBe(200);
    expect((await json('pages/[id]/move', 'POST', author, `/api/v1/pages/${page}/move`, { id: page }, { space: 'VAULT' })).status).toBe(200);

    expect((await fetchImage(other, imageId)).status).toBe(404);
    expect((await fetchImage(other, imageId, { 'If-None-Match': `"${made.body.sha256}"` })).status).toBe(404);
    expect((await upload(other, { page }, png('intruder'))).status).toBe(404);
    expect((await upload(other, { space: 'VAULT' }, png('intruder'))).status).toBe(404);
    expect((await fetchImage(author, imageId)).status).toBe(200);

    expect((await json('pages/[id]', 'DELETE', admin, `/api/v1/pages/${page}`, { id: page })).status).toBe(200);
    expect((await fetchImage(author, imageId)).status).toBe(404);
  });

  it('removes an image for good, for a caller who may delete', async () => {
    const page = await makePage('DOCS', 'Oops', author);
    const made = await upload(author, { page }, png('a password on a screenshot'));
    const imageId = made.body.image_id as string;
    const target = `/api/v1/images/${imageId}`;

    expect((await json('images/[imageId]', 'DELETE', writerToken, target, { imageId })).status).toBe(403);
    expect((await json('images/[imageId]', 'DELETE', deleterToken, target, { imageId })).status).toBe(200);
    expect((await fetchImage(author, imageId)).status).toBe(404);
    expect((await json('images/[imageId]', 'DELETE', deleterToken, target, { imageId })).status).toBe(404);

    const { and, eq } = drizzle;
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.workspaceId, workspaceId), eq(schema.auditLog.target, imageId)));
    expect(audit.map((row) => row.action).sort()).toEqual(['image.deleted', 'image.uploaded']);
  });

  it('stops at the size of the store, and can be switched off', async () => {
    const page = await makePage('DOCS', 'Limits', author);
    process.env.IMAGE_STORE_MAX_MB = '1';
    expect((await upload(author, { page }, png('half a', 600 * 1024))).status).toBe(201);
    const full = await upload(author, { page }, png('half b', 600 * 1024));
    expect(full.status).toBe(409);
    delete process.env.IMAGE_STORE_MAX_MB;

    process.env.IMAGE_MAX_UPLOAD_MB = '0';
    expect((await upload(author, { page }, png('off'))).status).toBe(403);
    delete process.env.IMAGE_MAX_UPLOAD_MB;
  });

  it("puts the page's own images into its HTML export, and nobody else's", async () => {
    const elsewhere = await makePage('DOCS', 'Elsewhere', author);
    const foreign = await upload(author, { page: elsewhere }, png('foreign'));

    const page = await makePage('DOCS', 'Exported', author);
    const own = await upload(author, { page }, png('own'));
    const current = await json('pages/[id]', 'GET', author, `/api/v1/pages/${page}`, { id: page });
    const claim = await json('pages/[id]/claims', 'POST', author, `/api/v1/pages/${page}/claims`, { id: page }, {});
    const written = await json('pages/[id]', 'PATCH', author, `/api/v1/pages/${page}`, { id: page }, {
      body: `![own](${own.body.url})\n\n![foreign](${foreign.body.url})\n`,
      claim_id: claim.body.claim_id,
      base_content_hash: current.body.content_hash,
    });
    expect(written.status, JSON.stringify(written.body)).toBe(200);

    const exported = await run('export/[id]', 'GET', new Request(`${BASE}/api/v1/export/${page}?format=html`, { headers: credentials(author) }), { id: page });
    const html = new TextDecoder().decode(exported.bytes);
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).not.toContain(`src="${own.body.url}"`);
    expect(html).toContain(`src="${foreign.body.url}"`);
  });
});
