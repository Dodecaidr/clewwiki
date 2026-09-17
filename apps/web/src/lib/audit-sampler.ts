/**
 * Coalesces audit rows for events that arrive in bursts.
 *
 * A refused request is forensic signal, but a client hammering an endpoint
 * with a revoked token, or past its rate limit, would otherwise turn every
 * refusal into an `INSERT` — the limiter would protect the handlers and not
 * the audit table. So these events are written at most once per key per
 * window, and the row that is written carries how many were folded into it
 * since the previous one. The burst stays visible; its size stops being a
 * write load.
 *
 * In memory and per process, like the rate limiter itself.
 */

export interface AuditSampleDecision {
  /** Whether this occurrence should be written. */
  write: boolean;
  /** Occurrences not written since the last row for this key. */
  suppressed: number;
}

interface Entry {
  windowStartedAt: number;
  suppressed: number;
}

export class AuditSampler {
  readonly #entries = new Map<string, Entry>();
  readonly #windowMs: number;
  #calls = 0;

  constructor(windowSeconds: number) {
    if (windowSeconds <= 0) throw new Error('Audit sampling window must be positive');
    this.#windowMs = windowSeconds * 1000;
  }

  sample(key: string, now: number = Date.now()): AuditSampleDecision {
    this.#calls += 1;
    if (this.#calls % 1000 === 0) this.prune(now);

    const entry = this.#entries.get(key);
    if (!entry || now - entry.windowStartedAt >= this.#windowMs) {
      const suppressed = entry?.suppressed ?? 0;
      this.#entries.set(key, { windowStartedAt: now, suppressed: 0 });
      return { write: true, suppressed };
    }
    entry.suppressed += 1;
    return { write: false, suppressed: entry.suppressed };
  }

  /**
   * Forgets keys idle for two windows. A key with suppressed occurrences is
   * kept for one extra window so its count reaches the next row, if one comes.
   */
  prune(now: number = Date.now()): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.windowStartedAt >= this.#windowMs * 2) this.#entries.delete(key);
    }
  }

  reset(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

declare global {
  var __clewwikiAuditSampler: AuditSampler | undefined;
}

/** One row per key per ten seconds, process-wide. */
export function getAuditSampler(): AuditSampler {
  globalThis.__clewwikiAuditSampler ??= new AuditSampler(10);
  return globalThis.__clewwikiAuditSampler;
}
