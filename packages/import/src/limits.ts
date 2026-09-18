/**
 * The bounds an import is held to, and the one error type the adapters raise.
 *
 * They are here rather than in the request handler because the adapters enforce
 * them while they parse: a 200 MB ZIP that expands to 40 GB has to be refused
 * while it is being read, not after. The handler re-states the upload limit at
 * the edge so a request that is too large never reaches an adapter at all.
 */

export interface ImportLimits {
  /** Largest upload accepted, in bytes. */
  uploadBytes: number;
  /** Most pages one import may stage. */
  pages: number;
  /** Largest Markdown body per page, in bytes of UTF-8. */
  pageBytes: number;
  /** Largest total size of a ZIP once expanded, in bytes. */
  expandedBytes: number;
  /** Most entries a ZIP may hold, compressed junk included. */
  zipEntries: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  uploadBytes: 200 * 1024 * 1024,
  pages: 5_000,
  pageBytes: 10 * 1024 * 1024,
  // What is expanded is held in memory until the import is staged, so this is
  // sized by what a small container can spare rather than by what an archive
  // might hold. Only Markdown and CSV entries are expanded at all — images and
  // attachments are never read — and a quarter of a gigabyte of those is more
  // documentation than any space has. An instance with memory to spare raises
  // it (`IMPORT_MAX_EXPANDED_MB`).
  expandedBytes: 256 * 1024 * 1024,
  zipEntries: 20_000,
};

/**
 * A refusal a caller can act on.
 *
 * Everything an adapter raises deliberately is one of these; anything else is a
 * bug and reaches the handler as a plain 500. `code` matches the REST error
 * vocabulary, so a handler can pass it straight through.
 */
export class ImportError extends Error {
  readonly code: 'validation' | 'unavailable';
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: 'validation' | 'unavailable',
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.details = details;
  }
}

export function isImportError(value: unknown): value is ImportError {
  return value instanceof ImportError;
}

/** Bytes of UTF-8, which is what the limits are expressed in. */
export function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Cuts a body to the per-page limit on a character boundary, so a truncated
 * page is still valid text rather than half a code point.
 */
export function truncateToBytes(value: string, limit: number): string {
  if (utf8Length(value) <= limit) return value;
  const buffer = Buffer.from(value, 'utf8').subarray(0, limit);
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(/�+$/u, '');
}
