import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as SpacesRoute from '@/app/api/v1/spaces/route';
import type * as ImportsRoute from '@/app/api/v1/spaces/[key]/imports/route';
import type * as ImportRoute from '@/app/api/v1/imports/[id]/route';
import type * as ImportItemRoute from '@/app/api/v1/imports/[id]/items/[itemId]/route';
import type * as ImportApplyRoute from '@/app/api/v1/imports/[id]/apply/route';
import type * as ImportCancelRoute from '@/app/api/v1/imports/[id]/cancel/route';
import type * as ImageRoute from '@/app/api/v1/images/[imageId]/route';
import type * as PageClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';

/**
 * Images that come with an import, against a real database: judged when the
 * import is staged, held until it is applied, and then stored through the same
 * door as an upload — one copy per page that shows them, attached in the
 * transaction that creates the page, and gone from staging afterwards.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping import images suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.IMAGE_MAX_UPLOAD_MB = '1';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';
const IMAGE_HREF = /\/api\/v1\/images\/([0-9a-f-]{36})/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** A ZIP of stored entries: text or bytes. */
function buildZip(entries: ReadonlyArray<{ name: string; content: string | Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length + raw.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x0403_4b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, raw.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(raw, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x0201_4b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, raw.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x0605_4b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes the image store takes for a PNG, made distinct by a tag. */
function png(tag: number, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(PNG_SIGNATURE);
  bytes[8] = tag;
  return bytes;
}

const ARCH = png(1);

function docsZip(tag: number): Uint8Array {
  return buildZip([
    {
      name: 'docs/README.md',
      content: [
        '---',
        'title: Platform',
        '---',
        '',
        '![Architecture](img/arch.png "The whole thing")',
        '![Huge](img/huge.png)',
        '![Fake](img/fake.png)',
      ].join('\n'),
    },
    { name: 'docs/guide.md', content: '# Guide\n\nSame picture: ![Architecture](./img/arch.png)\n' },
    { name: 'docs/img/arch.png', content: tag === 1 ? ARCH : png(tag) },
    { name: 'docs/img/huge.png', content: png(2, 1024 * 1024 + 1) },
    { name: 'docs/img/fake.png', content: '<html>not a picture</html>' },
  ]);
}

describe.skipIf(!probe.reachable)('images carried by an import', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  let importsRoute: typeof ImportsRoute;
  let importRoute: typeof ImportRoute;
  let itemRoute: typeof ImportItemRoute;
  let applyRoute: typeof ImportApplyRoute;
  let cancelRoute: typeof ImportCancelRoute;
  let imageRoute: typeof ImageRoute;
  let pageClaimsRoute: typeof PageClaimsRoute;

  const suiteTag = `ii-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  let spaceKey = '';

  function cookie(account: TestAccount, target: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${target}`, {
      ...init,
      headers: { cookie: account.cookie, origin: BASE, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });
  const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

  async function json(response: Response): Promise<{ status: number; body: JsonRecord }> {
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as JsonRecord) };
  }

  async function startImport(zip: Uint8Array): Promise<{ status: number; body: JsonRecord }> {
    const form = new FormData();
    form.set('source', 'markdown');
    form.set('file', new File([zip as BlobPart], 'docs.zip', { type: 'application/zip' }));
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const request = new Request(`${BASE}/api/v1/spaces/${spaceKey}/imports`, {
      method: 'POST',
      body: bytes,
      headers: {
        cookie: admin.cookie,
        origin: BASE,
        'content-type': encoded.headers.get('content-type') ?? '',
        'content-length': String(bytes.byteLength),
      },
    });
    return json(await importsRoute.POST(request, keyParams(spaceKey)));
  }

  async function preview(importId: string): Promise<JsonRecord[]> {
    const { body } = await json(
      await importRoute.GET(cookie(admin, `/api/v1/imports/${importId}`), idParams(importId)),
    );
    return body['items'] as JsonRecord[];
  }

  async function apply(importId: string): Promise<JsonRecord> {
    const applied = await json(
      await applyRoute.POST(cookie(admin, `/api/v1/imports/${importId}/apply`, { method: 'POST' }), idParams(importId)),
    );
    expect(applied.status).toBe(200);
    return applied.body;
  }

  async function staged(importId: string): Promise<string[]> {
    const rows = await db
      .select({ key: schema.importImages.key })
      .from(schema.importImages)
      .where(drizzle.eq(schema.importImages.importId, importId));
    return rows.map((row) => row.key);
  }

  async function imagesOf(pageId: string): Promise<Array<{ id: string; byteSize: number }>> {
    return db
      .select({ id: schema.pageImages.id, byteSize: schema.pageImages.byteSize })
      .from(schema.pageImages)
      .where(drizzle.eq(schema.pageImages.pageId, pageId));
  }

  async function bodyOf(pageId: string): Promise<string> {
    const [row] = await db
      .select({ body: schema.pages.body })
      .from(schema.pages)
      .where(drizzle.eq(schema.pages.id, pageId));
    return row?.body ?? '';
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    const spacesRoute: typeof SpacesRoute = await import('@/app/api/v1/spaces/route');
    importsRoute = await import('@/app/api/v1/spaces/[key]/imports/route');
    importRoute = await import('@/app/api/v1/imports/[id]/route');
    itemRoute = await import('@/app/api/v1/imports/[id]/items/[itemId]/route');
    applyRoute = await import('@/app/api/v1/imports/[id]/apply/route');
    cancelRoute = await import('@/app/api/v1/imports/[id]/cancel/route');
    imageRoute = await import('@/app/api/v1/images/[imageId]/route');
    pageClaimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Import images ${suiteTag}`, slug: `import-images-${suiteTag}` })
      .returning();
    workspaceId = workspace?.id ?? '';
    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });

    spaceKey = `II${suiteTag.slice(3, 6).toUpperCase()}`.slice(0, 10);
    const created = await json(
      await spacesRoute.POST(
        cookie(admin, '/api/v1/spaces', {
          method: 'POST',
          body: JSON.stringify({ key: spaceKey, name: 'Import images' }),
        }),
      ),
    );
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    if (workspaceId) await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    const userIds = [admin?.userId, editor?.userId].filter((value): value is string => typeof value === 'string');
    if (userIds.length > 0) await db.delete(schema.users).where(drizzle.inArray(schema.users.id, userIds));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  let firstImportId = '';
  let platformPageId = '';

  it('stages what the store will take and warns about the rest', async () => {
    const started = await startImport(docsZip(1));
    expect(started.status).toBe(201);
    firstImportId = String(started.body['id']);
    expect(started.body['stats']).toMatchObject({ images: 1, images_skipped: 2 });
    expect(await staged(firstImportId)).toEqual(['docs/img/arch.png']);

    const items = await preview(firstImportId);
    const platform = items.find((item) => item['title'] === 'Platform');
    expect(platform?.['warnings']).toEqual([
      { code: 'image-skipped', detail: 'docs/img/huge.png: larger than the 1 MB image limit' },
      { code: 'image-skipped', detail: 'docs/img/fake.png: not a PNG, JPEG, GIF or WebP image' },
    ]);
    // A reviewer reads archive paths, not placeholders.
    expect(platform?.['markdown']).toContain('![Architecture](docs/img/arch.png "The whole thing")');
    expect(platform?.['markdown']).not.toContain('clewwiki-import-image:');
    expect(items.find((item) => item['title'] === 'Guide')?.['warnings']).toEqual([]);
  });

  it('gives every page that shows an image its own copy, attached', async () => {
    const applied = await apply(firstImportId);
    const created = applied['created'] as JsonRecord[];
    const platform = created.find((item) => item['title'] === 'Platform');
    const guide = created.find((item) => item['title'] === 'Guide');
    expect(platform?.['images']).toBe(1);
    expect(guide?.['images']).toBe(1);
    expect(applied['import']['stats']).toMatchObject({ images_carried: 2, images_failed: 0 });
    platformPageId = String(platform?.['page_id']);

    const platformBody = await bodyOf(platformPageId);
    const guideBody = await bodyOf(String(guide?.['page_id']));
    const platformImage = IMAGE_HREF.exec(platformBody)?.[1];
    const guideImage = IMAGE_HREF.exec(guideBody)?.[1];
    expect(platformImage).toBeTruthy();
    expect(guideImage).toBeTruthy();
    expect(platformImage).not.toBe(guideImage);
    expect(platformBody).toContain(`![Architecture](/api/v1/images/${platformImage} "The whole thing")`);

    expect((await imagesOf(platformPageId)).map((image) => image.id)).toEqual([platformImage]);
    expect((await imagesOf(String(guide?.['page_id']))).map((image) => image.id)).toEqual([guideImage]);

    // What was refused is left as the archive had it, and nothing is a placeholder.
    expect(platformBody).toContain('![Huge](docs/img/huge.png)');
    expect(platformBody).not.toContain('clewwiki-import-image:');
  });

  it('serves the carried image to whoever can read the page', async () => {
    const imageId = IMAGE_HREF.exec(await bodyOf(platformPageId))?.[1] ?? '';
    const response = await imageRoute.GET(cookie(editor, `/api/v1/images/${imageId}`), {
      params: Promise.resolve({ imageId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ARCH);
  });

  it('keeps nothing staged once the import is applied', async () => {
    expect(await staged(firstImportId)).toEqual([]);
  });

  it('records what it carried in the audit trail', async () => {
    const rows = await db
      .select({ metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(
        drizzle.and(
          drizzle.eq(schema.auditLog.workspaceId, workspaceId),
          drizzle.eq(schema.auditLog.action, 'page.imported'),
          drizzle.eq(schema.auditLog.target, platformPageId),
        ),
      );
    expect(rows[0]?.metadata).toMatchObject({ images: 1, images_failed: 0 });
  });

  async function overwritePlatform(zip: Uint8Array): Promise<JsonRecord> {
    const started = await startImport(zip);
    const importId = String(started.body['id']);
    const platform = (await preview(importId)).find((item) => item['title'] === 'Platform');
    await itemRoute.PATCH(
      cookie(admin, `/api/v1/imports/${importId}/items/${platform?.['id']}`, {
        method: 'PATCH',
        body: JSON.stringify({ decision: 'overwrite' }),
      }),
      { params: Promise.resolve({ id: importId, itemId: String(platform?.['id']) }) },
    );
    return apply(importId);
  }

  it('stores no image for an overwrite that a claim refuses', async () => {
    const claimed = await json(
      await pageClaimsRoute.POST(
        cookie(editor, `/api/v1/pages/${platformPageId}/claims`, { method: 'POST', body: JSON.stringify({}) }),
        idParams(platformPageId),
      ),
    );
    expect(claimed.status).toBe(201);

    const applied = await overwritePlatform(docsZip(7));
    const blocked = (applied['skipped'] as JsonRecord[]).find((item) => item['title'] === 'Platform');
    expect(blocked?.['skipped']).toBe('claimed');
    expect(await imagesOf(platformPageId)).toHaveLength(1);

    const { releaseClaim } = await import('@/lib/claims/service');
    await releaseClaim({
      workspaceId,
      claimId: String(claimed.body['claim_id']),
      actor: { type: 'user', id: editor.userId, label: 'editor' },
    });
  });

  it('puts the images of an overwrite on the page that was there', async () => {
    const applied = await overwritePlatform(docsZip(8));
    const written = (applied['created'] as JsonRecord[]).find((item) => item['title'] === 'Platform');
    expect(written?.['page_id']).toBe(platformPageId);
    expect(written?.['images']).toBe(1);

    const imageId = IMAGE_HREF.exec(await bodyOf(platformPageId))?.[1];
    const images = await imagesOf(platformPageId);
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.id)).toContain(imageId);
  });

  it('drops the staged images of a cancelled import', async () => {
    const started = await startImport(docsZip(9));
    const importId = String(started.body['id']);
    expect(await staged(importId)).toHaveLength(1);

    const cancelled = await cancelRoute.POST(
      cookie(admin, `/api/v1/imports/${importId}/cancel`, { method: 'POST' }),
      idParams(importId),
    );
    expect(cancelled.status).toBe(200);
    expect(await staged(importId)).toEqual([]);
  });

  it('falls back to the address a fetched image came from', async () => {
    const { createImport, applyImport } = await import('@/lib/imports/service');
    const { imagePlaceholderFor } = await import('@clewwiki/import');
    const [space] = await db
      .select({ id: schema.spaces.id })
      .from(schema.spaces)
      .where(drizzle.and(drizzle.eq(schema.spaces.workspaceId, workspaceId), drizzle.eq(schema.spaces.key, spaceKey)));

    const good = 'https://example.atlassian.net/wiki/download/attachments/7/ok.png';
    const bad = 'https://example.atlassian.net/wiki/download/attachments/7/not an image.png';
    const record = await createImport({
      workspaceId,
      spaceId: space?.id ?? '',
      spaceKey,
      actor: { type: 'user', id: admin.userId },
      source: 'confluence',
      parse: () => ({
        source: 'confluence',
        nodes: [
          {
            sourceId: '7',
            parentSourceId: null,
            title: 'From Confluence',
            kind: 'human',
            markdown: `![ok](${imagePlaceholderFor(good)})\n\n![bad](${imagePlaceholderFor(bad)})`,
            warnings: [],
            ordering: 0,
          },
        ],
        assets: [
          { key: good, data: png(11) },
          { key: bad, data: new TextEncoder().encode('<html>') },
        ],
        warnings: [],
        params: {},
      }),
    });
    expect(record.stats).toMatchObject({ images: 1, images_skipped: 1 });

    const applied = await applyImport({ workspaceId, importId: record.id, actor: { type: 'user', id: admin.userId } });
    const body = await bodyOf(String(applied.created[0]?.pageId));
    expect(body).toMatch(/!\[ok\]\(\/api\/v1\/images\/[0-9a-f-]{36}\)/);
    expect(body).toContain('![bad](https://example.atlassian.net/wiki/download/attachments/7/not%20an%20image.png)');
  });

  it('carries nothing, and says so, when uploads are switched off', async () => {
    process.env.IMAGE_MAX_UPLOAD_MB = '0';
    try {
      const started = await startImport(docsZip(10));
      expect(started.body['stats']).toMatchObject({ images: 0, images_skipped: 3 });
      const importId = String(started.body['id']);
      expect(await staged(importId)).toEqual([]);
      const guide = (await preview(importId)).find((item) => item['title'] === 'Guide');
      expect(guide?.['warnings']).toEqual([
        { code: 'image-skipped', detail: 'docs/img/arch.png: image uploads are switched off on this instance' },
      ]);
    } finally {
      process.env.IMAGE_MAX_UPLOAD_MB = '1';
    }
  });
});
