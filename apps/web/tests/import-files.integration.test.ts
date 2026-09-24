import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';
import type { FileSink, ImportFileVersion, ImportParseResult } from '@clewwiki/import';
import type * as DrizzleOrm from 'drizzle-orm';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping import-files suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const text = (value: string) => new TextEncoder().encode(value);
const streamOf = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(text(value));
      controller.close();
    },
  });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Attachments an import carries across as files: staged into the file store
 * while the source is read, held by `import_file_versions` until the import is
 * applied, then turned into the page's files with the source's history.
 *
 * The adapter is stood in for by a parse callback that feeds the sink the way
 * the Confluence adapter does; the adapter itself is tested in
 * `packages/import`.
 */
describe.skipIf(!probe.reachable)('files carried by an import', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let filesDir = '';

  const suiteTag = `impf-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let spaceId = '';
  const spaceKey = 'DOCS';
  let admin: TestAccount;

  const version = (overrides: Partial<ImportFileVersion>): ImportFileVersion => ({
    sourceId: '1001',
    name: 'spec.pdf',
    position: 0,
    mediaType: 'application/pdf',
    expectedBytes: null,
    note: null,
    sourceVersion: 1,
    author: 'Ada',
    createdAt: new Date('2013-04-23T22:00:24.000Z'),
    ...overrides,
  });

  /** A parse that stages the given versions through the real sink, and one page per source id. */
  function parseWith(versions: Array<[ImportFileVersion, string]>, refusals: string[] = []) {
    return async (_limits: unknown, context: { workspaceId: string; importId: string }): Promise<ImportParseResult> => {
      const { createImportFileSink } = await import('@/lib/imports/files');
      const sink = createImportFileSink(context) as FileSink;
      for (const [meta, body] of versions) {
        const stored = await sink.store(meta, streamOf(body));
        if ('refused' in stored) refusals.push(`${meta.name}@${meta.sourceVersion}: ${stored.refused}`);
      }
      const sources = [...new Set(versions.map(([meta]) => meta.sourceId))];
      return {
        source: 'confluence',
        nodes: sources.map((sourceId, index) => ({
          sourceId,
          parentSourceId: null,
          title: `Page ${sourceId} ${randomUUID().slice(0, 4)}`,
          kind: 'human',
          markdown: `Page ${sourceId}\n`,
          warnings: [],
          ordering: index,
        })),
        assets: [],
        warnings: [],
        params: {},
      };
    };
  }

  async function startImport(versions: Array<[ImportFileVersion, string]>, refusals: string[] = []) {
    const { createImport } = await import('@/lib/imports/service');
    return createImport({
      workspaceId,
      spaceId,
      spaceKey,
      actor: { type: 'user', id: admin.userId },
      source: 'confluence',
      parse: parseWith(versions, refusals) as never,
    });
  }

  async function stagedRows(importId: string) {
    return db
      .select()
      .from(schema.importFileVersions)
      .where(drizzle.eq(schema.importFileVersions.importId, importId));
  }

  const blobExists = async (content: string) => {
    const hash = sha(content);
    const dir = path.join(filesDir, 'blobs', workspaceId, hash.slice(0, 2));
    return readdir(dir).then((names) => names.includes(hash), () => false);
  };

  beforeAll(async () => {
    filesDir = await mkdtemp(path.join(tmpdir(), 'clewwiki-import-files-'));
    process.env.FILES_DRIVER = 'local';
    process.env.FILES_DIR = filesDir;

    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    const [workspace] = await db.insert(schema.workspaces).values({ name: `Import files ${suiteTag}`, slug: `${suiteTag}-ws` }).returning();
    workspaceId = workspace!.id;
    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: `${suiteTag}-a` });
    const [space] = await db.insert(schema.spaces).values({ workspaceId, key: spaceKey, name: 'Docs' }).returning();
    spaceId = space!.id;
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    delete process.env.FILES_DRIVER;
    delete process.env.FILES_DIR;
    delete process.env.FILES_STORE_MAX_MB;
    await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(drizzle.eq(schema.users.id, admin.userId));
    await rm(filesDir, { recursive: true, force: true });
  });

  it('stages versions in the store, keeps them from the sweep, and applies them as the page history', async () => {
    const refusals: string[] = [];
    const record = await startImport(
      [
        [version({ sourceVersion: 1, position: 0, note: 'Draft', expectedBytes: 11 }), 'first draft'],
        [version({ sourceVersion: 2, position: 1, author: 'Grace', createdAt: new Date('2013-04-26T18:46:03.000Z') }), 'second draft'],
        [version({ sourceVersion: 3, position: 2, note: 'Signed off', createdAt: new Date('2013-04-26T18:46:52.000Z') }), 'final'],
        // What some sites do: an old version served as the latest bytes.
        [version({ name: 'diagram.jpg', mediaType: 'image/jpeg', sourceVersion: 1, position: 3, expectedBytes: 34093 }), 'latest bytes'],
        [version({ name: 'diagram.jpg', mediaType: 'image/jpeg', sourceVersion: 2, position: 4 }), 'latest bytes'],
        [version({ name: 'bad/name.txt', position: 5 }), 'x'],
      ],
      refusals,
    );
    expect(refusals).toEqual([
      'diagram.jpg@1: version 1 was not served as the source records it',
      'bad/name.txt@1: a file name cannot contain / or \\',
    ]);
    expect(record.stats).toMatchObject({ files: 2, file_versions: 4 });
    expect(await stagedRows(record.id)).toHaveLength(4);

    // The bytes wait for the review, however long it takes.
    const { sweepFileBlobs } = await import('@/lib/files/sweep');
    await sweepFileBlobs(new Date(Date.now() + 3 * 60 * 60 * 1000));
    expect(await blobExists('first draft')).toBe(true);

    const { applyImport } = await import('@/lib/imports/service');
    const applied = await applyImport({ workspaceId, importId: record.id, actor: { type: 'user', id: admin.userId } });
    expect(applied.created[0]).toMatchObject({ files: 2 });
    const pageId = String(applied.created[0]!.pageId);
    expect(await stagedRows(record.id)).toEqual([]);

    const { listFileVersions, listPageFiles } = await import('@/lib/files/service');
    const files = await listPageFiles(workspaceId, pageId);
    expect(files.map((file) => [file.name, file.latestVersion])).toEqual([
      ['diagram.jpg', 1],
      ['spec.pdf', 3],
    ]);
    const spec = files.find((file) => file.name === 'spec.pdf')!;
    const history = await listFileVersions(workspaceId, spec.id);
    expect(history.map((entry) => [entry.version, entry.sha256, entry.createdByLabel, entry.note, entry.createdAt.toISOString()])).toEqual([
      [3, sha('final'), 'Ada', 'Signed off', '2013-04-26T18:46:52.000Z'],
      [2, sha('second draft'), 'Grace', null, '2013-04-26T18:46:03.000Z'],
      [1, sha('first draft'), 'Ada', 'Draft', '2013-04-23T22:00:24.000Z'],
    ]);
    expect(history.every((entry) => entry.createdByType === 'user' && entry.createdById === admin.userId)).toBe(true);
    expect(spec.latest.contentType).toBe('application/pdf');

    const audit = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(drizzle.and(drizzle.eq(schema.auditLog.workspaceId, workspaceId), drizzle.eq(schema.auditLog.target, spec.id)));
    expect(audit.map((row) => row.action)).toEqual(['file.imported']);
  });

  it('lets the sweep take the bytes of a cancelled import', async () => {
    const record = await startImport([[version({ name: 'dropped.bin', sourceId: '2002' }), 'never applied']]);
    expect(await stagedRows(record.id)).toHaveLength(1);

    const { cancelImport } = await import('@/lib/imports/service');
    await cancelImport(workspaceId, record.id, { type: 'user', id: admin.userId });
    expect(await stagedRows(record.id)).toEqual([]);

    const { sweepFileBlobs } = await import('@/lib/files/sweep');
    await sweepFileBlobs(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(await blobExists('never applied')).toBe(false);
  });

  it('counts staged files against the store, each content once', async () => {
    const [usage] = await db
      .select({ used: drizzle.sql<string>`coalesce(sum(${schema.fileBlobs.byteSize}), 0)` })
      .from(schema.fileBlobs)
      .where(drizzle.eq(schema.fileBlobs.workspaceId, workspaceId));
    const used = Number(usage?.used ?? 0);
    const MB = 1024 * 1024;
    const limitMb = Math.floor(used / MB) + 1;
    const size = Math.ceil((limitMb * MB - used) * 0.6);
    process.env.FILES_STORE_MAX_MB = String(limitMb);
    try {
      const refusals: string[] = [];
      const a = 'a'.repeat(size);
      const b = 'b'.repeat(size);
      await startImport(
        [
          [version({ name: 'a.bin', sourceId: '3003', position: 0 }), a],
          [version({ name: 'b.bin', sourceId: '3003', position: 1 }), b],
          [version({ name: 'a-again.bin', sourceId: '3003', position: 2 }), a],
        ],
        refusals,
      );
      expect(refusals).toEqual(['b.bin@1: the file store of this workspace is full']);
    } finally {
      delete process.env.FILES_STORE_MAX_MB;
    }
  });

  it('stages nothing when files are switched off', async () => {
    process.env.FILES_DRIVER = 'off';
    try {
      const { createImportFileSink } = await import('@/lib/imports/files');
      expect(createImportFileSink({ workspaceId, importId: randomUUID() })).toBeUndefined();
    } finally {
      process.env.FILES_DRIVER = 'local';
    }
  });

  it('carries the files an archive page links to, and points its links at them', async () => {
    const { createImport, applyImport } = await import('@/lib/imports/service');
    const { filePlaceholderFor } = await import('@clewwiki/import');
    const archive = (markdownTitle: string): ImportParseResult => ({
      source: 'markdown',
      nodes: [
        {
          sourceId: `guide-${markdownTitle}`,
          parentSourceId: null,
          title: markdownTitle,
          kind: 'human',
          markdown: `See [the spec](${filePlaceholderFor('a/spec.pdf')}) and [the other one](${filePlaceholderFor('b/spec.pdf')}).\n`,
          warnings: [],
          ordering: 0,
        },
      ],
      assets: [],
      fileAssets: [
        { key: 'a/spec.pdf', data: text('first spec') },
        { key: 'b/spec.pdf', data: text('second spec') },
      ],
      warnings: [],
      params: {},
    });

    const record = await createImport({
      workspaceId,
      spaceId,
      spaceKey,
      actor: { type: 'user', id: admin.userId },
      source: 'markdown',
      parse: () => archive(`Guide ${randomUUID().slice(0, 4)}`),
    });
    expect(record.stats).toMatchObject({ files: 2, file_versions: 2 });

    const applied = await applyImport({ workspaceId, importId: record.id, actor: { type: 'user', id: admin.userId } });
    const pageId = String(applied.created[0]!.pageId);
    const [page] = await db.select({ body: schema.pages.body }).from(schema.pages).where(drizzle.eq(schema.pages.id, pageId));
    expect(page!.body).toContain(`[the spec](/api/v1/pages/${pageId}/files/spec.pdf)`);
    expect(page!.body).toContain(`[the other one](/api/v1/pages/${pageId}/files/spec%20%282%29.pdf)`);

    const { listPageFiles } = await import('@/lib/files/service');
    const files = await listPageFiles(workspaceId, pageId);
    expect(files.map((file) => [file.name, file.latest.sha256])).toEqual([
      ['spec (2).pdf', sha('second spec')],
      ['spec.pdf', sha('first spec')],
    ]);
    expect(files[0]!.latest.createdByLabel).toBe('Markdown import');

    // With files off, the links stay the paths the archive had, and say why.
    process.env.FILES_DRIVER = 'off';
    try {
      const off = await createImport({
        workspaceId,
        spaceId,
        spaceKey,
        actor: { type: 'user', id: admin.userId },
        source: 'markdown',
        parse: () => archive(`Offline ${randomUUID().slice(0, 4)}`),
      });
      const { previewImport } = await import('@/lib/imports/service');
      const preview = await previewImport(workspaceId, off.id);
      expect(preview.items[0]!.warnings).toContainEqual({ code: 'file-skipped', detail: 'spec.pdf: files are switched off on this instance' });
      expect(preview.items[0]!.preview).toContain('[the spec](a/spec.pdf)');
      const offApplied = await applyImport({ workspaceId, importId: off.id, actor: { type: 'user', id: admin.userId } });
      const [offPage] = await db
        .select({ body: schema.pages.body })
        .from(schema.pages)
        .where(drizzle.eq(schema.pages.id, String(offApplied.created[0]!.pageId)));
      expect(offPage!.body).toContain('[the other one](b/spec.pdf)');
    } finally {
      process.env.FILES_DRIVER = 'local';
    }
  });
});
