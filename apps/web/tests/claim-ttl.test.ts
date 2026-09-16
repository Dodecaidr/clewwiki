import { describe, expect, it } from 'vitest';

import {
  clampTtlSeconds,
  DEFAULT_CLAIM_TTL_SECONDS,
  expiryFrom,
  heartbeatIntervalMs,
  isExpired,
  MAX_CLAIM_TTL_SECONDS,
  MIN_CLAIM_TTL_SECONDS,
  remainingSeconds,
  resolveTtlSeconds,
  targetsOverlap,
} from '@/lib/claims/ttl';

describe('claim TTL', () => {
  it('clamps a TTL into the supported range', () => {
    expect(clampTtlSeconds(60)).toBe(60);
    expect(clampTtlSeconds(0)).toBe(MIN_CLAIM_TTL_SECONDS);
    expect(clampTtlSeconds(-5)).toBe(MIN_CLAIM_TTL_SECONDS);
    expect(clampTtlSeconds(86_400)).toBe(MAX_CLAIM_TTL_SECONDS);
    expect(clampTtlSeconds(12.9)).toBe(12);
    expect(clampTtlSeconds(Number.NaN)).toBe(DEFAULT_CLAIM_TTL_SECONDS);
  });

  it('prefers the caller, then the workspace, then the server default', () => {
    expect(resolveTtlSeconds(45, { claim_ttl_seconds: 120 })).toBe(45);
    expect(resolveTtlSeconds(undefined, { claim_ttl_seconds: 120 })).toBe(120);
    expect(resolveTtlSeconds(undefined, {})).toBe(DEFAULT_CLAIM_TTL_SECONDS);
    expect(resolveTtlSeconds(null, null)).toBe(DEFAULT_CLAIM_TTL_SECONDS);
    // A workspace setting outside the range is clamped like any other value,
    // rather than being trusted because it came from configuration.
    expect(resolveTtlSeconds(undefined, { claim_ttl_seconds: 999_999 })).toBe(
      MAX_CLAIM_TTL_SECONDS,
    );
  });

  it('puts the deadline exactly one TTL ahead', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(expiryFrom(now, 600).toISOString()).toBe('2026-01-01T00:10:00.000Z');
  });

  it('treats the deadline itself as expired', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(isExpired(new Date('2026-01-01T00:00:00.000Z'), now)).toBe(true);
    expect(isExpired(new Date('2026-01-01T00:00:00.001Z'), now)).toBe(false);
    expect(isExpired(new Date('2025-12-31T23:59:59.999Z'), now)).toBe(true);
  });

  it('never reports negative time left', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(remainingSeconds(new Date('2026-01-01T00:00:30.000Z'), now)).toBe(30);
    expect(remainingSeconds(new Date('2025-12-31T00:00:00.000Z'), now)).toBe(0);
  });

  it('heartbeats three times per lease, within bounds', () => {
    expect(heartbeatIntervalMs(600)).toBe(60_000);
    expect(heartbeatIntervalMs(60)).toBe(20_000);
    expect(heartbeatIntervalMs(1)).toBe(5_000);
  });
});

describe('claim target overlap', () => {
  it('lets a page-level claim exclude everything on the page', () => {
    expect(targetsOverlap(null, null)).toBe(true);
    expect(targetsOverlap(null, 'overview')).toBe(true);
    expect(targetsOverlap('overview', null)).toBe(true);
  });

  it('lets two different sections be held at once', () => {
    expect(targetsOverlap('overview', 'api-reference')).toBe(false);
    expect(targetsOverlap('overview', 'overview')).toBe(true);
  });

  it('treats an absent section the same as an explicit null', () => {
    expect(targetsOverlap(undefined, 'overview')).toBe(true);
    expect(targetsOverlap('overview', undefined)).toBe(true);
  });
});
