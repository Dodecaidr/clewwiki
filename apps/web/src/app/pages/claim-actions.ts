'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { acquireClaim, releaseClaim, renewClaim } from '@/lib/claims/service';
import { heartbeatIntervalMs, remainingSeconds, resolveTtlSeconds } from '@/lib/claims/ttl';
import { isPageServiceError } from '@/lib/pages/errors';
import { getSessionContext } from '@/lib/session';
import type { SessionContext } from '@/lib/session';

/**
 * The browser's half of the claim protocol.
 *
 * The editor takes a lease when it opens, heartbeats while it is open, and
 * gives it back on save or on leaving — the same three calls an agent makes
 * over REST, through the same service. Nothing here is a shortcut past the
 * claim rules: these actions are another caller of them.
 *
 * Every action re-reads the session itself. A form post reaches an action
 * directly and never passes through the page that rendered it, so the check
 * belongs here rather than in the component.
 */

export interface LeaseResult {
  ok: boolean;
  claimId?: string;
  expiresAt?: string;
  /** How often the editor should heartbeat, in milliseconds. */
  heartbeatMs?: number;
  baseContentHash?: string;
  error?: string;
  heldBy?: string;
  heldSince?: string;
  heldUntil?: string;
}

function claimActorOf(session: SessionContext) {
  return { type: 'user' as const, id: session.userId, label: session.name };
}

function toLeaseFailure(error: unknown): LeaseResult {
  if (isPageServiceError(error)) {
    const details = (error.details ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      error: error.code,
      heldBy: typeof details.held_by === 'string' ? details.held_by : undefined,
      heldSince: typeof details.since === 'string' ? details.since : undefined,
      heldUntil: typeof details.expires_at === 'string' ? details.expires_at : undefined,
    };
  }
  console.error('[claims] action failed', error);
  return { ok: false, error: 'generic' };
}

const pageIdSchema = z.uuid();

/** Takes the lease the editor writes under. */
export async function acquireClaimAction(pageId: string): Promise<LeaseResult> {
  const session = await getSessionContext();
  if (!session) return { ok: false, error: 'forbidden' };
  if (!pageIdSchema.safeParse(pageId).success) return { ok: false, error: 'validation' };

  try {
    const { claim } = await acquireClaim({
      workspaceId: session.workspace.id,
      pageId,
      actor: claimActorOf(session),
      settings: session.workspace.settings,
    });

    revalidatePath('/presence');
    return {
      ok: true,
      claimId: claim.id,
      expiresAt: claim.expiresAt.toISOString(),
      heartbeatMs: heartbeatIntervalMs(
        remainingSeconds(claim.expiresAt) ||
          resolveTtlSeconds(null, session.workspace.settings),
      ),
      baseContentHash: claim.baseContentHash,
    };
  } catch (error) {
    return toLeaseFailure(error);
  }
}

/** The heartbeat an open editor sends while the form is on screen. */
export async function renewClaimAction(claimId: string): Promise<LeaseResult> {
  const session = await getSessionContext();
  if (!session) return { ok: false, error: 'forbidden' };
  if (!pageIdSchema.safeParse(claimId).success) return { ok: false, error: 'validation' };

  try {
    const claim = await renewClaim({
      workspaceId: session.workspace.id,
      claimId,
      actor: claimActorOf(session),
      settings: session.workspace.settings,
    });
    return { ok: true, claimId: claim.id, expiresAt: claim.expiresAt.toISOString() };
  } catch (error) {
    return toLeaseFailure(error);
  }
}

/** Gives the lease back on save or on leaving the editor. */
export async function releaseClaimAction(claimId: string): Promise<LeaseResult> {
  const session = await getSessionContext();
  if (!session) return { ok: false, error: 'forbidden' };
  if (!pageIdSchema.safeParse(claimId).success) return { ok: false, error: 'validation' };

  try {
    await releaseClaim({
      workspaceId: session.workspace.id,
      claimId,
      actor: claimActorOf(session),
    });
    revalidatePath('/presence');
    return { ok: true, claimId };
  } catch (error) {
    return toLeaseFailure(error);
  }
}

export interface ForceReleaseState {
  error?: string;
  released?: boolean;
}

/**
 * An administrator taking a claim away from whoever holds it.
 *
 * Deliberately administrator-only and audited under its own action: a lease
 * that outlives the client holding it has to be recoverable, but taking one
 * away is not something an ordinary editor does quietly.
 */
export async function forceReleaseClaimAction(
  _prevState: ForceReleaseState,
  formData: FormData,
): Promise<ForceReleaseState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };
  if (session.role !== 'admin') return { error: 'forbidden' };

  const parsed = z.object({ claimId: z.uuid() }).safeParse({ claimId: formData.get('claimId') });
  if (!parsed.success) return { error: 'validation' };

  try {
    await releaseClaim({
      workspaceId: session.workspace.id,
      claimId: parsed.data.claimId,
      actor: claimActorOf(session),
      force: true,
    });
  } catch (error) {
    if (isPageServiceError(error)) return { error: error.code };
    console.error('[claims] force release failed', error);
    return { error: 'generic' };
  }

  revalidatePath('/presence');
  revalidatePath('/pages');
  return { released: true };
}
