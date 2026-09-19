import 'server-only';

import { getImageUploadRateLimitMax, getImageUploadRateLimitWindowSeconds } from '../env';
import { TokenBucketRateLimiter } from '../rate-limit';
import type { RateLimitDecision } from '../rate-limit';

declare global {
  var __clewwikiImageUploadLimiter: TokenBucketRateLimiter | undefined;
}

function limiter(): TokenBucketRateLimiter {
  globalThis.__clewwikiImageUploadLimiter ??= new TokenBucketRateLimiter(
    getImageUploadRateLimitMax(),
    getImageUploadRateLimitWindowSeconds(),
  );
  return globalThis.__clewwikiImageUploadLimiter;
}

/** One upload's worth of an actor's budget. People and tokens are limited alike. */
export function consumeUploadBudget(actorType: string, actorId: string): RateLimitDecision {
  return limiter().consume(`${actorType}:${actorId}`);
}

export function resetUploadBudget(): void {
  globalThis.__clewwikiImageUploadLimiter?.reset();
}
