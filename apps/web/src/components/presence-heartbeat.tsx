'use client';

import { useEffect } from 'react';

const INTERVAL_MS = 30_000;

/**
 * Tells the wiki this tab is open on a page — every half minute, and only while
 * the tab is visible, so a forgotten background tab drops off the board within
 * two minutes. Renders nothing. A failed beat is not retried: the next one is
 * thirty seconds away.
 */
export function PresenceHeartbeat({ pageId, mode }: { pageId?: string; mode: 'viewing' | 'editing' }) {
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      void fetch('/api/v1/presence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          page_id: pageId ?? null,
          mode,
          // True under WebDriver-based automation (Playwright, Selenium,
          // Puppeteer): an agent driving a person's browser session.
          automated: navigator.webdriver === true,
        }),
        keepalive: true,
      }).catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, INTERVAL_MS);
    document.addEventListener('visibilitychange', beat);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [pageId, mode]);

  return null;
}
