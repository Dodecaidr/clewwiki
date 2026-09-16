/**
 * Token-bucket rate limiter, in memory.
 *
 * v1 deliberately keeps this in the application process: clewwiki ships as a
 * single container, so a shared store would add a dependency without buying
 * anything. The consequence is documented rather than hidden — the limit is
 * per process, so running several replicas multiplies the effective ceiling,
 * and counters reset on restart. Moving the bucket store behind an interface
 * is the whole change needed to back it with Postgres or Redis later.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetAfterSeconds: number;
  limit: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #windowMs: number;

  constructor(capacity: number, windowSeconds: number) {
    if (capacity <= 0) throw new Error('Rate limit capacity must be positive');
    if (windowSeconds <= 0) throw new Error('Rate limit window must be positive');
    this.#capacity = capacity;
    this.#windowMs = windowSeconds * 1000;
  }

  consume(key: string, now: number = Date.now()): RateLimitDecision {
    const refillPerMs = this.#capacity / this.#windowMs;
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };

    const elapsed = Math.max(0, now - bucket.updatedAt);
    const tokens = Math.min(this.#capacity, bucket.tokens + elapsed * refillPerMs);

    if (tokens < 1) {
      this.#buckets.set(key, { tokens, updatedAt: now });
      const missing = 1 - tokens;
      return {
        allowed: false,
        remaining: 0,
        resetAfterSeconds: Math.max(1, Math.ceil(missing / refillPerMs / 1000)),
        limit: this.#capacity,
      };
    }

    const nextTokens = tokens - 1;
    this.#buckets.set(key, { tokens: nextTokens, updatedAt: now });
    return {
      allowed: true,
      remaining: Math.floor(nextTokens),
      resetAfterSeconds: Math.ceil((this.#capacity - nextTokens) / refillPerMs / 1000),
      limit: this.#capacity,
    };
  }

  /**
   * Drops buckets idle for a full window. After that long they would have
   * refilled to capacity anyway, so forgetting them changes no decision.
   */
  prune(now: number = Date.now()): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt >= this.#windowMs) {
        this.#buckets.delete(key);
      }
    }
  }

  reset(): void {
    this.#buckets.clear();
  }

  get size(): number {
    return this.#buckets.size;
  }
}
