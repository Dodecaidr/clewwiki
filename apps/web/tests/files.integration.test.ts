import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';
import type * as DrizzleOrm from 'drizzle-orm';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping file suite: ${probe.reason}`);
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
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const bytesOf = (value: string) => new TextEncoder().encode(value);
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!probe.reachable)('files on pages', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let filesDir = '';

  const suiteTag = `files-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let admin: TestAccount;
  let author: TestAccount;
  let other: TestAccount;
  let viewer: TestAccount;
  const userIds: string[] = [];
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

  function put(
    caller: Caller,
    page: string,
    name: string,
    bytes: Uint8Array,
    options: { note?: string; headers?: Record<string, string | null>; method?: string } = {},
  ) {
    const headers: Record<string, string> = {
      ...credentials(caller),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
    };
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (value === null) delete headers[key];
      else headers[key] = value;
    }
    const query = options.note === undefined ? '' : `?note=${encodeURIComponent(options.note)}`;
    const method = options.method ?? 'PUT';
    const request = new Request(`${BASE}/api/v1/pages/${page}/files/${encodeURIComponent(name)}${query}`, {
      method,
      headers,
      body: bytes.slice().buffer as ArrayBuffer,
    });
    return run('pages/[id]/files/[name]', 'PUT', request, { id: page, name });
  }

  function download(caller: Caller, page: string, name: string, query = '', extra: Record<string, string> = {}) {
    const request = new Request(`${BASE}/api/v1/pages/${page}/files/${encodeURIComponent(name)}${query}`, {
      headers: { ...credentials(caller), ...extra },
    });
    return run('pages/[id]/files/[name]', 'GET', request, { id: page, name });
  }

  async function makePage(space: string, title: string, caller: Caller): Promise<string> {
    const made = await json('pages', 'POST', caller, '/api/v1/pages', {}, { space, title, body: `${title}\n` });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.page_id as string;
  }

  async function seedToken(name: string, scopes: string[]): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({ workspaceId, name, prefix: generated.prefix, tokenHash: generated.tokenHash, scopes, spaceIds: null });
    return generated.token;
  }

  async function inbox(caller: Caller): Promise<JsonRecord[]> {
    const answer = await run('inbox', 'GET', new Request(`${BASE}/api/v1/inbox?unread=false`, { headers: credentials(caller) }), {});
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body.items as JsonRecord[];
  }

  beforeAll(async () => {
    filesDir = await mkdtemp(path.join(tmpdir(), 'clewwiki-files-it-'));
    process.env.FILES_DRIVER = 'local';
    process.env.FILES_DIR = filesDir;

    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    const [workspace] = await db.insert(schema.workspaces).values({ name: `Files ${suiteTag}`, slug: `${suiteTag}-ws` }).returning();
    workspaceId = workspace!.id;
    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: `${suiteTag}-a` });
    author = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: `${suiteTag}-w` });
    other = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: `${suiteTag}-o` });
    viewer = await createTestAccount({ db, schema, workspaceId, role: 'viewer', tag: `${suiteTag}-v` });
    userIds.push(admin.userId, author.userId, other.userId, viewer.userId);

    for (const key of ['REL', 'VAULT']) {
      await db.insert(schema.spaces).values({ workspaceId, key, name: key });
    }
    writerToken = await seedToken('ci-publisher', ['pages:read', 'pages:write']);
    deleterToken = await seedToken('deleter', ['pages:read', 'pages:write', 'pages:delete']);
    readerToken = await seedToken('reader', ['pages:read']);
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    delete process.env.FILES_STORE_MAX_MB;
    delete process.env.FILES_MAX_UPLOAD_MB;
    delete process.env.FILES_DRIVER;
    delete process.env.FILES_DIR;
    const { eq, inArray } = drizzle;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await rm(filesDir, { recursive: true, force: true });
  });

  it('keeps a file in versions under one name, whatever its case, and one address', async () => {
    const page = await makePage('REL', 'Release 1.0', author);
    const first = bytesOf('build one');

    const made = await put(writerToken, page, 'app-1.0.zip', first, { note: 'Первая сборка' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({
      name: 'app-1.0.zip',
      latest_version: 1,
      bytes: first.byteLength,
      sha256: sha(first),
      content_type: 'application/zip',
      url: `/api/v1/pages/${page}/files/app-1.0.zip`,
    });
    expect(made.body.version).toMatchObject({ version: 1, note: 'Первая сборка', created_by: { type: 'agent', label: 'ci-publisher' } });

    // The same bytes again add nothing.
    const again = await put(writerToken, page, 'app-1.0.zip', first);
    expect(again.status).toBe(200);
    expect(again.body.latest_version).toBe(1);

    // New bytes under the same name in another case are the next version.
    const second = bytesOf('build two, fixed');
    const next = await put(author, page, 'APP-1.0.ZIP', second);
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.file_id).toBe(made.body.file_id);
    expect(next.body.name).toBe('app-1.0.zip');
    expect(next.body.latest_version).toBe(2);

    const listed = await json('pages/[id]/files', 'GET', readerToken, `/api/v1/pages/${page}/files`, { id: page });
    expect(listed.body.uploads_enabled).toBe(true);
    expect(listed.body.files.map((file: JsonRecord) => [file.name, file.latest_version])).toEqual([['app-1.0.zip', 2]]);

    const history = await json('files/[fileId]', 'GET', other, `/api/v1/files/${made.body.file_id}`, { fileId: made.body.file_id });
    expect(history.body.versions.map((version: JsonRecord) => version.version)).toEqual([2, 1]);

    const latest = await download(other, page, 'app-1.0.zip');
    expect(latest.status).toBe(200);
    expect(new TextDecoder().decode(latest.bytes)).toBe('build two, fixed');
    expect(latest.headers.get('x-file-version')).toBe('2');

    const old = await download(other, page, 'App-1.0.zip', '?version=1');
    expect(new TextDecoder().decode(old.bytes)).toBe('build one');
    expect((await download(other, page, 'app-1.0.zip', '?version=9')).status).toBe(404);
    expect((await download(other, page, 'app-1.0.zip', '?version=zero')).status).toBe(400);
  });

  it('serves a file only as a fenced-in download, and resumes a range', async () => {
    const page = await makePage('REL', 'Fenced', author);
    const html = bytesOf('<!doctype html><script>alert(1)</script>');
    const made = await put(author, page, 'Отчёт "Q3".html', html, { headers: { 'Content-Type': 'text/html' } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);

    const served = await download(other, page, 'Отчёт "Q3".html');
    expect(served.status).toBe(200);
    expect(served.headers.get('content-disposition')).toBe(
      `attachment; filename="_____ _Q3_.html"; filename*=UTF-8''${encodeURIComponent('Отчёт "Q3".html')}`,
    );
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(served.headers.get('cross-origin-resource-policy')).toBe('same-origin');

    const cached = await download(other, page, 'Отчёт "Q3".html', '', { 'If-None-Match': served.headers.get('etag')! });
    expect(cached.status).toBe(304);

    const part = await download(other, page, 'Отчёт "Q3".html', '', { Range: 'bytes=2-8' });
    expect(part.status).toBe(206);
    expect(new TextDecoder().decode(part.bytes)).toBe('doctype');
    expect(part.headers.get('content-range')).toBe(`bytes 2-8/${html.byteLength}`);

    const tail = await download(other, page, 'Отчёт "Q3".html', '', { Range: 'bytes=-9' });
    expect(new TextDecoder().decode(tail.bytes)).toBe('</script>');

    const outside = await download(other, page, 'Отчёт "Q3".html', '', { Range: 'bytes=9999-' });
    expect(outside.status).toBe(416);
  });

  it('refuses bad names, empty and oversized uploads, and long notes', async () => {
    const page = await makePage('REL', 'Refusals', author);
    expect((await put(author, page, '../etc/passwd', bytesOf('x'))).status).toBe(400);
    expect((await put(author, page, 'bidi\u202efdp.exe', bytesOf('x'))).status).toBe(400);
    expect((await put(author, page, 'empty.txt', new Uint8Array(0))).status).toBe(400);
    expect((await put(author, page, 'no-length.txt', bytesOf('x'), { headers: { 'Content-Length': null } })).status).toBe(411);
    expect((await put(author, page, 'note.txt', bytesOf('x'), { note: 'я'.repeat(1001) })).status).toBe(400);

    process.env.FILES_MAX_UPLOAD_MB = '1';
    const big = new Uint8Array(1024 * 1024 + 1);
    expect((await put(author, page, 'big.bin', big)).status).toBe(413);
    // A body that declares less than it sends is stopped while it is read.
    expect((await put(author, page, 'liar.bin', big, { headers: { 'Content-Length': '10' } })).status).toBe(413);
    delete process.env.FILES_MAX_UPLOAD_MB;

    // A body that ends before the size it declared was cut off on the way,
    // and a cut-off file is refused rather than stored.
    const short = await put(author, page, 'short.bin', bytesOf('ten bytes!'), { headers: { 'Content-Length': '100' } });
    expect(short.status).toBe(400);
    expect(short.body.error.details).toMatchObject({ declared_bytes: 100, received_bytes: 10 });

    expect(await readdir(path.join(filesDir, 'staging'))).toEqual([]);
    expect((await json('pages/[id]/files', 'GET', author, `/api/v1/pages/${page}/files`, { id: page })).body.files).toEqual([]);
  });

  it('lets only those who may write upload, and only from this origin', async () => {
    const page = await makePage('REL', 'Who uploads', author);
    expect((await put(readerToken, page, 'a.txt', bytesOf('a'))).status).toBe(403);
    expect((await put(viewer, page, 'a.txt', bytesOf('a'))).status).toBe(403);
    expect((await put(author, page, 'a.txt', bytesOf('a'), { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await put(author, page, 'a.txt', bytesOf('a'), { headers: { origin: null } })).status).toBe(403);
    expect((await put(author, page, 'a.txt', bytesOf('a'), { method: 'POST' })).status).toBe(403);
    expect((await put(author, page, 'a.txt', bytesOf('a'))).status).toBe(201);
    expect((await download(viewer, page, 'a.txt')).status).toBe(200);
  });

  it('goes back to an old version by adding it again', async () => {
    const page = await makePage('REL', 'Rollback', author);
    const good = bytesOf('good build');
    const made = await put(author, page, 'app.apk', good);
    await put(author, page, 'app.apk', bytesOf('broken build'));
    const fileId = made.body.file_id as string;

    const restored = await json('files/[fileId]/restore', 'POST', writerToken, `/api/v1/files/${fileId}/restore`, { fileId }, { version: 1 });
    expect(restored.status, JSON.stringify(restored.body)).toBe(201);
    expect(restored.body.latest_version).toBe(3);
    expect(restored.body.version).toMatchObject({ version: 3, restored_from: 1, sha256: sha(good), note: 'Restored version 1' });
    expect(new TextDecoder().decode((await download(other, page, 'app.apk')).bytes)).toBe('good build');

    const noop = await json('files/[fileId]/restore', 'POST', writerToken, `/api/v1/files/${fileId}/restore`, { fileId }, { version: 1 });
    expect(noop.status).toBe(200);
    expect(noop.body.latest_version).toBe(3);

    const missing = await json('files/[fileId]/restore', 'POST', writerToken, `/api/v1/files/${fileId}/restore`, { fileId }, { version: 7 });
    expect(missing.status).toBe(404);
    expect((await json('files/[fileId]/restore', 'POST', readerToken, `/api/v1/files/${fileId}/restore`, { fileId }, { version: 2 })).status).toBe(403);
  });

  it('counts each content once against the store, and can be switched off', async () => {
    const page = await makePage('REL', 'Quota', author);
    const { eq } = drizzle;
    const [usage] = await db
      .select({ used: drizzle.sql<string>`coalesce(sum(${schema.fileBlobs.byteSize}), 0)` })
      .from(schema.fileBlobs)
      .where(eq(schema.fileBlobs.workspaceId, workspaceId));
    const used = Number(usage?.used ?? 0);
    const MB = 1024 * 1024;
    const limitMb = Math.floor(used / MB) + 1;
    // What is left under the limit takes one of these and not two.
    const size = Math.ceil((limitMb * MB - used) * 0.6);

    process.env.FILES_STORE_MAX_MB = String(limitMb);
    const half = (seed: string) => {
      const out = new Uint8Array(size);
      out.set(bytesOf(seed));
      return out;
    };
    expect((await put(author, page, 'a.bin', half('a'))).status).toBe(201);
    const full = await put(author, page, 'b.bin', half('b'));
    expect(full.status).toBe(409);
    // The same bytes under another name cost nothing.
    expect((await put(author, page, 'a-copy.bin', half('a'))).status).toBe(201);
    delete process.env.FILES_STORE_MAX_MB;

    process.env.FILES_DRIVER = 'off';
    expect((await put(author, page, 'c.bin', bytesOf('c'))).status).toBe(403);
    const listed = await json('pages/[id]/files', 'GET', author, `/api/v1/pages/${page}/files`, { id: page });
    expect(listed.body.uploads_enabled).toBe(false);
    expect(listed.body.files).toHaveLength(2);
    process.env.FILES_DRIVER = 'local';
  });

  it('tells whoever watches the page or its space, and nobody else', async () => {
    const page = await makePage('REL', 'Release 2.0', author);
    const watchPage = await json('watches', 'POST', other, '/api/v1/watches', {}, { page_id: page });
    expect(watchPage.status, JSON.stringify(watchPage.body)).toBe(201);
    expect((await json('watches', 'POST', other, '/api/v1/watches', {}, { page_id: page })).status).toBe(200);

    expect((await json('watches', 'POST', readerToken, '/api/v1/watches', {}, { space: 'rel' })).status).toBe(201);
    expect((await json('watches', 'POST', readerToken, '/api/v1/watches', {}, { space: 'NOPE' })).status).toBe(404);
    expect((await json('watches', 'POST', viewer, '/api/v1/watches', {}, { page_id: page })).status).toBe(201);
    expect((await json('watches', 'POST', other, '/api/v1/watches', {}, { page_id: randomUUID() })).status).toBe(404);

    const made = await put(writerToken, page, 'app-2.0.dmg', bytesOf('two'), { note: 'Signed build' });
    await put(author, page, 'app-2.0.dmg', bytesOf('two, notarized'));

    const theirs = (await inbox(other)).filter((item) => item.kind === 'file.version');
    expect(theirs.map((item) => [item.file.name, item.file.version, item.by.label])).toEqual([
      ['app-2.0.dmg', 2, `editor ${suiteTag}-w`],
      ['app-2.0.dmg', 1, 'ci-publisher'],
    ]);
    expect(theirs[1]!).toMatchObject({ title: 'Release 2.0', excerpt: 'Signed build', page_id: page, space: 'REL' });
    expect(theirs[0]!.url).toBe(`/spaces/REL/pages/${page}#file-${made.body.file_id}`);

    // The space watcher hears of both; the uploader is not told of their own.
    // The space's other files are news to it too; this page's are two of them.
    const readers = (await inbox(readerToken)).filter((item) => item.kind === 'file.version' && item.page_id === page);
    expect(readers).toHaveLength(2);
    const publishers = (await inbox(writerToken)).filter((item) => item.kind === 'file.version');
    expect(publishers).toHaveLength(0);
    expect((await inbox(viewer)).filter((item) => item.kind === 'file.version')).toHaveLength(2);

    const listed = await json('watches', 'GET', other, '/api/v1/watches');
    expect(listed.body.watches).toEqual([expect.objectContaining({ kind: 'page', page_id: page, title: 'Release 2.0', space: 'REL' })]);
    const spaceWatch = await json('watches', 'GET', readerToken, '/api/v1/watches');
    expect(spaceWatch.body.watches).toEqual([expect.objectContaining({ kind: 'space', page_id: null, title: 'REL', space: 'REL' })]);

    const stopped = await json('watches', 'DELETE', other, '/api/v1/watches', {}, { page_id: page });
    expect(stopped.body).toMatchObject({ watching: false, removed: true });
    await put(author, page, 'app-2.0.dmg', bytesOf('two, again'));
    expect((await inbox(other)).filter((item) => item.kind === 'file.version')).toHaveLength(0);
  });

  it('is as visible as its page, and goes with it', async () => {
    const page = await makePage('VAULT', 'Secret build', author);
    const made = await put(author, page, 'secret.bin', bytesOf('secret'));
    const fileId = made.body.file_id as string;

    expect((await json('watches', 'POST', other, '/api/v1/watches', {}, { page_id: page })).status).toBe(201);
    await json('spaces/[key]/members', 'PUT', admin, '/api/v1/spaces/VAULT/members', { key: 'VAULT' }, { user_ids: [author.userId] });
    expect((await json('spaces/[key]', 'PATCH', admin, '/api/v1/spaces/VAULT', { key: 'VAULT' }, { restricted: true })).status).toBe(200);

    expect((await download(other, page, 'secret.bin')).status).toBe(404);
    expect((await json('files/[fileId]', 'GET', other, `/api/v1/files/${fileId}`, { fileId })).status).toBe(404);
    expect((await put(other, page, 'secret.bin', bytesOf('overwrite'))).status).toBe(404);
    await put(author, page, 'secret.bin', bytesOf('secret v2'));
    expect((await inbox(other)).filter((item) => item.page_id === page)).toHaveLength(0);
    expect((await download(author, page, 'secret.bin')).status).toBe(200);

    expect((await json('pages/[id]', 'DELETE', admin, `/api/v1/pages/${page}`, { id: page })).status).toBe(200);
    expect((await json('files/[fileId]', 'GET', author, `/api/v1/files/${fileId}`, { fileId })).status).toBe(404);
  });

  it('removes a file for good, and its bytes once nothing else holds them', async () => {
    const page = await makePage('REL', 'Oops', author);
    const secret = bytesOf('a password in a config file');
    const shared = bytesOf('shared bytes');
    const made = await put(author, page, 'config.yml', secret);
    await put(author, page, 'config.yml', shared);
    await put(author, page, 'keep.txt', shared);
    const fileId = made.body.file_id as string;
    const target = `/api/v1/files/${fileId}`;

    expect((await json('files/[fileId]', 'DELETE', writerToken, target, { fileId })).status).toBe(403);
    expect((await json('files/[fileId]', 'DELETE', deleterToken, target, { fileId })).status).toBe(200);
    expect((await download(author, page, 'config.yml')).status).toBe(404);
    expect((await json('files/[fileId]', 'DELETE', deleterToken, target, { fileId })).status).toBe(404);

    const { sweepFileBlobs } = await import('@/lib/files/sweep');
    const blobPath = (value: Uint8Array) => {
      const hash = sha(value);
      return path.join(filesDir, 'blobs', workspaceId, hash.slice(0, 2), hash);
    };
    const exists = async (file: string) =>
      readdir(path.dirname(file)).then((names) => names.includes(path.basename(file)), () => false);

    // Not straight away: an hour's grace for an upload of the same bytes.
    await sweepFileBlobs(new Date());
    expect(await exists(blobPath(secret))).toBe(true);

    await sweepFileBlobs(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(await exists(blobPath(secret))).toBe(false);
    expect(await exists(blobPath(shared))).toBe(true);
    expect(new TextDecoder().decode((await download(author, page, 'keep.txt')).bytes)).toBe('shared bytes');

    const { and, eq } = drizzle;
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.workspaceId, workspaceId), eq(schema.auditLog.target, fileId)));
    expect(audit.map((row) => row.action).sort()).toEqual(['file.deleted', 'file.version_added', 'file.version_added']);
  });

  it('turns two uploads of one new name at once into two versions', async () => {
    const page = await makePage('REL', 'Race', author);
    const [a, b] = await Promise.all([
      put(author, page, 'race.txt', bytesOf('one')),
      put(writerToken, page, 'RACE.txt', bytesOf('two')),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.file_id).toBe(b.body.file_id);
    expect([a.body.latest_version, b.body.latest_version].sort()).toEqual([1, 2]);
  });

  it('hands out version numbers one at a time when a restore and uploads race', async () => {
    const page = await makePage('REL', 'Busy', author);
    const made = await put(author, page, 'busy.bin', bytesOf('v1'));
    await put(author, page, 'busy.bin', bytesOf('v2'));
    const fileId = made.body.file_id as string;

    const answers = await Promise.all([
      json('files/[fileId]/restore', 'POST', writerToken, `/api/v1/files/${fileId}/restore`, { fileId }, { version: 1 }),
      put(author, page, 'busy.bin', bytesOf('v3')),
      put(writerToken, page, 'busy.bin', bytesOf('v4')),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([201, 201, 201]);
    const history = await json('files/[fileId]', 'GET', author, `/api/v1/files/${fileId}`, { fileId });
    expect(history.body.versions.map((version: JsonRecord) => version.version)).toEqual([5, 4, 3, 2, 1]);
  });

  it('does not let uploads side by side each find room in the store', async () => {
    const page = await makePage('REL', 'Crowd', author);
    const { eq } = drizzle;
    const [usage] = await db
      .select({ used: drizzle.sql<string>`coalesce(sum(${schema.fileBlobs.byteSize}), 0)` })
      .from(schema.fileBlobs)
      .where(eq(schema.fileBlobs.workspaceId, workspaceId));
    const used = Number(usage?.used ?? 0);
    const MB = 1024 * 1024;
    const limitMb = Math.floor(used / MB) + 1;
    const size = Math.ceil((limitMb * MB - used) * 0.6);
    process.env.FILES_STORE_MAX_MB = String(limitMb);
    try {
      const body = (seed: string) => {
        const out = new Uint8Array(size);
        out.set(bytesOf(seed));
        return out;
      };
      const answers = await Promise.all(['p', 'q', 'r', 's'].map((seed) => put(author, page, `${seed}.bin`, body(seed))));
      expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409, 409, 409]);
    } finally {
      delete process.env.FILES_STORE_MAX_MB;
    }
  });

  it('removes a blob the database never heard of, and keeps one it knows', async () => {
    const orphan = bytesOf('written by a transaction that rolled back');
    const hash = sha(orphan);
    const dir = path.join(filesDir, 'blobs', workspaceId, hash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, hash), orphan);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(path.join(dir, hash), old, old);

    const page = await makePage('REL', 'Kept', author);
    const kept = bytesOf('a file somebody has');
    await put(author, page, 'kept.txt', kept);
    const keptHash = sha(kept);
    const keptPath = path.join(filesDir, 'blobs', workspaceId, keptHash.slice(0, 2), keptHash);
    await utimes(keptPath, old, old);

    const { sweepFileBlobs } = await import('@/lib/files/sweep');
    const swept = await sweepFileBlobs(new Date());
    expect(swept.orphans).toBeGreaterThanOrEqual(1);
    expect(await readdir(dir).then((names) => names.includes(hash))).toBe(false);
    expect(new TextDecoder().decode((await download(author, page, 'kept.txt')).bytes)).toBe('a file somebody has');
    const rows = await db
      .select()
      .from(schema.fileBlobs)
      .where(drizzle.and(drizzle.eq(schema.fileBlobs.workspaceId, workspaceId), drizzle.eq(schema.fileBlobs.sha256, hash)));
    expect(rows).toEqual([]);
  });

  it('exports a space with the latest version of every file beside its page, streamed', async () => {
    const page = await makePage('REL', 'Exported release', author);
    await put(author, page, 'app.bin', bytesOf('old build'));
    const latest = new Uint8Array(300 * 1024).map((_, index) => index % 251);
    await put(author, page, 'app.bin', latest);
    await put(author, page, 'Отчёт.txt', bytesOf('report'));

    const response = await run(
      'spaces/[key]/export',
      'GET',
      new Request(`${BASE}/api/v1/spaces/REL/export?files=latest`, { headers: credentials(readerToken) }),
      { key: 'REL' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="REL-with-files.zip"');

    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(filesDir, 'export.zip'), response.bytes);
    const { readZip } = await import('@clewwiki/import');
    const entries = readZip(response.bytes, { limits: { expandedBytes: 64 * 1024 * 1024, zipEntries: 10_000 } });
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));
    const pagePath = [...byName.keys()].find((name) => name.endsWith('exported-release.md'))!;
    const folder = pagePath.replace(/\.md$/, '.files');
    expect(sha(byName.get(`${folder}/app.bin`)!)).toBe(sha(latest));
    expect(new TextDecoder().decode(byName.get(`${folder}/Отчёт.txt`)!)).toBe('report');

    const manifest = JSON.parse(new TextDecoder().decode(byName.get('REL/_files.json')!)) as JsonRecord;
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ path: `${folder}/app.bin`, version: 2, sha256: sha(latest), bytes: latest.byteLength }),
    );
    expect(manifest.left_out).toEqual([]);

    const plain = await run(
      'spaces/[key]/export',
      'GET',
      new Request(`${BASE}/api/v1/spaces/REL/export`, { headers: credentials(readerToken) }),
      { key: 'REL' },
    );
    const plainNames = readZip(plain.bytes, { limits: { expandedBytes: 64 * 1024 * 1024, zipEntries: 10_000 } }).map((entry) => entry.name);
    expect(plainNames.some((name) => name.includes('.files/'))).toBe(false);
  });

  it('tells whoever watches a page of its changes, one line however many there were', async () => {
    const page = await makePage('REL', 'Watched text', author);
    expect((await json('watches', 'POST', other, '/api/v1/watches', {}, { page_id: page })).status).toBe(201);

    async function write(body: string) {
      const current = await json('pages/[id]', 'GET', writerToken, `/api/v1/pages/${page}`, { id: page });
      const claim = await json('pages/[id]/claims', 'POST', writerToken, `/api/v1/pages/${page}/claims`, { id: page }, {});
      const written = await json('pages/[id]', 'PATCH', writerToken, `/api/v1/pages/${page}`, { id: page }, {
        body,
        claim_id: claim.body.claim_id,
        base_content_hash: current.body.content_hash,
      });
      expect(written.status, JSON.stringify(written.body)).toBe(200);
      await json('claims/[claimId]', 'DELETE', writerToken, `/api/v1/claims/${claim.body.claim_id}`, { claimId: claim.body.claim_id });
    }
    await write('First change\n');
    await write('Second change\n');

    const theirs = (await inbox(other)).filter((item) => item.kind === 'page.updated' && item.page_id === page);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ title: 'Watched text', by: { type: 'agent', label: 'ci-publisher' }, changes: { count: 2, version: 3 } });

    // Nobody hears of their own changes, and a space watch is for files only.
    expect((await inbox(writerToken)).filter((item) => item.kind === 'page.updated' && item.page_id === page)).toEqual([]);
    expect((await inbox(readerToken)).filter((item) => item.kind === 'page.updated' && item.page_id === page)).toEqual([]);
  });
});
