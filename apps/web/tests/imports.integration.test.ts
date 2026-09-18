import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as AuditRoute from '@/app/api/v1/audit/route';
import type * as PageClaimsRoute from '@/app/api/v1/pages/[id]/claims/route';

/**
 * The import flow end to end, against a real database: create, preview, edit a
 * target path, apply, and check that what landed is what the preview promised —
 * the tree, the rewritten links, the audit rows — and that the three things
 * that must never happen do not: an existing page overwritten by accident, a
 * claimed page overwritten at all, and an agent token importing anything.
 *
 * No network. Confluence is a stub `fetch`; the other sources are archives
 * built in the test.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping imports suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

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

/** A ZIP of text files, deflated, so the reader's real path is exercised. */
function buildZip(entries: ReadonlyArray<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = encoder.encode(entry.content);
    const stored = new Uint8Array(deflateRawSync(raw));
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length + stored.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x0403_4b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(stored, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x0201_4b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, stored.length, true);
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

const DOCS_ZIP = buildZip([
  {
    name: 'docs/README.md',
    content:
      '---\ntitle: Platform\n---\n\nThe platform, in one page.\n\nStart with [deployment](backend/deploy.md).\n',
  },
  { name: 'docs/backend/index.md', content: '# Backend\n\nThe services behind the gateway.\n' },
  {
    name: 'docs/backend/deploy.md',
    content: '# Deploying\n\nBack to the [platform](../README.md).\n',
  },
]);

describe.skipIf(!probe.reachable)('documentation import', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;

  let spacesRoute: typeof SpacesRoute;
  let importsRoute: typeof ImportsRoute;
  let importRoute: typeof ImportRoute;
  let itemRoute: typeof ImportItemRoute;
  let applyRoute: typeof ImportApplyRoute;
  let cancelRoute: typeof ImportCancelRoute;
  let pagesRoute: typeof PagesRoute;
  let auditRoute: typeof AuditRoute;
  let pageClaimsRoute: typeof PageClaimsRoute;

  const suiteTag = `im-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  let outsider: TestAccount;
  let agentToken = '';

  let spaceKey = '';
  let otherSpaceKey = '';

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

  /**
   * A multipart request as a browser sends it: with the length of its body
   * declared. `new Request(url, { body: form })` leaves `Content-Length` out,
   * which no real upload does and which the endpoint refuses.
   */
  async function upload(
    account: TestAccount,
    target: string,
    form: FormData,
    overrides: Record<string, string> = {},
  ): Promise<Request> {
    const encoded = new Response(form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const headers: Record<string, string> = {
      cookie: account.cookie,
      origin: BASE,
      'content-type': encoded.headers.get('content-type') ?? '',
      'content-length': String(bytes.byteLength),
      ...overrides,
    };
    for (const [name, value] of Object.entries(headers)) if (value === '') delete headers[name];
    return new Request(`${BASE}${target}`, { method: 'POST', body: bytes, headers });
  }

  function bearer(token: string, target: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${target}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });
  const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
  const itemParams = (id: string, itemId: string) => ({ params: Promise.resolve({ id, itemId }) });

  async function json(response: Response): Promise<{ status: number; body: JsonRecord }> {
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as JsonRecord) };
  }

  /**
   * The pages of a space, flattened. `GET /pages` answers with a tree of
   * nodes; the assertions here are about paths and parents, not about shape.
   */
  async function livePages(account: TestAccount, key: string): Promise<JsonRecord[]> {
    const { body } = await json(
      await pagesRoute.GET(cookie(account, `/api/v1/pages?space=${key}`)),
    );
    const out: JsonRecord[] = [];
    const walk = (nodes: JsonRecord[]): void => {
      for (const node of nodes) {
        out.push(node);
        walk((node['children'] ?? []) as JsonRecord[]);
      }
    };
    walk((body['nodes'] ?? []) as JsonRecord[]);
    return out;
  }

  async function startMarkdownImport(
    account: TestAccount,
    key: string,
    zip: Uint8Array = DOCS_ZIP,
  ): Promise<{ status: number; body: JsonRecord }> {
    const form = new FormData();
    form.set('source', 'markdown');
    form.set('file', new File([zip as BlobPart], 'docs.zip', { type: 'application/zip' }));
    return json(
      await importsRoute.POST(await upload(account, `/api/v1/spaces/${key}/imports`, form), keyParams(key)),
    );
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();

    spacesRoute = await import('@/app/api/v1/spaces/route');
    importsRoute = await import('@/app/api/v1/spaces/[key]/imports/route');
    importRoute = await import('@/app/api/v1/imports/[id]/route');
    itemRoute = await import('@/app/api/v1/imports/[id]/items/[itemId]/route');
    applyRoute = await import('@/app/api/v1/imports/[id]/apply/route');
    cancelRoute = await import('@/app/api/v1/imports/[id]/cancel/route');
    pagesRoute = await import('@/app/api/v1/pages/route');
    auditRoute = await import('@/app/api/v1/audit/route');
    pageClaimsRoute = await import('@/app/api/v1/pages/[id]/claims/route');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Imports ${suiteTag}`, slug: `imports-${suiteTag}` })
      .returning();
    workspaceId = workspace?.id ?? '';

    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `other-${suiteTag}` })
      .returning();
    otherWorkspaceId = other?.id ?? '';

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    outsider = await createTestAccount({
      db,
      schema,
      workspaceId: otherWorkspaceId,
      role: 'admin',
      tag: `${suiteTag}-o`,
    });

    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId,
      name: 'importer',
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes: ['pages:read', 'pages:write'],
      spaceIds: null,
    });
    agentToken = generated.token;

    spaceKey = `IM${suiteTag.slice(3, 6).toUpperCase()}`.slice(0, 10);
    const created = await json(
      await spacesRoute.POST(
        cookie(admin, '/api/v1/spaces', {
          method: 'POST',
          body: JSON.stringify({ key: spaceKey, name: 'Import target' }),
        }),
      ),
    );
    expect(created.status).toBe(201);

    otherSpaceKey = `OT${suiteTag.slice(3, 6).toUpperCase()}`.slice(0, 10);
    const [otherSpace] = await db
      .insert(schema.spaces)
      .values({ workspaceId: otherWorkspaceId, key: otherSpaceKey, name: 'Elsewhere' })
      .returning();
    expect(otherSpace?.id).toBeTruthy();
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    const { eq, inArray } = await import('drizzle-orm');
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, id));
    }
    const userIds = [admin?.userId, editor?.userId, outsider?.userId].filter(
      (value): value is string => typeof value === 'string',
    );
    if (userIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    const { getDatabaseHandle } = schema;
    await getDatabaseHandle().sql.end({ timeout: 5 });
  });

  /* ---------------------------------------------------------------- */

  describe('who may import', () => {
    it('refuses an agent token and says why', async () => {
      const response = await importsRoute.POST(
        bearer(agentToken, `/api/v1/spaces/${spaceKey}/imports`, {
          method: 'POST',
          body: JSON.stringify({
            source: 'confluence',
            base_url: 'https://example.atlassian.net',
            space_key: 'ENG',
            email: 'a@example.test',
            api_token: 'token',
          }),
        }),
        keyParams(spaceKey),
      );
      const { status, body } = await json(response);
      expect(status).toBe(403);
      expect(body['error']?.code).toBe('forbidden');
      expect(String(body['error']?.message)).toMatch(/signed-in people/i);
    });

    it('refuses a request with no session', async () => {
      const response = await importsRoute.POST(
        new Request(`${BASE}/api/v1/spaces/${spaceKey}/imports`, {
          method: 'POST',
          headers: { origin: BASE, 'content-type': 'application/json' },
          body: '{}',
        }),
        keyParams(spaceKey),
      );
      expect(response.status).toBe(401);
    });

    it('refuses a cross-origin upload', async () => {
      const form = new FormData();
      form.set('source', 'markdown');
      form.set('file', new File([DOCS_ZIP as BlobPart], 'docs.zip'));
      const response = await importsRoute.POST(
        new Request(`${BASE}/api/v1/spaces/${spaceKey}/imports`, {
          method: 'POST',
          body: form,
          headers: { cookie: admin.cookie, origin: 'https://evil.example' },
        }),
        keyParams(spaceKey),
      );
      expect(response.status).toBe(403);
    });

    it('lets an editor import', async () => {
      const started = await startMarkdownImport(editor, spaceKey);
      expect(started.status).toBe(201);
      await json(
        await importRoute.DELETE(
          cookie(editor, `/api/v1/imports/${started.body['id']}`, { method: 'DELETE' }),
          idParams(String(started.body['id'])),
        ),
      );
    });

    it('hides a space in another workspace', async () => {
      const form = new FormData();
      form.set('source', 'markdown');
      form.set('file', new File([DOCS_ZIP as BlobPart], 'docs.zip'));
      const response = await importsRoute.POST(
        await upload(admin, `/api/v1/spaces/${otherSpaceKey}/imports`, form),
        keyParams(otherSpaceKey),
      );
      expect(response.status).toBe(404);
    });

    it('hides another workspace’s import behind a 404', async () => {
      const started = await startMarkdownImport(admin, spaceKey);
      const response = await importRoute.GET(
        cookie(outsider, `/api/v1/imports/${started.body['id']}`),
        idParams(String(started.body['id'])),
      );
      expect(response.status).toBe(404);
      await importRoute.DELETE(
        cookie(admin, `/api/v1/imports/${started.body['id']}`, { method: 'DELETE' }),
        idParams(String(started.body['id'])),
      );
    });
  });

  /* ---------------------------------------------------------------- */

  describe('create, preview, edit, apply', () => {
    it('walks the whole flow and lands the tree with rewritten links', async () => {
      const started = await startMarkdownImport(admin, spaceKey);
      expect(started.status).toBe(201);
      expect(started.body['status']).toBe('needs_review');
      const importId = String(started.body['id']);

      // Nothing is a page yet.
      expect(await livePages(admin, spaceKey)).toHaveLength(0);

      const preview = await json(
        await importRoute.GET(cookie(admin, `/api/v1/imports/${importId}`), idParams(importId)),
      );
      expect(preview.status).toBe(200);
      const items = preview.body['items'] as JsonRecord[];
      expect(items.map((item) => item['title']).sort()).toEqual(['Backend', 'Deploying', 'Platform']);
      expect(items.map((item) => item['target_path']).sort()).toEqual([
        '/backend',
        '/backend/deploying',
        '/platform',
      ]);
      // The preview resolves links to the paths a reviewer is deciding about.
      const platformPreview = items.find((item) => item['title'] === 'Platform');
      expect(String(platformPreview?.['markdown'])).toContain('[deployment](/backend/deploying)');

      // A reviewer moves one page.
      const deploying = items.find((item) => item['title'] === 'Deploying');
      const moved = await json(
        await itemRoute.PATCH(
          cookie(admin, `/api/v1/imports/${importId}/items/${deploying?.['id']}`, {
            method: 'PATCH',
            body: JSON.stringify({ target_path: '/backend/deployment' }),
          }),
          itemParams(importId, String(deploying?.['id'])),
        ),
      );
      expect(moved.status).toBe(200);
      expect(moved.body['target_path']).toBe('/backend/deployment');

      const applied = await json(
        await applyRoute.POST(
          cookie(admin, `/api/v1/imports/${importId}/apply`, { method: 'POST' }),
          idParams(importId),
        ),
      );
      expect(applied.status).toBe(200);
      expect(applied.body['import']?.status).toBe('applied');
      expect(applied.body['created']).toHaveLength(3);
      expect(applied.body['skipped']).toHaveLength(0);

      const pages = await livePages(admin, spaceKey);
      expect(pages.map((page) => page['path']).sort()).toEqual([
        '/backend',
        '/backend/deployment',
        '/platform',
      ]);
      expect(pages.every((page) => page['kind'] === 'human')).toBe(true);

      // The tree: `Deploying` hangs off `Backend`.
      const backend = pages.find((page) => page['path'] === '/backend');
      const deployment = pages.find((page) => page['path'] === '/backend/deployment');
      expect(deployment?.['parent_id']).toBe(backend?.['page_id']);

      // Links point at the pages that were actually created, at the path a
      // reviewer moved one of them to.
      const platformId = pages.find((page) => page['path'] === '/platform')?.['page_id'];
      const { eq } = await import('drizzle-orm');
      const [platformRow] = await db
        .select({ body: schema.pages.body })
        .from(schema.pages)
        .where(eq(schema.pages.id, String(platformId)));
      expect(platformRow?.body).toContain(
        `[deployment](/spaces/${spaceKey}/pages/${deployment?.['page_id']})`,
      );
      expect(platformRow?.body).not.toContain('clewwiki-import:');

      const [deployRow] = await db
        .select({ body: schema.pages.body })
        .from(schema.pages)
        .where(eq(schema.pages.id, String(deployment?.['page_id'])));
      expect(deployRow?.body).toContain(`[platform](/spaces/${spaceKey}/pages/${platformId})`);

      // Every created page is audited as an import, and the import itself too.
      const audit = await json(
        await auditRoute.GET(cookie(admin, '/api/v1/audit?action=page.imported&limit=100')),
      );
      const imported = (audit.body['entries'] as JsonRecord[]).filter(
        (entry) => entry['metadata']?.import_id === importId,
      );
      expect(imported).toHaveLength(3);

      const appliedAudit = await json(
        await auditRoute.GET(cookie(admin, '/api/v1/audit?action=import.applied&limit=50')),
      );
      expect((appliedAudit.body['entries'] as JsonRecord[]).some((entry) => entry['target'] === importId)).toBe(
        true,
      );
    });

    it('refuses to apply an import twice', async () => {
      const started = await startMarkdownImport(admin, spaceKey);
      const importId = String(started.body['id']);
      await applyRoute.POST(
        cookie(admin, `/api/v1/imports/${importId}/apply`, { method: 'POST' }),
        idParams(importId),
      );
      const again = await json(
        await applyRoute.POST(
          cookie(admin, `/api/v1/imports/${importId}/apply`, { method: 'POST' }),
          idParams(importId),
        ),
      );
      expect(again.status).toBe(409);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('conflicts and claims', () => {
    it('stages a path that is taken as skipped, and leaves the page alone on apply', async () => {
      // The previous block already created /platform. A second import of the
      // same archive therefore collides with itself everywhere.
      const started = await startMarkdownImport(admin, spaceKey);
      const importId = String(started.body['id']);

      const preview = await json(
        await importRoute.GET(cookie(admin, `/api/v1/imports/${importId}`), idParams(importId)),
      );
      const items = preview.body['items'] as JsonRecord[];
      const platform = items.find((item) => item['title'] === 'Platform');
      expect(platform?.['conflict_page_id']).toBeTruthy();
      expect(platform?.['decision']).toBe('skip');

      const applied = await json(
        await applyRoute.POST(
          cookie(admin, `/api/v1/imports/${importId}/apply`, { method: 'POST' }),
          idParams(importId),
        ),
      );
      expect(applied.status).toBe(200);
      expect(applied.body['created']).toHaveLength(0);
      expect((applied.body['skipped'] as JsonRecord[]).every((item) => item['skipped'] === 'decision')).toBe(
        true,
      );

      // Still one page per path: nothing was duplicated or replaced.
      const paths = (await livePages(admin, spaceKey)).map((page) => page['path']);
      expect(paths.filter((path) => path === '/platform')).toHaveLength(1);
    });

    it('skips an overwrite of a page somebody else is holding', async () => {
      const target = (await livePages(admin, spaceKey)).find((page) => page['path'] === '/platform');
      expect(target).toBeTruthy();

      // The editor takes the lease, then the administrator tries to import over it.
      const claimed = await json(
        await pageClaimsRoute.POST(
          cookie(editor, `/api/v1/pages/${target?.['page_id']}/claims`, {
            method: 'POST',
            body: JSON.stringify({}),
          }),
          idParams(String(target?.['page_id'])),
        ),
      );
      expect(claimed.status).toBe(201);

      const started = await startMarkdownImport(admin, spaceKey);
      const importId = String(started.body['id']);
      const preview = await json(
        await importRoute.GET(cookie(admin, `/api/v1/imports/${importId}`), idParams(importId)),
      );
      const platform = (preview.body['items'] as JsonRecord[]).find(
        (item) => item['title'] === 'Platform',
      );
      expect(platform?.['claimed_by']).toBeTruthy();

      await itemRoute.PATCH(
        cookie(admin, `/api/v1/imports/${importId}/items/${platform?.['id']}`, {
          method: 'PATCH',
          body: JSON.stringify({ decision: 'overwrite' }),
        }),
        itemParams(importId, String(platform?.['id'])),
      );

      const applied = await json(
        await applyRoute.POST(
          cookie(admin, `/api/v1/imports/${importId}/apply`, { method: 'POST' }),
          idParams(importId),
        ),
      );
      const blocked = (applied.body['skipped'] as JsonRecord[]).find(
        (item) => item['title'] === 'Platform',
      );
      expect(blocked?.['skipped']).toBe('claimed');

      // The held page still says what its holder left there.
      const { eq } = await import('drizzle-orm');
      const [row] = await db
        .select({ body: schema.pages.body, version: schema.pages.version })
        .from(schema.pages)
        .where(eq(schema.pages.id, String(target?.['page_id'])));
      expect(row?.version).toBe(1);

      const { releaseClaim } = await import('@/lib/claims/service');
      await releaseClaim({
        workspaceId,
        claimId: String(claimed.body['claim_id']),
        actor: { type: 'user', id: editor.userId, label: 'editor' },
      });
    });

    it('overwrites a page nobody is holding when the reviewer asks for it', async () => {
      const started = await startMarkdownImport(admin, spaceKey);
      const importId = String(started.body['id']);
      const preview = await json(
        await importRoute.GET(cookie(admin, `/api/v1/imports/${importId}`), idParams(importId)),
      );
      const platform = (preview.body['items'] as JsonRecord[]).find(
        (item) => item['title'] === 'Platform',
      );
      await itemRoute.PATCH(
        cookie(admin, `/api/v1/imports/${importId}/items/${platform?.['id']}`, {
          method: 'PATCH',
          body: JSON.stringify({ decision: 'overwrite' }),
        }),
        itemParams(importId, String(platform?.['id'])),
      );

      const applied = await json(
        await applyRoute.POST(
          cookie(admin, `/api/v1/imports/${importId}/apply`, { method: 'POST' }),
          idParams(importId),
        ),
      );
      const written = (applied.body['created'] as JsonRecord[]).find(
        (item) => item['title'] === 'Platform',
      );
      expect(written?.['page_id']).toBe(String(platform?.['conflict_page_id']));

      const { eq } = await import('drizzle-orm');
      const [row] = await db
        .select({ version: schema.pages.version })
        .from(schema.pages)
        .where(eq(schema.pages.id, String(written?.['page_id'])));
      expect(row?.version).toBeGreaterThan(1);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('limits and refusals', () => {
    it('refuses an archive with no Markdown in it', async () => {
      const zip = buildZip([{ name: 'a/logo.txt', content: 'not markdown' }]);
      const started = await startMarkdownImport(admin, spaceKey, zip);
      expect(started.status).toBe(400);
      expect(started.body['error']?.code).toBe('validation');
    });

    it('records a failed import rather than losing it', async () => {
      const zip = buildZip([{ name: 'a/logo.txt', content: 'not markdown' }]);
      await startMarkdownImport(admin, spaceKey, zip);
      const listed = await json(
        await importsRoute.GET(cookie(admin, `/api/v1/spaces/${spaceKey}/imports`), keyParams(spaceKey)),
      );
      const failed = (listed.body['imports'] as JsonRecord[]).filter(
        (record) => record['status'] === 'failed',
      );
      expect(failed.length).toBeGreaterThan(0);
      expect(String(failed[0]?.['error'])).toMatch(/Markdown/);
    });

    it('refuses an empty upload', async () => {
      const form = new FormData();
      form.set('source', 'markdown');
      form.set('file', new File([], 'empty.zip'));
      const { status, body } = await json(
        await importsRoute.POST(
          await upload(admin, `/api/v1/spaces/${spaceKey}/imports`, form),
          keyParams(spaceKey),
        ),
      );
      expect(status).toBe(400);
      expect(String(body['error']?.message)).toMatch(/empty/i);
    });

    it('refuses an upload by its declared size, before reading it', async () => {
      const form = new FormData();
      form.set('source', 'markdown');
      form.set('file', new File([DOCS_ZIP as BlobPart], 'docs.zip'));

      // The body here is small; what is refused is what the request claims.
      const huge = await json(
        await importsRoute.POST(
          await upload(admin, `/api/v1/spaces/${spaceKey}/imports`, form, {
            'content-length': String(5 * 1024 * 1024 * 1024),
          }),
          keyParams(spaceKey),
        ),
      );
      expect(huge.status).toBe(413);
      expect(huge.body['error']?.details).toMatchObject({ limit: 200 * 1024 * 1024 });

      for (const declared of ['', 'lots', '-1']) {
        const undeclared = await importsRoute.POST(
          await upload(admin, `/api/v1/spaces/${spaceKey}/imports`, form, {
            'content-length': declared,
          }),
          keyParams(spaceKey),
        );
        expect(undeclared.status, JSON.stringify(declared)).toBe(411);
      }
    });

    it('holds an import to the limits the operator set', async () => {
      const previous = {
        upload: process.env.IMPORT_MAX_UPLOAD_MB,
        expanded: process.env.IMPORT_MAX_EXPANDED_MB,
      };
      process.env.IMPORT_MAX_UPLOAD_MB = '1';
      process.env.IMPORT_MAX_EXPANDED_MB = '1';
      try {
        const form = new FormData();
        form.set('source', 'markdown');
        form.set('file', new File([DOCS_ZIP as BlobPart], 'docs.zip'));
        const declaredTooLarge = await json(
          await importsRoute.POST(
            await upload(admin, `/api/v1/spaces/${spaceKey}/imports`, form, {
              'content-length': String(3 * 1024 * 1024),
            }),
            keyParams(spaceKey),
          ),
        );
        expect(declaredTooLarge.status).toBe(413);
        expect(declaredTooLarge.body['error']?.details).toMatchObject({ limit: 1024 * 1024 });

        // A few kilobytes on the wire, three megabytes once expanded: the upload
        // limit lets it in and the expansion limit is what stops it.
        const bomb = buildZip([{ name: 'big.md', content: `# Big\n\n${'a'.repeat(3 * 1024 * 1024)}` }]);
        expect(bomb.byteLength).toBeLessThan(64 * 1024);
        const expandsTooFar = await startMarkdownImport(admin, spaceKey, bomb);
        expect(expandsTooFar.status).toBe(400);
        expect(String(expandsTooFar.body['error']?.message)).toMatch(/expands/i);
      } finally {
        for (const [name, value] of [
          ['IMPORT_MAX_UPLOAD_MB', previous.upload],
          ['IMPORT_MAX_EXPANDED_MB', previous.expanded],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      // Back at the defaults the same archive is simply an import.
      expect((await startMarkdownImport(admin, spaceKey)).status).toBe(201);
    });

    it('refuses an unknown source', async () => {
      const form = new FormData();
      form.set('source', 'evernote');
      form.set('file', new File([DOCS_ZIP as BlobPart], 'docs.zip'));
      const { status } = await json(
        await importsRoute.POST(
          await upload(admin, `/api/v1/spaces/${spaceKey}/imports`, form),
          keyParams(spaceKey),
        ),
      );
      expect(status).toBe(400);
    });

    it('refuses two staged items at the same path', async () => {
      const started = await startMarkdownImport(admin, spaceKey);
      const importId = String(started.body['id']);
      const preview = await json(
        await importRoute.GET(cookie(admin, `/api/v1/imports/${importId}`), idParams(importId)),
      );
      const items = preview.body['items'] as JsonRecord[];
      const first = items[0];
      const second = items[1];
      const { status } = await json(
        await itemRoute.PATCH(
          cookie(admin, `/api/v1/imports/${importId}/items/${second?.['id']}`, {
            method: 'PATCH',
            body: JSON.stringify({ target_path: String(first?.['target_path']) }),
          }),
          itemParams(importId, String(second?.['id'])),
        ),
      );
      expect(status).toBe(409);

      await cancelRoute.POST(
        cookie(admin, `/api/v1/imports/${importId}/cancel`, { method: 'POST' }),
        idParams(importId),
      );
      const cancelled = await json(
        await importRoute.GET(cookie(admin, `/api/v1/imports/${importId}`), idParams(importId)),
      );
      expect(cancelled.body['import']?.status).toBe('cancelled');
    });

    it('refuses to edit an item of an import that is no longer open', async () => {
      const started = await startMarkdownImport(admin, spaceKey);
      const importId = String(started.body['id']);
      const preview = await json(
        await importRoute.GET(cookie(admin, `/api/v1/imports/${importId}`), idParams(importId)),
      );
      const item = (preview.body['items'] as JsonRecord[])[0];
      await cancelRoute.POST(
        cookie(admin, `/api/v1/imports/${importId}/cancel`, { method: 'POST' }),
        idParams(importId),
      );
      const { status } = await json(
        await itemRoute.PATCH(
          cookie(admin, `/api/v1/imports/${importId}/items/${item?.['id']}`, {
            method: 'PATCH',
            body: JSON.stringify({ decision: 'skip' }),
          }),
          itemParams(importId, String(item?.['id'])),
        ),
      );
      expect(status).toBe(409);
    });

    it('deletes an import without touching the pages it created', async () => {
      const listed = await json(
        await importsRoute.GET(cookie(admin, `/api/v1/spaces/${spaceKey}/imports`), keyParams(spaceKey)),
      );
      const applied = (listed.body['imports'] as JsonRecord[]).find(
        (record) => record['status'] === 'applied',
      );
      expect(applied).toBeTruthy();

      const pagesBefore = await livePages(admin, spaceKey);

      const deleted = await json(
        await importRoute.DELETE(
          cookie(admin, `/api/v1/imports/${applied?.['id']}`, { method: 'DELETE' }),
          idParams(String(applied?.['id'])),
        ),
      );
      expect(deleted.status).toBe(200);

      const gone = await importRoute.GET(
        cookie(admin, `/api/v1/imports/${applied?.['id']}`),
        idParams(String(applied?.['id'])),
      );
      expect(gone.status).toBe(404);

      expect((await livePages(admin, spaceKey)).length).toBe(pagesBefore.length);
    });
  });
});
