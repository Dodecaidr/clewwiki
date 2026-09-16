import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Agent-token format and hashing. Kept free of database and framework imports
 * so it can be exercised directly by unit tests.
 *
 * A token looks like `cww_<prefix>.<secret>`:
 *
 *   - `prefix` is not secret. It is stored in the clear and indexed, so a
 *     lookup never has to scan or compare secrets in the database.
 *   - `secret` is 32 random bytes, base64url-encoded. Only its SHA-256 digest
 *     is stored, and the digest is compared in constant time.
 *
 * The separator between the two halves is `.`, which is deliberately outside
 * the base64url alphabet: `_` is a legal character inside both halves, so
 * using it to separate them would make the split ambiguous.
 *
 * The full token is shown to the operator exactly once, at creation.
 */

export const TOKEN_PREFIX_LABEL = 'cww';
const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;

const TOKEN_PATTERN = /^cww_([A-Za-z0-9_-]{6,32})\.([A-Za-z0-9_-]{16,128})$/;

export interface GeneratedAgentToken {
  /** The value handed to the operator once. Never persisted. */
  token: string;
  /** Non-secret lookup key, stored in the clear. */
  prefix: string;
  /** SHA-256 of the secret half, hex-encoded. */
  tokenHash: string;
}

export interface ParsedAgentToken {
  prefix: string;
  secret: string;
}

export function hashTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateAgentToken(): GeneratedAgentToken {
  const prefix = randomBytes(PREFIX_BYTES).toString('base64url');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    token: `${TOKEN_PREFIX_LABEL}_${prefix}.${secret}`,
    prefix,
    tokenHash: hashTokenSecret(secret),
  };
}

/** Returns the token's parts, or `null` if it is not a well-formed token. */
export function parseAgentToken(token: string): ParsedAgentToken | null {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) return null;
  const [, prefix, secret] = match;
  if (!prefix || !secret) return null;
  return { prefix, secret };
}

/**
 * Constant-time comparison of two hex-encoded SHA-256 digests. Length is
 * compared first because `timingSafeEqual` throws on a length mismatch; digests
 * are fixed-length, so that branch leaks nothing about the secret.
 */
export function secureCompareHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/** True when `secret` hashes to `expectedHash`. */
export function verifyTokenSecret(secret: string, expectedHash: string): boolean {
  return secureCompareHash(hashTokenSecret(secret), expectedHash);
}

/** Reads the bearer token out of an `Authorization` header value. */
export function extractBearerToken(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer[ ]+(\S+)$/.exec(headerValue.trim());
  return match?.[1] ?? null;
}

export type TokenLifecycleState = 'active' | 'revoked' | 'expired';

/**
 * Lifecycle check, evaluated before any handler logic runs. Revocation wins
 * over expiry so the audit trail names the operator's action, not the clock.
 */
export function classifyTokenLifecycle(
  record: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date = new Date(),
): TokenLifecycleState {
  if (record.revokedAt !== null && record.revokedAt.getTime() <= now.getTime()) {
    return 'revoked';
  }
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'active';
}
