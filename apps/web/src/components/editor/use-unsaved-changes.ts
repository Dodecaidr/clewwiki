'use client';

import { useEffect } from 'react';

/**
 * Asks before leaving a form with unsaved changes: on reload or closing the
 * tab through the browser's own prompt, and on following a link inside the
 * application with a confirmation. Links are caught in the capture phase, ahead
 * of the router, and a declined navigation is cancelled before it starts.
 */
export function useUnsavedChangesGuard(active: boolean, message: string): void {
  useEffect(() => {
    if (!active) return;

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers still need a return value to show the prompt.
      event.returnValue = '';
    };

    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
    };
  }, [active, message]);
}
