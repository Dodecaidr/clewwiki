/**
 * Images that travel with an import.
 *
 * A Notion export and a folder of Markdown carry their pictures inside the
 * archive, next to the documents that show them. An adapter hands back the
 * bytes of every image a document actually refers to (`ImportAsset`), and
 * writes the reference as a placeholder — `clewwiki-import-image:<key>` — for
 * the same reason a link between two imported pages is one: where the image
 * will live is not known until the import is applied, because an image belongs
 * to a page and the page does not exist yet.
 *
 * What is an image is decided twice. Here, by extension, because that is all a
 * pure library can say cheaply about an archive entry; and by whoever stores
 * it, from the bytes. An entry that is refused there keeps its placeholder, and
 * the placeholder resolves back to the path the document used — a broken image
 * a reviewer was warned about, which is what every image used to be.
 */

/** Extensions of the formats the image store takes. SVG is not one of them. */
export const IMPORTABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
]);

export const IMAGE_SCHEME = 'clewwiki-import-image:';

/** One image an import brings with it. */
export interface ImportAsset {
  /**
   * What placeholders refer to, and what an image that is not carried falls
   * back to: its path inside the archive, or — from Confluence — the address
   * it can still be opened at.
   */
  key: string;
  data: Uint8Array;
}

/**
 * A source id or an asset key, made safe to sit inside `(...)`.
 * `encodeURIComponent` leaves parentheses alone, and `Untitled (1).png` is what
 * half the screenshots in a Notion export are called.
 */
export function encodeDestination(value: string): string {
  return encodeURIComponent(value).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export function imagePlaceholderFor(key: string): string {
  return `${IMAGE_SCHEME}${encodeDestination(key)}`;
}

const IMAGE_PLACEHOLDER = /clewwiki-import-image:([^)\s"]*)/g;

function decodeKey(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Every asset key a body refers to, once each, in the order they appear. */
export function referencedImageKeys(markdown: string): string[] {
  const keys = new Set<string>();
  for (const match of markdown.matchAll(IMAGE_PLACEHOLDER)) keys.add(decodeKey(match[1] ?? ''));
  return [...keys];
}

/** Replaces every image placeholder with the address `resolve` gives its key. */
export function rewriteImages(markdown: string, resolve: (key: string) => string): string {
  return markdown.replace(IMAGE_PLACEHOLDER, (_match, encoded: string) => resolve(decodeKey(encoded)));
}

/**
 * The address an image falls back to when it was not carried across: its key,
 * escaped so it is still one Markdown destination and still names the file
 * rather than a fragment or a query of it.
 */
export function archivePathHref(key: string): string {
  return encodeURI(key)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

/**
 * Files other than images travel the same way: a link a document makes to a
 * file in its archive becomes `clewwiki-import-file:<key>`, the file becomes
 * one of that page's files when the import is applied, and the link is then
 * rewritten to the file's own address. A file that is not carried falls back,
 * like an image, to the path the document used.
 */
export const FILE_SCHEME = 'clewwiki-import-file:';

export function filePlaceholderFor(key: string): string {
  return `${FILE_SCHEME}${encodeDestination(key)}`;
}

const FILE_PLACEHOLDER = /clewwiki-import-file:([^)\s"]*)/g;

/** Every file key a body links to, once each, in the order they appear. */
export function referencedFileKeys(markdown: string): string[] {
  const keys = new Set<string>();
  for (const match of markdown.matchAll(FILE_PLACEHOLDER)) keys.add(decodeKey(match[1] ?? ''));
  return [...keys];
}

/** Replaces every file placeholder with the address `resolve` gives its key. */
export function rewriteFiles(markdown: string, resolve: (key: string) => string): string {
  return markdown.replace(FILE_PLACEHOLDER, (_match, encoded: string) => resolve(decodeKey(encoded)));
}
