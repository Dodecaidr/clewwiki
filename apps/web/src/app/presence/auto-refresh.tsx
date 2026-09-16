'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Re-renders the presence board on an interval.
 *
 * Polling, not a socket: the board is a handful of rows read once every ten
 * seconds by the few people looking at it, and a persistent connection would
 * add a second delivery path to a product whose entire state already lives in
 * one database. `router.refresh()` re-runs the server component, so the refresh
 * goes through the same query and the same workspace check as the first render.
 */
export function PresenceAutoRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setInterval(() => {
      // A hidden tab has nobody watching it; refreshing it only costs queries.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      router.refresh();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [router, intervalMs]);

  return null;
}
