import 'server-only';

import { getDiscussionMessageRateLimitMax, getDiscussionMessageRateLimitWindowSeconds } from '../env';
import { TokenBucketRateLimiter } from '../rate-limit';
import type { RateLimitDecision } from '../rate-limit';

/**
 * A second, much tighter bucket, for posting discussion messages only.
 *
 * The general agent-token limiter already bounds how many requests a token may
 * make. This one exists because a message is not like other writes: it costs a
 * row that every other participant then has to read, it is the cheapest call in
 * the API to make in a loop, and a thread flooded by one agent is useless to
 * everybody else long before the general limit would notice. The same
 * `TokenBucketRateLimiter` as everywhere else, so the behaviour, the headers
 * and the per-process caveat are the ones already documented.
 *
 * Keyed by actor rather than by token alone, so the ceiling exists for a person
 * hammering the compose box as well; in practice the default is far above what
 * anyone types.
 */

declare global {
  var __clewwikiDiscussionMessageLimiter: TokenBucketRateLimiter | undefined;
}

function limiter(): TokenBucketRateLimiter {
  globalThis.__clewwikiDiscussionMessageLimiter ??= new TokenBucketRateLimiter(
    getDiscussionMessageRateLimitMax(),
    getDiscussionMessageRateLimitWindowSeconds(),
  );
  return globalThis.__clewwikiDiscussionMessageLimiter;
}

export function consumeMessageBudget(actorType: string, actorId: string): RateLimitDecision {
  return limiter().consume(`${actorType}:${actorId}`);
}

/** Drops every bucket. Tests use it; nothing in the application does. */
export function resetMessageBudget(): void {
  globalThis.__clewwikiDiscussionMessageLimiter?.reset();
}
