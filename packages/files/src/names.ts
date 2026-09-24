/**
 * File names and the types files are labelled with.
 *
 * A name is what a person reads and what an agent asks for, never a path: the
 * bytes are stored under their hash, so a name reaches the file system nowhere
 * and only has to be something that is safe to put in a download header and
 * unambiguous in a list. Uploading a name that is already on the page makes a
 * new version of that file, so two names that a person would take for the same
 * file — differing only in case or in Unicode composition — are the same file.
 */

export const MAX_FILE_NAME_LENGTH = 200;

/** NFC, trimmed: the form a name is stored and compared in. */
export function normalizeFileName(name: string): string {
  return name.normalize('NFC').trim();
}

/** Why `name` cannot be a file name, or null when it can. Expects a normalized name. */
export function fileNameProblem(name: string): string | null {
  if (name === '') return 'A file name cannot be empty';
  if ([...name].length > MAX_FILE_NAME_LENGTH) return `A file name is at most ${MAX_FILE_NAME_LENGTH} characters`;
  if (name === '.' || name === '..') return 'A file name cannot be "." or ".."';
  if (/[/\\]/.test(name)) return 'A file name cannot contain / or \\';
  // Control characters, and the bidirectional overrides that make a name read
  // as something other than what it is (`invoice` + U+202E + `fdp.exe` reads as `invoiceexe.pdf`).
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)) {
    return 'A file name cannot contain control or text-direction characters';
  }
  return null;
}

const BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  log: 'text/plain',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/x-msi',
  deb: 'application/vnd.debian.binary-package',
  rpm: 'application/x-rpm',
  wasm: 'application/wasm',
};

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;

/**
 * The type a file is labelled with: what its extension says when it is a
 * known one, otherwise what the uploader declared when that is a well-formed
 * media type, otherwise `application/octet-stream`.
 *
 * It is a label and never an invitation: a file is always served as a
 * download, never rendered, so a wrong label costs a wrong icon and nothing
 * more.
 */
export function contentTypeOf(name: string, declared: string | null | undefined): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const known = BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
    if (known) return known;
  }
  const bare = declared?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (MEDIA_TYPE.test(bare) && bare !== 'application/x-www-form-urlencoded' && !bare.startsWith('multipart/')) {
    return bare;
  }
  return 'application/octet-stream';
}
