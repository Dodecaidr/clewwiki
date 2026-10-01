import 'server-only';

/**
 * Reading a Google Sheet or Google Doc by its link.
 *
 * Only documents shared as "anyone with the link" can be read — there is no
 * Google account on the server side, by design: connecting one would make
 * every member's import run as that account. The address is never fetched as
 * given. The document id is taken out of it and the export URL is built here,
 * on docs.google.com; the one redirect Google answers with may only lead to
 * its own content host. So the link chooses a document, never a host.
 */

export type GoogleDocument = { kind: 'sheet'; id: string } | { kind: 'doc'; id: string };

export class GoogleImportError extends Error {
  constructor(readonly code: 'notGoogle' | 'notPublic' | 'tooLarge' | 'unavailable') {
    super(code);
    this.name = 'GoogleImportError';
  }
}

const ID = /^[A-Za-z0-9_-]{20,100}$/;

export function parseGoogleUrl(raw: string): GoogleDocument | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
  const match = /^\/(spreadsheets|document)\/(?:u\/\d+\/)?d\/([^/]+)/.exec(url.pathname);
  const id = match?.[2];
  if (!match || !id || !ID.test(id)) return null;
  return match[1] === 'spreadsheets' ? { kind: 'sheet', id } : { kind: 'doc', id };
}

export function exportUrl(document: GoogleDocument): string {
  return document.kind === 'sheet'
    ? `https://docs.google.com/spreadsheets/d/${document.id}/export?format=xlsx`
    : `https://docs.google.com/document/d/${document.id}/export?format=md`;
}

function allowedHost(hostname: string): boolean {
  return hostname === 'docs.google.com' || hostname.endsWith('.googleusercontent.com');
}

/** Downloads the export, at most `maxBytes`, following only Google's own redirects. */
export async function fetchGoogleExport(
  document: GoogleDocument,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  let url = exportUrl(document);
  for (let hop = 0; hop < 5; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new GoogleImportError('unavailable');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      const next = location ? new URL(location, url) : null;
      if (!next || next.protocol !== 'https:' || !allowedHost(next.hostname)) {
        throw new GoogleImportError('notPublic');
      }
      // A redirect to the sign-in page means the document is not shared by link.
      if (next.hostname === 'accounts.google.com' || next.pathname.startsWith('/ServiceLogin')) {
        throw new GoogleImportError('notPublic');
      }
      url = next.toString();
      continue;
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new GoogleImportError('notPublic');
    }
    if (!response.ok || !response.body) throw new GoogleImportError('unavailable');
    // The sign-in page comes back as HTML with a 200 on some paths.
    if ((response.headers.get('content-type') ?? '').includes('text/html')) {
      throw new GoogleImportError('notPublic');
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new GoogleImportError('tooLarge');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GoogleImportError('tooLarge');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  throw new GoogleImportError('unavailable');
}

/**
 * A Google Doc's Markdown export, cleaned for a page: images come as inline
 * `data:` URIs the page renderer refuses, so they are taken out and counted.
 */
export function cleanGoogleDocMarkdown(markdown: string): { markdown: string; droppedImages: number } {
  let dropped = 0;
  const cleaned = markdown
    // Reference definitions holding the image bytes: `[image1]: <data:image/png;base64,...>`
    .replace(/^\[[^\]]+\]:\s*<?data:[^\n]*$/gm, () => {
      dropped += 1;
      return '';
    })
    // Their uses, and inline data images.
    .replace(/!\[[^\]]*\]\[[^\]]+\]/g, '')
    .replace(/!\[[^\]]*\]\(\s*<?data:[^)]*\)/g, () => {
      dropped += 1;
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown: cleaned, droppedImages: dropped };
}
