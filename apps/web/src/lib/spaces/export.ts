import { PageServiceError } from '../pages/errors';
import { exportPageMarkdown } from '../pages/export';
import { pathSegments } from '../pages/paths';
import type { PageRecord } from '../pages/service';
import { fileHref } from '../files/urls';
import type { FileRecord, FileVersionRecord } from '../files/service';
import { createZip } from './zip';
import type { ZipEntry } from './zip';
import { createZipStream, ZipBudget } from './zip-stream';
import type { StreamedZipEntry } from './zip-stream';

/**
 * Space export: every live page of a space as Markdown, in a ZIP archive whose
 * folders mirror the page tree.
 *
 * A page at `/backend/auth` in space `API` becomes `API/backend/auth.md`, and
 * its parent `/backend` becomes `API/backend.md` next to the `backend/` folder
 * holding its children — so a page with children and the folder of those
 * children never collide, and unpacking the archive gives the tree back. Each
 * file is the same Markdown the single-page export produces, front matter
 * included. Path segments are already restricted to `[a-z0-9-]`, so nothing in
 * a page path can escape the archive's folder.
 */

/** Bodies are held in memory while the archive is built; this bounds that. */
export const MAX_SPACE_EXPORT_BYTES = 64 * 1024 * 1024;

export interface ExportedSpace {
  filename: string;
  contentType: string;
  body: Uint8Array;
  pageCount: number;
}

export function spaceExportEntryName(spaceKey: string, pagePath: string): string {
  const segments = pathSegments(pagePath);
  if (segments.length === 0) throw new PageServiceError('validation', 'A page has an empty path');
  return `${spaceKey}/${segments.join('/')}.md`;
}

export function exportSpaceMarkdown(
  space: { key: string },
  pages: readonly PageRecord[],
): ExportedSpace {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  let total = 0;

  for (const page of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    const markdown = exportPageMarkdown(page, space);
    const data = encoder.encode(markdown.body);
    total += data.length;
    if (total > MAX_SPACE_EXPORT_BYTES) {
      throw new PageServiceError('validation', 'This space is too large to export in one archive', {
        limit_bytes: MAX_SPACE_EXPORT_BYTES,
      });
    }
    entries.push({
      name: spaceExportEntryName(space.key, page.path),
      data,
      modifiedAt: page.updatedAt,
    });
  }

  return {
    filename: `${space.key}.zip`,
    contentType: 'application/zip',
    body: createZip(entries),
    pageCount: entries.length,
  };
}

export interface ExportedSpaceStream {
  filename: string;
  contentType: string;
  body: ReadableStream<Uint8Array>;
}

/**
 * The same archive with the latest version of every file beside its page:
 * `API/backend/auth.md` and `API/backend/auth.files/spec.pdf`. The files are
 * streamed from the store into the archive as it is sent, so nothing is held.
 *
 * A file that would take the archive past what the classic ZIP format holds
 * is left out, and so is one whose bytes are missing from the store; neither
 * silently. `KEY/_files.json`, the last entry, lists every file with the
 * version, checksum and address it was taken from, and every file left out,
 * with the reason.
 */
export function exportSpaceWithFiles(
  space: { key: string },
  pages: readonly PageRecord[],
  listFiles: (pageId: string) => Promise<FileRecord[]>,
  open: (version: FileVersionRecord) => Promise<ReadableStream<Uint8Array> | null>,
): ExportedSpaceStream {
  const encoder = new TextEncoder();
  const budget = new ZipBudget();
  const included: Array<Record<string, unknown>> = [];
  const left: Array<Record<string, unknown>> = [];
  const missing = new Set<string>();

  // The pages are rendered before anything is sent, so a space too large to
  // export is a refusal and not an archive that breaks off half-way.
  const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
  const pageEntries: StreamedZipEntry[] = [];
  let total = 0;
  for (const page of sorted) {
    const data = encoder.encode(exportPageMarkdown(page, space).body);
    total += data.length;
    if (total > MAX_SPACE_EXPORT_BYTES) {
      throw new PageServiceError('validation', 'This space is too large to export in one archive', {
        limit_bytes: MAX_SPACE_EXPORT_BYTES,
      });
    }
    const name = spaceExportEntryName(space.key, page.path);
    budget.take(name, data.length);
    pageEntries.push({ name, data, modifiedAt: page.updatedAt });
  }

  async function* entries(): AsyncGenerator<StreamedZipEntry> {
    yield* pageEntries;
    for (const page of sorted) {
      const folder = spaceExportEntryName(space.key, page.path).replace(/\.md$/, '.files');
      let files: FileRecord[];
      try {
        files = await listFiles(page.id);
      } catch {
        left.push({ page_path: page.path, reason: 'the files of this page could not be listed' });
        continue;
      }
      for (const file of files) {
        const name = `${folder}/${file.name}`;
        const record = {
          path: name,
          page_path: page.path,
          name: file.name,
          version: file.latestVersion,
          bytes: file.latest.byteSize,
          sha256: file.latest.sha256,
          url: fileHref(page.id, file.name),
        };
        // Room is kept for the list itself, which is written last and grows
        // by a few hundred bytes with every file in it.
        if (!budget.fits(name, file.latest.byteSize, 1024 * 1024 + 512 * (included.length + left.length + 1))) {
          left.push({ ...record, reason: 'the archive would pass the 4 GiB a ZIP file holds' });
          continue;
        }
        budget.take(name, file.latest.byteSize);
        included.push(record);
        // A store that fails to open a file costs that file, not the archive:
        // the answer is already on its way, and a ZIP cut off has no directory.
        yield {
          name,
          size: file.latest.byteSize,
          modifiedAt: file.updatedAt,
          open: () => open(file.latest).catch(() => null),
        };
      }
    }
    const kept = included.filter((entry) => !missing.has(String(entry['path'])));
    const lost = included
      .filter((entry) => missing.has(String(entry['path'])))
      .map((entry) => ({ ...entry, reason: 'the bytes of this version could not be read from the file store' }));
    yield {
      name: `${space.key}/_files.json`,
      data: encoder.encode(`${JSON.stringify({ files: kept, left_out: [...left, ...lost] }, null, 2)}\n`),
      modifiedAt: new Date(),
    };
  }

  return {
    filename: `${space.key}-with-files.zip`,
    contentType: 'application/zip',
    body: createZipStream(entries(), (name) => missing.add(name)),
  };
}
