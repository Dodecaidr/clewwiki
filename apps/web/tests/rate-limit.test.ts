import { describe, expect, it } from 'vitest';

import { TokenBucketRateLimiter } from '@/lib/rate-limit';

describe('TokenBucketRateLimiter', () => {
  it('allows exactly the configured number of requests in a window', () => {
    const limiter = new TokenBucketRateLimiter(5, 60);
    const now = 1_000_000;

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.consume('token', now).allowed).toBe(true);
    }

    const rejected = limiter.consume('token', now);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.limit).toBe(5);
    expect(rejected.resetAfterSeconds).toBeGreaterThan(0);
  });

  it('keys buckets independently so one token cannot starve another', () => {
    const limiter = new TokenBucketRateLimiter(2, 60);
    const now = 0;

    expect(limiter.consume('a', now).allowed).toBe(true);
    expect(limiter.consume('a', now).allowed).toBe(true);
    expect(limiter.consume('a', now).allowed).toBe(false);

    expect(limiter.consume('b', now).allowed).toBe(true);
  });

  it('refills gradually as the window passes', () => {
    const limiter = new TokenBucketRateLimiter(60, 60);
    const start = 0;

    for (let i = 0; i < 60; i += 1) {
      limiter.consume('token', start);
    }
    expect(limiter.consume('token', start).allowed).toBe(false);

    // One second of a 60/minute budget is worth exactly one request.
    expect(limiter.consume('token', start + 1000).allowed).toBe(true);
    expect(limiter.consume('token', start + 1000).allowed).toBe(false);
  });

  it('never refills beyond capacity', () => {
    const limiter = new TokenBucketRateLimiter(3, 60);
    limiter.consume('token', 0);

    // An hour later the bucket is full, not overfull.
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.consume('token', 3_600_000).allowed).toBe(true);
    }
    expect(limiter.consume('token', 3_600_000).allowed).toBe(false);
  });

  it('reports a retry delay that actually clears the limit', () => {
    const limiter = new TokenBucketRateLimiter(10, 60);
    for (let i = 0; i < 10; i += 1) limiter.consume('token', 0);

    const rejected = limiter.consume('token', 0);
    expect(rejected.allowed).toBe(false);

    const retryAt = rejected.resetAfterSeconds * 1000;
    expect(limiter.consume('token', retryAt).allowed).toBe(true);
  });

  it('prunes idle buckets without changing later decisions', () => {
    const limiter = new TokenBucketRateLimiter(2, 60);
    limiter.consume('token', 0);
    expect(limiter.size).toBe(1);

    limiter.prune(60_000);
    expect(limiter.size).toBe(0);

    expect(limiter.consume('token', 60_000).allowed).toBe(true);
    expect(limiter.consume('token', 60_000).allowed).toBe(true);
    expect(limiter.consume('token', 60_000).allowed).toBe(false);
  });

  it('rejects a nonsensical configuration', () => {
    expect(() => new TokenBucketRateLimiter(0, 60)).toThrow();
    expect(() => new TokenBucketRateLimiter(10, 0)).toThrow();
  });
});
