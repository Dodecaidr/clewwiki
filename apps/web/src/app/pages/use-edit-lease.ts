'use client';

import { useEffect, useRef, useState } from 'react';

import { acquireClaimAction, releaseClaimAction, renewClaimAction } from './claim-actions';

/**
 * The editor's lease.
 *
 * Opening the form takes a claim, the form heartbeats while it is open, and
 * closing it — saving, cancelling, navigating away — gives the claim back. It
 * is the same claim → renew → release sequence an agent runs over REST, driven
 * by a browser instead of a tool call, which is what makes a human editor and
 * an agent contend for a page the same way rather than through two mechanisms
 * that have to be kept in agreement.
 *
 * Losing the lease mid-edit is reported rather than papered over: the author's
 * text stays on screen, and the save will be refused by the server, which is
 * better than a save that silently overwrites whoever took the page.
 */

export type LeaseStatus = 'acquiring' | 'held' | 'conflict' | 'lost' | 'error';

export interface EditLease {
  status: LeaseStatus;
  claimId: string | null;
  /** Who holds the page instead, when somebody does. */
  heldBy?: string;
  heldSince?: string;
  heldUntil?: string;
}

export function useEditLease(pageId: string | undefined): EditLease {
  const [lease, setLease] = useState<EditLease>({ status: 'acquiring', claimId: null });
  const heldRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pageId) return;

    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const stopHeartbeat = () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };

    void (async () => {
      const result = await acquireClaimAction(pageId);

      if (cancelled) {
        // The component went away while the request was in flight; the lease
        // it just took has to go back, or the page stays locked until its TTL.
        if (result.ok && result.claimId) void releaseClaimAction(result.claimId);
        return;
      }

      if (!result.ok || !result.claimId) {
        setLease({
          status: result.error === 'conflict' ? 'conflict' : 'error',
          claimId: null,
          heldBy: result.heldBy,
          heldSince: result.heldSince,
          heldUntil: result.heldUntil,
        });
        return;
      }

      heldRef.current = result.claimId;
      setLease({ status: 'held', claimId: result.claimId });

      const claimId = result.claimId;
      heartbeat = setInterval(() => {
        void renewClaimAction(claimId).then((renewal) => {
          if (cancelled || renewal.ok) return;
          // The lease is gone — expired, or taken away by an administrator.
          // Saying so is the whole point: the save is going to be refused.
          stopHeartbeat();
          heldRef.current = null;
          setLease({ status: 'lost', claimId: null });
        });
      }, result.heartbeatMs ?? 30_000);
    })();

    return () => {
      cancelled = true;
      stopHeartbeat();
      const held = heldRef.current;
      heldRef.current = null;
      if (held) void releaseClaimAction(held);
    };
  }, [pageId]);

  return lease;
}
