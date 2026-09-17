/**
 * Page paths.
 *
 * A page is addressed two ways at once: by `parent_id`, which is the edge a
 * move has to rewrite, and by a materialised path like `/backend/auth`, which
 * turns "everything under this page" into a single prefix scan. Every function
 * here is pure so that the rules governing both can be unit-tested without a
 * database.
 */

export const PATH_SEPARATOR = '/';
export const MAX_PATH_DEPTH = 12;
export const MAX_PATH_LENGTH = 512;
export const MAX_SEGMENT_LENGTH = 80;

/** A normalised segment: lowercase alphanumerics joined by single hyphens. */
export const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPathError';
  }
}

/**
 * Turns arbitrary text into one path segment.
 *
 * Diacritics are stripped by Unicode normalisation and every other non-ASCII
 * character is dropped, so a segment in a script with no ASCII form comes out
 * empty and is refused. This is the rule for a segment somebody typed; a
 * segment generated from a title goes through `generateSegment` in `./slug`,
 * which transliterates Cyrillic first and never comes out empty.
 */
export function slugifySegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/-+$/g, '');
}

function assertSegment(segment: string): string {
  if (segment.length === 0) {
    throw new InvalidPathError('Path segment is empty');
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    throw new InvalidPathError(`Path segment is longer than ${MAX_SEGMENT_LENGTH} characters`);
  }
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new InvalidPathError(
      `Path segment "${segment}" must be lowercase alphanumerics separated by single hyphens`,
    );
  }
  return segment;
}

/** Splits a path into its already-normalised segments. */
export function pathSegments(path: string): string[] {
  return path.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
}

/**
 * Canonical form of a path: leading slash, no trailing slash, every segment
 * slugified and validated. Throws `InvalidPathError` rather than repairing a
 * path it cannot make sense of, so a bad path never reaches the database.
 */
export function normalizePath(input: string): string {
  const segments = pathSegments(input.trim()).map((segment) =>
    assertSegment(slugifySegment(segment)),
  );

  if (segments.length === 0) {
    throw new InvalidPathError('Path must contain at least one segment');
  }
  if (segments.length > MAX_PATH_DEPTH) {
    throw new InvalidPathError(`Path is deeper than ${MAX_PATH_DEPTH} levels`);
  }

  const path = PATH_SEPARATOR + segments.join(PATH_SEPARATOR);
  if (path.length > MAX_PATH_LENGTH) {
    throw new InvalidPathError(`Path is longer than ${MAX_PATH_LENGTH} characters`);
  }
  return path;
}

/** Appends one segment to a parent path. `null` parent means the root. */
export function joinPath(parentPath: string | null, segment: string): string {
  const slug = assertSegment(slugifySegment(segment));
  if (parentPath === null) return normalizePath(slug);
  return normalizePath(`${parentPath}${PATH_SEPARATOR}${slug}`);
}

/** The path of the page directly above, or `null` at the root. */
export function parentPathOf(path: string): string | null {
  const segments = pathSegments(path);
  if (segments.length <= 1) return null;
  return PATH_SEPARATOR + segments.slice(0, -1).join(PATH_SEPARATOR);
}

/** The last segment of a path — the part a move keeps. */
export function lastSegment(path: string): string {
  const segments = pathSegments(path);
  const segment = segments.at(-1);
  if (segment === undefined) {
    throw new InvalidPathError('Path has no segments');
  }
  return segment;
}

export function pathDepth(path: string): number {
  return pathSegments(path).length;
}

/**
 * True when `candidate` sits anywhere below `ancestor`. A page is not its own
 * descendant, which is the check that stops a subtree being moved into itself.
 */
export function isDescendantPath(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return false;
  return candidate.startsWith(ancestor + PATH_SEPARATOR);
}

/**
 * Rewrites a descendant's path when its ancestor moves. Used to keep the whole
 * subtree consistent inside the transaction that performs the move.
 */
export function rewritePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (path === fromPrefix) return toPrefix;
  if (!isDescendantPath(path, fromPrefix)) {
    throw new InvalidPathError(`Path "${path}" is not below "${fromPrefix}"`);
  }
  return toPrefix + path.slice(fromPrefix.length);
}

/**
 * Escapes a path for use as a `LIKE` prefix pattern. Without this a page whose
 * path legitimately contains `_` would match its siblings, because `_` is a
 * single-character wildcard in `LIKE`.
 */
export function likePrefixPattern(path: string): string {
  return path.replace(/([\\%_])/g, '\\$1') + PATH_SEPARATOR + '%';
}
