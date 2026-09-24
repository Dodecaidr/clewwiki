import 'server-only';

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { fileBlobs, pageFiles, pageFileVersions, pages } from '@clewwiki/db';
import {
  blobKey,
  BlobTooLargeError,
  contentTypeOf,
  EmptyBlobError,
  fileNameProblem,
  normalizeFileName,
} from '@clewwiki/files';
import type { BlobRange } from '@clewwiki/files';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import { PageServiceError } from '../pages/errors';
import { fileLimits, getFileStore } from './store';

/**
 * Files attached to pages, in versions.
 *
 * A file is a name on a page. Putting bytes under a name the page already has
 * — in any case — adds the next version of that file; putting the bytes it
 * already has as its latest version adds nothing. Nothing is ever changed in
 * place: going back to an old version adds a new one with the old bytes, so
 * version 3 is the same bytes for as long as it exists.
 *
 * Who may see a file is decided by its page, exactly as for an image: whoever
 * can see the page's space, in whichever space the page is now. A file of a
 * deleted page is not found. This module says which space decides
 * (`spaceId` on `FileAccess`); comparing it with the caller is the handler's
 * check, written out next to the workspace check as it is for pages.
 *
 * The bytes are in the file store under their hash, one blob per distinct
 * content in a workspace, and the workspace's quota counts each blob once.
 */

const MB = 1024 * 1024;

export const MAX_NOTE_LENGTH = 1000;

export interface FileActor {
  type: 'user' | 'agent';
  id: string;
  /** The name shown with a version, kept with it as it was when it was written. */
  label: string;
}

export interface FileVersionRecord {
  id: string;
  fileId: string;
  version: number;
  sha256: string;
  byteSize: number;
  contentType: string;
  note: string | null;
  restoredFrom: number | null;
  createdByType: 'user' | 'agent';
  createdById: string;
  createdByLabel: string;
  createdAt: Date;
}

export interface FileRecord {
  id: string;
  workspaceId: string;
  pageId: string;
  name: string;
  latestVersion: number;
  createdAt: Date;
  updatedAt: Date;
  /** The version a download of the file gets. */
  latest: FileVersionRecord;
}

export interface FileAccess extends FileRecord {
  /** The space whose visibility decides who may see the file: its page's. */
  spaceId: string;
}

const versionColumns = {
  id: pageFileVersions.id,
  fileId: pageFileVersions.fileId,
  version: pageFileVersions.version,
  sha256: pageFileVersions.sha256,
  byteSize: pageFileVersions.byteSize,
  contentType: pageFileVersions.contentType,
  note: pageFileVersions.note,
  restoredFrom: pageFileVersions.restoredFrom,
  createdByType: pageFileVersions.createdByType,
  createdById: pageFileVersions.createdById,
  createdByLabel: pageFileVersions.createdByLabel,
  createdAt: pageFileVersions.createdAt,
};

const fileColumns = {
  id: pageFiles.id,
  workspaceId: pageFiles.workspaceId,
  pageId: pageFiles.pageId,
  name: pageFiles.name,
  latestVersion: pageFiles.latestVersion,
  createdAt: pageFiles.createdAt,
  updatedAt: pageFiles.updatedAt,
};

function requireStore() {
  const store = getFileStore();
  if (store === null) {
    throw new PageServiceError('forbidden', 'Attached files are switched off on this instance (FILES_DRIVER)');
  }
  return store;
}

/** Normalizes a name and refuses one that cannot be a file name. */
export function checkFileName(raw: string): string {
  const name = normalizeFileName(raw);
  const problem = fileNameProblem(name);
  if (problem !== null) throw new PageServiceError('validation', problem, { name: raw });
  return name;
}

function checkNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const trimmed = note.trim();
  if (trimmed === '') return null;
  if ([...trimmed].length > MAX_NOTE_LENGTH) {
    throw new PageServiceError('validation', `A version note is at most ${MAX_NOTE_LENGTH} characters`);
  }
  return trimmed;
}

/** The file is too large for this instance: answered `413`. */
export class FileTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`The file is larger than the ${Math.round(limit / MB)} MB limit`);
    this.name = 'FileTooLargeError';
  }
}

export interface UploadFileInput {
  workspaceId: string;
  pageId: string;
  name: string;
  body: ReadableStream<Uint8Array>;
  /** What the uploader said the file is; a label only, see `contentTypeOf`. */
  declaredType: string | null;
  note?: string | null;
  actor: FileActor;
  /**
   * The size the upload declared. A body that ends short of it is refused
   * rather than stored: a file cut off on the way is worse than no file.
   */
  declaredBytes?: number;
}

export interface UploadFileResult {
  file: FileRecord;
  version: FileVersionRecord;
  /** False when the bytes were already the file's latest version: nothing was added. */
  created: boolean;
}

/**
 * Adds a version of the file `name` on a page, creating the file if the page
 * has no file by that name.
 *
 * The body is streamed to the store's staging area and hashed on the way, so
 * the whole of it is never in memory, and refused with `FileTooLargeError`
 * the moment it passes the limit. The version is then written under a lock on
 * the page and the name, so two uploads of one name at once become two
 * consecutive versions rather than a conflict.
 *
 * Refused as `validation`: a bad name, an empty body, a note that is too long.
 * Refused as `conflict`: the workspace's store is full.
 */
export async function uploadFileVersion(input: UploadFileInput): Promise<UploadFileResult> {
  const store = requireStore();
  const limits = fileLimits();
  const name = checkFileName(input.name);
  const note = checkNote(input.note);
  const contentType = contentTypeOf(name, input.declaredType);

  let staged;
  try {
    staged = await store.stage(input.body, { maxBytes: limits.uploadBytes });
  } catch (error) {
    if (error instanceof BlobTooLargeError) throw new FileTooLargeError(error.bytes, error.limit);
    if (error instanceof EmptyBlobError) throw new PageServiceError('validation', 'The upload is empty');
    throw error;
  }
  if (input.declaredBytes !== undefined && staged.byteSize !== input.declaredBytes) {
    await staged.discard();
    throw new PageServiceError('validation', 'The upload ended before the size it declared (Content-Length)', {
      declared_bytes: input.declaredBytes,
      received_bytes: staged.byteSize,
    });
  }

  try {
    return await getDatabase().transaction(async (tx) => {
      await lockFileName(tx, input.pageId, name);

      const [existing] = await tx
        .select(fileColumns)
        .from(pageFiles)
        .where(and(eq(pageFiles.pageId, input.pageId), sql`lower(${pageFiles.name}) = lower(${name})`))
        .limit(1);

      if (existing) {
        const [latest] = await tx
          .select(versionColumns)
          .from(pageFileVersions)
          .where(and(eq(pageFileVersions.fileId, existing.id), eq(pageFileVersions.version, existing.latestVersion)))
          .limit(1);
        if (latest && latest.sha256 === staged.sha256) {
          return { file: { ...existing, latest }, version: latest, created: false };
        }
      }

      // The quota counts each distinct content once, so bytes the workspace
      // already holds cost nothing.
      await lockQuota(tx, input.workspaceId);
      const [usage] = await tx
        .select({
          used: sql<string>`coalesce(sum(${fileBlobs.byteSize}), 0)`,
          held: sql<boolean>`bool_or(${fileBlobs.sha256} = ${staged.sha256})`,
        })
        .from(fileBlobs)
        .where(eq(fileBlobs.workspaceId, input.workspaceId));
      const used = Number(usage?.used ?? 0);
      if (usage?.held !== true && used + staged.byteSize > limits.storeBytes) {
        throw new PageServiceError(
          'conflict',
          'The file store of this workspace is full; an administrator can raise FILES_STORE_MAX_MB or remove files',
          { used_bytes: used, limit_bytes: limits.storeBytes },
        );
      }

      // Row first, bytes second: the row lock is what the sweep takes before
      // it removes a blob, so from here on the blob cannot be swept from under
      // this version, and if the sweep got there first the bytes are written
      // again below.
      await touchBlob(tx, input.workspaceId, staged.sha256, staged.byteSize);
      await staged.commit(blobKey(input.workspaceId, staged.sha256));

      const now = new Date();
      let file: Omit<FileRecord, 'latest'>;
      if (existing) {
        const [updated] = await tx
          .update(pageFiles)
          .set({ latestVersion: existing.latestVersion + 1, updatedAt: now })
          .where(eq(pageFiles.id, existing.id))
          .returning(fileColumns);
        if (!updated) throw new Error('file update returned no row');
        file = updated;
      } else {
        const [created] = await tx
          .insert(pageFiles)
          .values({
            workspaceId: input.workspaceId,
            pageId: input.pageId,
            name,
            latestVersion: 1,
            createdByType: input.actor.type,
            createdById: input.actor.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning(fileColumns);
        if (!created) throw new Error('file insert returned no row');
        file = created;
      }

      const [version] = await tx
        .insert(pageFileVersions)
        .values({
          workspaceId: input.workspaceId,
          fileId: file.id,
          version: file.latestVersion,
          sha256: staged.sha256,
          byteSize: staged.byteSize,
          contentType,
          note,
          createdByType: input.actor.type,
          createdById: input.actor.id,
          createdByLabel: input.actor.label,
          createdAt: now,
        })
        .returning(versionColumns);
      if (!version) throw new Error('file version insert returned no row');

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'file.version_added',
          target: file.id,
          metadata: {
            pageId: input.pageId,
            name: file.name,
            version: version.version,
            bytes: version.byteSize,
            sha256: version.sha256,
          },
        },
        tx,
      );

      return { file: { ...file, latest: version }, version, created: true };
    });
  } finally {
    await staged.discard();
  }
}

type Tx = Parameters<Parameters<ReturnType<typeof getDatabase>['transaction']>[0]>[0];

/**
 * The lock every writer of one file's versions takes, whatever it is doing —
 * upload, restore, import — so version numbers are handed out one at a time.
 */
export async function lockFileName(tx: Tx, pageId: string, name: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`file:${pageId}:${name.toLowerCase()}`}, 0))`);
}

/**
 * The lock around a workspace's quota: the check and the blob row it admits
 * happen under it, so uploads side by side cannot each see room for itself.
 * Always taken after a file-name lock, never before, so the two cannot deadlock.
 */
export async function lockQuota(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`quota:${workspaceId}`}, 0))`);
}

export async function touchBlob(tx: Tx, workspaceId: string, sha256: string, byteSize: number): Promise<void> {
  await tx
    .insert(fileBlobs)
    .values({ workspaceId, sha256, byteSize, touchedAt: new Date() })
    .onConflictDoUpdate({
      target: [fileBlobs.workspaceId, fileBlobs.sha256],
      set: { touchedAt: sql`now()` },
    });
}

/**
 * Adds a version with the bytes of an older one: going back without rewriting
 * what anybody has already downloaded. Restoring the version that is already
 * the latest adds nothing.
 */
export async function restoreFileVersion(input: {
  workspaceId: string;
  fileId: string;
  version: number;
  note?: string | null;
  actor: FileActor;
}): Promise<UploadFileResult> {
  const store = requireStore();
  const note = checkNote(input.note);

  return getDatabase().transaction(async (tx) => {
    const [named] = await tx
      .select({ pageId: pageFiles.pageId, name: pageFiles.name })
      .from(pageFiles)
      .where(and(eq(pageFiles.id, input.fileId), eq(pageFiles.workspaceId, input.workspaceId)))
      .limit(1);
    if (!named) throw new PageServiceError('not_found', 'File not found');
    await lockFileName(tx, named.pageId, named.name);
    const [file] = await tx
      .select(fileColumns)
      .from(pageFiles)
      .where(and(eq(pageFiles.id, input.fileId), eq(pageFiles.workspaceId, input.workspaceId)))
      .limit(1);
    if (!file) throw new PageServiceError('not_found', 'File not found');

    const [source] = await tx
      .select(versionColumns)
      .from(pageFileVersions)
      .where(and(eq(pageFileVersions.fileId, file.id), eq(pageFileVersions.version, input.version)))
      .limit(1);
    if (!source) {
      throw new PageServiceError('not_found', `The file has no version ${input.version}`, {
        latest_version: file.latestVersion,
      });
    }

    const [latest] = await tx
      .select(versionColumns)
      .from(pageFileVersions)
      .where(and(eq(pageFileVersions.fileId, file.id), eq(pageFileVersions.version, file.latestVersion)))
      .limit(1);
    if (!latest) throw new Error('file has no latest version');
    if (latest.sha256 === source.sha256) return { file: { ...file, latest }, version: latest, created: false };

    await touchBlob(tx, input.workspaceId, source.sha256, source.byteSize);
    if (!(await store.has(blobKey(input.workspaceId, source.sha256)))) {
      throw new PageServiceError('conflict', `The bytes of version ${input.version} are missing from the file store`);
    }

    const now = new Date();
    const [updated] = await tx
      .update(pageFiles)
      .set({ latestVersion: file.latestVersion + 1, updatedAt: now })
      .where(eq(pageFiles.id, file.id))
      .returning(fileColumns);
    if (!updated) throw new Error('file update returned no row');

    const [version] = await tx
      .insert(pageFileVersions)
      .values({
        workspaceId: input.workspaceId,
        fileId: file.id,
        version: updated.latestVersion,
        sha256: source.sha256,
        byteSize: source.byteSize,
        contentType: source.contentType,
        note: note ?? `Restored version ${source.version}`,
        restoredFrom: source.version,
        createdByType: input.actor.type,
        createdById: input.actor.id,
        createdByLabel: input.actor.label,
        createdAt: now,
      })
      .returning(versionColumns);
    if (!version) throw new Error('file version insert returned no row');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'file.version_restored',
        target: file.id,
        metadata: { name: file.name, version: version.version, restoredFrom: source.version, sha256: source.sha256 },
      },
      tx,
    );

    return { file: { ...updated, latest: version }, version, created: true };
  });
}

/**
 * One file and the space that decides who sees it, or `null` for a file that
 * is not in this workspace or whose page has been deleted.
 */
export async function getFileAccess(workspaceId: string, fileId: string): Promise<FileAccess | null> {
  const [row] = await getDatabase()
    .select({ ...fileColumns, spaceId: pages.spaceId, latest: versionColumns })
    .from(pageFiles)
    .innerJoin(pages, and(eq(pages.id, pageFiles.pageId), sql`${pages.deletedAt} is null`))
    .innerJoin(
      pageFileVersions,
      and(eq(pageFileVersions.fileId, pageFiles.id), eq(pageFileVersions.version, pageFiles.latestVersion)),
    )
    .where(and(eq(pageFiles.id, fileId), eq(pageFiles.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** The file called `name` on a page, in any case, or `null`. */
export async function getFileByName(workspaceId: string, pageId: string, name: string): Promise<FileAccess | null> {
  const normalized = normalizeFileName(name);
  const [row] = await getDatabase()
    .select({ id: pageFiles.id })
    .from(pageFiles)
    .where(
      and(
        eq(pageFiles.workspaceId, workspaceId),
        eq(pageFiles.pageId, pageId),
        sql`lower(${pageFiles.name}) = lower(${normalized})`,
      ),
    )
    .limit(1);
  return row ? getFileAccess(workspaceId, row.id) : null;
}

/** A page's files, by name, each with its latest version. */
export async function listPageFiles(workspaceId: string, pageId: string): Promise<FileRecord[]> {
  return getDatabase()
    .select({ ...fileColumns, latest: versionColumns })
    .from(pageFiles)
    .innerJoin(
      pageFileVersions,
      and(eq(pageFileVersions.fileId, pageFiles.id), eq(pageFileVersions.version, pageFiles.latestVersion)),
    )
    .where(and(eq(pageFiles.workspaceId, workspaceId), eq(pageFiles.pageId, pageId)))
    .orderBy(asc(sql`lower(${pageFiles.name})`));
}

/** Every version of a file, newest first. */
export async function listFileVersions(workspaceId: string, fileId: string): Promise<FileVersionRecord[]> {
  return getDatabase()
    .select(versionColumns)
    .from(pageFileVersions)
    .where(and(eq(pageFileVersions.workspaceId, workspaceId), eq(pageFileVersions.fileId, fileId)))
    .orderBy(desc(pageFileVersions.version));
}

export async function getFileVersion(
  workspaceId: string,
  fileId: string,
  version: number,
): Promise<FileVersionRecord | null> {
  const [row] = await getDatabase()
    .select(versionColumns)
    .from(pageFileVersions)
    .where(
      and(
        eq(pageFileVersions.workspaceId, workspaceId),
        eq(pageFileVersions.fileId, fileId),
        eq(pageFileVersions.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The bytes of a version the caller has already been allowed to see, or a range of them. */
export async function openFileVersion(
  workspaceId: string,
  version: FileVersionRecord,
  range?: BlobRange,
): Promise<ReadableStream<Uint8Array> | null> {
  return requireStore().read(blobKey(workspaceId, version.sha256), range);
}

/**
 * Removes a file with every version of it. Like an image, this is not soft:
 * the usual reason to remove a file is what is in it. The bytes go with the
 * next sweep, unless another version somewhere still has them.
 */
export async function deleteFile(input: { workspaceId: string; fileId: string; actor: FileActor }): Promise<boolean> {
  return getDatabase().transaction(async (tx) => {
    const [removed] = await tx
      .delete(pageFiles)
      .where(and(eq(pageFiles.id, input.fileId), eq(pageFiles.workspaceId, input.workspaceId)))
      .returning({ id: pageFiles.id, pageId: pageFiles.pageId, name: pageFiles.name, versions: pageFiles.latestVersion });
    if (!removed) return false;

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'file.deleted',
        target: removed.id,
        metadata: { pageId: removed.pageId, name: removed.name, versions: removed.versions },
      },
      tx,
    );
    return true;
  });
}

/** Every version of every file on a page, newest first: what the page's files panel shows. */
export async function listFileVersionsForPage(workspaceId: string, pageId: string): Promise<FileVersionRecord[]> {
  return getDatabase()
    .select(versionColumns)
    .from(pageFileVersions)
    .innerJoin(pageFiles, eq(pageFiles.id, pageFileVersions.fileId))
    .where(and(eq(pageFiles.workspaceId, workspaceId), eq(pageFiles.pageId, pageId)))
    .orderBy(desc(pageFileVersions.version));
}

export interface ImportedVersion {
  sha256: string;
  byteSize: number;
  contentType: string;
  note: string | null;
  /** When the source says this version was made; now when it does not say. */
  createdAt: Date | null;
  /** Who the source says made it, shown instead of the importing person. */
  authorLabel: string | null;
}

/**
 * Gives a page a file whose versions an import already put in the store: the
 * history of an attachment, carried across as it was at the source.
 *
 * The bytes are not read again — each version names a blob that was staged,
 * size-checked and counted against the quota while the import was read. Each
 * version is added the way an upload is, under the same lock, so a page that
 * already has the name (an import that overwrites) gets the imported versions
 * after its own, and one that equals the latest adds nothing. A version whose
 * bytes are no longer in the store is left out and counted.
 */
export async function attachImportedFile(input: {
  workspaceId: string;
  pageId: string;
  name: string;
  versions: readonly ImportedVersion[];
  actor: FileActor;
}): Promise<{ fileId: string | null; added: number; missing: number }> {
  const store = requireStore();
  const name = checkFileName(input.name);

  return getDatabase().transaction(async (tx) => {
    await lockFileName(tx, input.pageId, name);
    const [existing] = await tx
      .select(fileColumns)
      .from(pageFiles)
      .where(and(eq(pageFiles.pageId, input.pageId), sql`lower(${pageFiles.name}) = lower(${name})`))
      .limit(1);

    let file: Omit<FileRecord, 'latest'> | null = existing ?? null;
    let latestSha: string | null = null;
    if (file) {
      const [latest] = await tx
        .select({ sha256: pageFileVersions.sha256 })
        .from(pageFileVersions)
        .where(and(eq(pageFileVersions.fileId, file.id), eq(pageFileVersions.version, file.latestVersion)))
        .limit(1);
      latestSha = latest?.sha256 ?? null;
    }

    let added = 0;
    let missing = 0;
    for (const version of input.versions) {
      if (version.sha256 === latestSha) continue;
      await touchBlob(tx, input.workspaceId, version.sha256, version.byteSize);
      if (!(await store.has(blobKey(input.workspaceId, version.sha256)))) {
        missing += 1;
        continue;
      }
      const at = version.createdAt ?? new Date();
      if (file === null) {
        const [created] = await tx
          .insert(pageFiles)
          .values({
            workspaceId: input.workspaceId,
            pageId: input.pageId,
            name,
            latestVersion: 1,
            createdByType: input.actor.type,
            createdById: input.actor.id,
            createdAt: at,
            updatedAt: at,
          })
          .returning(fileColumns);
        if (!created) throw new Error('file insert returned no row');
        file = created;
      } else {
        const [updated] = await tx
          .update(pageFiles)
          .set({ latestVersion: file.latestVersion + 1, updatedAt: at })
          .where(eq(pageFiles.id, file.id))
          .returning(fileColumns);
        if (!updated) throw new Error('file update returned no row');
        file = updated;
      }
      await tx.insert(pageFileVersions).values({
        workspaceId: input.workspaceId,
        fileId: file.id,
        version: file.latestVersion,
        sha256: version.sha256,
        byteSize: version.byteSize,
        contentType: version.contentType,
        // A source's comment is kept, cut to what a note may hold rather than refused.
        note: version.note === null || version.note.trim() === '' ? null : [...version.note.trim()].slice(0, MAX_NOTE_LENGTH).join(''),
        createdByType: input.actor.type,
        createdById: input.actor.id,
        createdByLabel: version.authorLabel ?? input.actor.label,
        createdAt: at,
      });
      latestSha = version.sha256;
      added += 1;
    }

    if (file !== null && added > 0) {
      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'file.imported',
          target: file.id,
          metadata: { pageId: input.pageId, name: file.name, versions: added, missing },
        },
        tx,
      );
    }
    return { fileId: file?.id ?? null, added, missing };
  });
}
