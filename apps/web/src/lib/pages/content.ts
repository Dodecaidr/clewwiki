import { createHash } from 'node:crypto';

/**
 * Content hashing.
 *
 * The hash is the identity of a page body as a caller last saw it. It is
 * returned on every read and accepted back on a write, so a client that missed
 * an intervening edit is told so instead of overwriting it. Phase 3 turns that
 * into the mandatory half of the claim protocol; the shape does not change.
 *
 * The body is hashed exactly as stored — no trimming, no newline rewriting —
 * because a hash that ignores part of the content cannot detect a change to
 * that part.
 */
export function computeContentHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** True when `body` still hashes to `expected`, compared as plain strings. */
export function matchesContentHash(body: string, expected: string): boolean {
  return computeContentHash(body) === expected;
}

/** Shape of a hex SHA-256 digest, used to reject malformed input early. */
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isContentHash(value: string): boolean {
  return CONTENT_HASH_PATTERN.test(value);
}
