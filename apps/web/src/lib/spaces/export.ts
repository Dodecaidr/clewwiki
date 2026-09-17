import { PageServiceError } from '../pages/errors';
import { exportPageMarkdown } from '../pages/export';
import { pathSegments } from '../pages/paths';
import type { PageRecord } from '../pages/service';
import { createZip } from './zip';
import type { ZipEntry } from './zip';

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
