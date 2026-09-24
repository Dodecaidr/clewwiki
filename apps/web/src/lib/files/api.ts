import 'server-only';

import type { NextResponse } from 'next/server';

import { apiError } from '../api-response';
import { canSeeSpace } from '../api-auth';
import type { ApiIdentity } from '../api-auth';
import { actorOf } from '../pages-api';
import { openFileVersion } from './service';
import type { FileAccess, FileActor, FileRecord, FileTooLargeError, FileVersionRecord } from './service';
import { fileHref, fileVersionHref } from './urls';

export { fileHref, fileVersionHref } from './urls';

/**
 * What the file endpoints share: the resources in the API's snake_case, who a
 * caller is as the author of a version, and how a version's bytes are served.
 */

export function fileActorOf(identity: ApiIdentity): FileActor {
  return { ...actorOf(identity), label: identity.name };
}

/** Whether this caller may see this file: whoever can see its page's space. */
export function mayReadFile(identity: ApiIdentity, file: FileAccess): boolean {
  return file.workspaceId === identity.workspaceId && canSeeSpace(identity, file.spaceId);
}

export function toFileVersionResource(fileId: string, version: FileVersionRecord): Record<string, unknown> {
  return {
    version: version.version,
    bytes: version.byteSize,
    sha256: version.sha256,
    content_type: version.contentType,
    note: version.note,
    restored_from: version.restoredFrom,
    created_at: version.createdAt.toISOString(),
    created_by: { type: version.createdByType, id: version.createdById, label: version.createdByLabel },
    url: fileVersionHref(fileId, version.version),
  };
}

export function toFileResource(file: FileRecord): Record<string, unknown> {
  return {
    file_id: file.id,
    page_id: file.pageId,
    name: file.name,
    latest_version: file.latestVersion,
    bytes: file.latest.byteSize,
    content_type: file.latest.contentType,
    sha256: file.latest.sha256,
    created_at: file.createdAt.toISOString(),
    updated_at: file.updatedAt.toISOString(),
    url: fileHref(file.pageId, file.name),
    latest: toFileVersionResource(file.id, file.latest),
  };
}

export function fileTooLargeResponse(error: FileTooLargeError): NextResponse {
  return apiError(413, 'validation', error.message, { bytes: error.bytes, limit: error.limit });
}

/** `?version=` as a positive integer, `null` when absent, `undefined` when malformed. */
export function versionParam(url: URL): number | null | undefined {
  const raw = url.searchParams.get('version');
  if (raw === null || raw === '' || raw === 'latest') return null;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) return undefined;
  return Number(raw);
}

/**
 * `Content-Disposition` for a download: always an attachment, with an ASCII
 * fallback name and the real one in RFC 5987 form.
 */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

/** One `bytes=` range, the only kind served; anything else is answered in full. */
export function parseRange(header: string | null, size: number): ParsedRange {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (from === '' && to === '') return null;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * A version's bytes, as a download and as nothing else.
 *
 * These are bytes somebody uploaded, served from the application's own
 * origin, so the response is fenced in the way an image is — sniffing off, a
 * sandbox that loads nothing, no embedding from other origins — and, unlike an
 * image, it is always an attachment: a file is never rendered in the page that
 * links to it. A single byte range is honoured, so a large download can resume.
 */
export async function serveFileVersion(
  request: Request,
  workspaceId: string,
  file: { id: string; name: string },
  version: FileVersionRecord,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const etag = `"${version.sha256}"`;
  const headers: Record<string, string> = {
    ...extraHeaders,
    'Content-Type': version.contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': attachmentDisposition(file.name),
    'Cache-Control': 'private, no-cache',
    'Accept-Ranges': 'bytes',
    'X-File-Id': file.id,
    'X-File-Version': String(version.version),
    ETag: etag,
  };

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  const ifRange = request.headers.get('if-range');
  const range = ifRange !== null && ifRange !== etag ? null : parseRange(request.headers.get('range'), version.byteSize);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${version.byteSize}` } });
  }

  const stream = await openFileVersion(workspaceId, version, range ?? undefined);
  if (stream === null) {
    console.error(`[files] the bytes of file ${file.id} version ${version.version} are missing from the store`);
    return apiError(500, 'internal_error', 'The file could not be read');
  }

  if (range === null) {
    return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(version.byteSize) } });
  }
  return new Response(stream, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${version.byteSize}`,
    },
  });
}
