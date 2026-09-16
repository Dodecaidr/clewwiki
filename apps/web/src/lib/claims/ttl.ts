import type { WorkspaceSettings } from '@clewwiki/db';

/**
 * Lease arithmetic, kept free of the database so it can be reasoned about — and
 * tested — on its own.
 *
 * A claim is a lease, not a lock: it ends on its own if the holder stops
 * heartbeating, because the alternative is a crashed agent holding a page until
 * an administrator notices. Everything below is about where that deadline sits.
 */

/** Server default when the workspace has no opinion: ten minutes. */
export const DEFAULT_CLAIM_TTL_SECONDS = 600;

/**
 * One second is the floor. It is not a useful production value; it exists so a
 * lease can be watched expiring without a test sleeping for minutes.
 */
export const MIN_CLAIM_TTL_SECONDS = 1;

/**
 * One hour is the ceiling. A longer edit session renews — an unrenewed lease
 * that outlives the process holding it is exactly what the TTL is for, and an
 * administrator should not have to force-release a claim taken by a client that
 * asked for a day.
 */
export const MAX_CLAIM_TTL_SECONDS = 3_600;

export function clampTtlSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CLAIM_TTL_SECONDS;
  const whole = Math.floor(value);
  if (whole < MIN_CLAIM_TTL_SECONDS) return MIN_CLAIM_TTL_SECONDS;
  if (whole > MAX_CLAIM_TTL_SECONDS) return MAX_CLAIM_TTL_SECONDS;
  return whole;
}

/**
 * The TTL a claim gets: what the caller asked for, else the workspace default,
 * else the server default — clamped either way, so neither a caller nor a
 * mistyped setting can put a lease outside the supported range.
 */
export function resolveTtlSeconds(
  requested: number | null | undefined,
  settings?: WorkspaceSettings | null,
): number {
  if (typeof requested === 'number') return clampTtlSeconds(requested);
  const configured = settings?.claim_ttl_seconds;
  if (typeof configured === 'number') return clampTtlSeconds(configured);
  return DEFAULT_CLAIM_TTL_SECONDS;
}

export function expiryFrom(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + clampTtlSeconds(ttlSeconds) * 1000);
}

/**
 * A lease is over the moment it reaches its deadline. The comparison is `<=`
 * on purpose: at exactly `expires_at` the holder no longer has it, so a write
 * arriving on that millisecond is refused rather than allowed by a rounding
 * accident.
 */
export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** Whole seconds left on a lease, never negative. */
export function remainingSeconds(expiresAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
}

/**
 * How often an open editor should heartbeat: three times per lease, so two
 * heartbeats can be lost without dropping it, bounded so a long TTL does not
 * mean a silent hour and a short one does not mean a request per second.
 */
export function heartbeatIntervalMs(ttlSeconds: number): number {
  const third = (clampTtlSeconds(ttlSeconds) * 1000) / 3;
  return Math.min(60_000, Math.max(5_000, Math.floor(third)));
}

/**
 * Whether two targets on the same page exclude each other.
 *
 * A page-level claim (`sectionId === null`) covers the whole page, so it
 * overlaps every section claim on it and every section claim overlaps it. Two
 * section claims collide only when they name the same section — that is the
 * case that lets one writer hold "API reference" while another holds
 * "Overview".
 */
export function targetsOverlap(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return true;
  return left === right;
}
