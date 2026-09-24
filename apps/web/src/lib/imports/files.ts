import 'server-only';

import { asc, eq, sql } from 'drizzle-orm';
import { fileBlobs, importFileVersions } from '@clewwiki/db';
import { blobKey, BlobTooLargeError, contentTypeOf, EmptyBlobError, fileNameProblem, normalizeFileName } from '@clewwiki/files';
import { referencedFileKeys, warn } from '@clewwiki/import';
import type { FileSink, ImportAsset, ImportFileVersion, ImportNode, ImportWarning } from '@clewwiki/import';

import { getDatabase } from '../db';
import { attachImportedFile, lockQuota, touchBlob } from '../files/service';
import type { ImportedVersion } from '../files/service';
import { fileLimits, getFileStore } from '../files/store';

/**
 * The files of an import, between the source and the pages.
 *
 * An attachment can be far larger than anything an import holds in memory or
 * in a table, so each version goes into the file store the moment it is
 * downloaded, and a row in `import_file_versions` holds on to it until the
 * import is applied — the blob sweep leaves alone any blob such a row names.
 * The rules are an upload's: the instance's size limit, room in the
 * workspace's store (each distinct content counted once), a name that can be a
 * file name. One more is an import's own: a download of another size than the
 * source's record of that version is not that version, and is refused.
 *
 * Applying turns a page's rows into its files, in the order they were read;
 * cancelling, deleting or a failed read drops the rows, and the sweep takes the
 * bytes an hour later.
 */

const MB = 1024 * 1024;

/** A sink for one import, or `undefined` when attached files are switched off. */
export function createImportFileSink(input: { workspaceId: string; importId: string }): FileSink | undefined {
  const store = getFileStore();
  if (store === null) return undefined;
  const limits = fileLimits();

  return {
    maxFileBytes: limits.uploadBytes,

    async store(version: ImportFileVersion, body: ReadableStream<Uint8Array>) {
      const name = normalizeFileName(version.name);
      const problem = fileNameProblem(name);
      if (problem !== null) {
        await body.cancel().catch(() => undefined);
        return { refused: problem.toLowerCase() };
      }

      let staged;
      try {
        staged = await store.stage(body, { maxBytes: limits.uploadBytes });
      } catch (error) {
        if (error instanceof BlobTooLargeError) {
          return { refused: `larger than the ${Math.round(limits.uploadBytes / MB)} MB this instance takes` };
        }
        if (error instanceof EmptyBlobError) return { refused: 'empty' };
        return { refused: 'the download was cut off' };
      }

      try {
        if (version.expectedBytes !== null && staged.byteSize !== version.expectedBytes) {
          return { refused: `version ${version.sourceVersion} was not served as the source records it` };
        }
        if (version.rejectSha256 && staged.sha256 === version.rejectSha256) {
          return { refused: `version ${version.sourceVersion} was served as the current bytes` };
        }
        return await getDatabase().transaction(async (tx) => {
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
            return { refused: 'the file store of this workspace is full' };
          }

          // Row first, bytes second, as for an upload: the sweep takes the
          // row's lock before it removes a blob.
          await touchBlob(tx, input.workspaceId, staged.sha256, staged.byteSize);
          await staged.commit(blobKey(input.workspaceId, staged.sha256));
          await tx.insert(importFileVersions).values({
            importId: input.importId,
            workspaceId: input.workspaceId,
            sourceId: version.sourceId,
            name,
            position: version.position,
            sha256: staged.sha256,
            byteSize: staged.byteSize,
            contentType: contentTypeOf(name, version.mediaType),
            note: version.note,
            sourceVersion: version.sourceVersion,
            sourceAuthor: version.author,
            sourceCreatedAt: version.createdAt,
            sourceKey: version.sourceKey ?? null,
          });
          return { kept: true as const, sha256: staged.sha256 };
        });
      } finally {
        await staged.discard();
      }
    },
  };
}

/** The staged files of an import, dropped: the bytes go with the next sweep. */
export async function dropStagedFiles(importId: string): Promise<void> {
  await getDatabase().delete(importFileVersions).where(eq(importFileVersions.importId, importId));
}

/** How many files, and versions of them, an import staged. */
export async function countStagedFiles(importId: string): Promise<{ files: number; versions: number }> {
  const [row] = await getDatabase()
    .select({
      files: sql<string>`count(distinct (${importFileVersions.sourceId}, lower(${importFileVersions.name})))`,
      versions: sql<string>`count(*)`,
    })
    .from(importFileVersions)
    .where(eq(importFileVersions.importId, importId));
  return { files: Number(row?.files ?? 0), versions: Number(row?.versions ?? 0) };
}

/**
 * Gives a page the files its source page had, from what the import staged for
 * `sourceId`. Answers how many files and versions landed.
 */
export async function carryFiles(input: {
  workspaceId: string;
  importId: string;
  sourceId: string;
  pageId: string;
  actor: { type: 'user'; id: string };
  sourceLabel: string;
}): Promise<{ files: number; versions: number; failed: number }> {
  const rows = await getDatabase()
    .select()
    .from(importFileVersions)
    .where(sql`${importFileVersions.importId} = ${input.importId} and ${importFileVersions.sourceId} = ${input.sourceId}`)
    .orderBy(asc(importFileVersions.position));
  if (rows.length === 0) return { files: 0, versions: 0, failed: 0 };

  const byName = new Map<string, { name: string; versions: ImportedVersion[] }>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const group = byName.get(key) ?? { name: row.name, versions: [] };
    group.versions.push({
      sha256: row.sha256,
      byteSize: row.byteSize,
      contentType: row.contentType,
      note: row.note,
      createdAt: row.sourceCreatedAt,
      authorLabel: row.sourceAuthor ?? input.sourceLabel,
    });
    byName.set(key, group);
  }

  let files = 0;
  let versions = 0;
  let failed = 0;
  for (const group of byName.values()) {
    try {
      const attached = await attachImportedFile({
        workspaceId: input.workspaceId,
        pageId: input.pageId,
        name: group.name,
        versions: group.versions,
        actor: { ...input.actor, label: input.sourceLabel },
      });
      if (attached.added > 0) files += 1;
      versions += attached.added;
      failed += attached.missing;
    } catch {
      failed += group.versions.length;
    }
  }
  return { files, versions, failed };
}

/**
 * Stages the files an archive's documents link to, each as a file of every
 * page that links to it, and answers the warnings for what was not staged.
 *
 * A name is the file's own name in the archive. Two different files a page
 * links to under the same name — `a/spec.pdf` and `b/spec.pdf` — would be one
 * file in versions on that page, which they are not, so the second is renamed
 * `spec (2).pdf`; the link that pointed at it is rewritten to that name when
 * the import is applied.
 */
export async function stageArchiveFiles(input: {
  workspaceId: string;
  importId: string;
  nodes: readonly ImportNode[];
  fileAssets: readonly ImportAsset[];
}): Promise<Map<string, ImportWarning[]>> {
  const warnings = new Map<string, ImportWarning[]>();
  if (input.fileAssets.length === 0) return warnings;
  const byKey = new Map(input.fileAssets.map((asset) => [asset.key, asset]));
  const sink = createImportFileSink({ workspaceId: input.workspaceId, importId: input.importId });
  const note = (sourceId: string, warning: ImportWarning) =>
    warnings.set(sourceId, [...(warnings.get(sourceId) ?? []), warning]);

  for (const node of input.nodes) {
    const taken = new Set<string>();
    let position = 0;
    for (const key of referencedFileKeys(node.markdown)) {
      const asset = byKey.get(key);
      if (!asset) continue;
      const base = key.slice(key.lastIndexOf('/') + 1);
      if (sink === undefined) {
        note(node.sourceId, warn('file-skipped', `${base}: files are switched off on this instance`));
        continue;
      }
      const name = uniqueName(base, taken);
      taken.add(name.toLowerCase());
      const data = asset.data;
      const stored = await sink.store(
        {
          sourceId: node.sourceId,
          name,
          position,
          mediaType: null,
          expectedBytes: null,
          note: null,
          sourceVersion: 1,
          author: null,
          createdAt: null,
          sourceKey: key,
        },
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        }),
      );
      if ('refused' in stored) note(node.sourceId, warn('file-skipped', `${base}: ${stored.refused}`));
      else position += 1;
    }
  }
  return warnings;
}

function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The names the staged files of one source page carry, by the key its body links to them with. */
export async function stagedFileNames(importId: string, sourceId: string): Promise<Map<string, string>> {
  const rows = await getDatabase()
    .select({ key: importFileVersions.sourceKey, name: importFileVersions.name })
    .from(importFileVersions)
    .where(sql`${importFileVersions.importId} = ${importId} and ${importFileVersions.sourceId} = ${sourceId}`);
  const names = new Map<string, string>();
  for (const row of rows) if (row.key !== null) names.set(row.key, row.name);
  return names;
}
