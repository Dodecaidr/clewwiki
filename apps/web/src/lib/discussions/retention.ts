import type { SpaceSettings } from '@clewwiki/db';

/**
 * The retention policy of a space's discussions, and the arithmetic that turns
 * it into the one deadline the rest of the feature reads.
 *
 * Pure functions with no database and no `server-only`, so the maths can be
 * unit-tested on its own — which matters here, because "when does this thread
 * go away" is shown to people in the interface, returned to agents over MCP,
 * and acted on by a sweep, and all three have to agree.
 *
 * There is a single deadline column rather than two nullable ones. While a
 * discussion is open, `expires_at` is when it will be closed for inactivity;
 * once it is resolved, it is when it will be deleted. A reader never has to
 * work out which of two dates applies, and the sweep is one indexed scan.
 */

/** Days an open discussion may sit untouched before the sweep closes it. */
export const DEFAULT_IDLE_DAYS = 14;
/** Days a resolved discussion is kept before it and its messages are deleted. */
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * Bounds on what a space may configure.
 *
 * The floor is one day rather than zero: a window of zero would delete a thread
 * in the same sweep that created it, which is a way of losing a conversation
 * nobody asked to lose. The ceiling is a year, past which "ephemeral" stops
 * meaning anything and the thread should have been a page.
 */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

export interface DiscussionPolicy {
  idleDays: number;
  retentionDays: number;
  /** The page decision pages are created under, when one has been chosen. */
  decisionsPageId: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Keeps a configured number of days inside the bounds above, falling back to
 * the default for anything that is not a usable whole number. Settings JSON is
 * written by administrators and by older releases; a value this function cannot
 * read must not be able to make a sweep behave unpredictably.
 */
export function clampDays(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const whole = Math.trunc(value);
  if (whole < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (whole > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return whole;
}

/** The effective policy of a space: what it configured, or the defaults. */
export function readDiscussionPolicy(settings: SpaceSettings | null | undefined): DiscussionPolicy {
  return {
    idleDays: clampDays(settings?.discussion_idle_days, DEFAULT_IDLE_DAYS),
    retentionDays: clampDays(settings?.discussion_retention_days, DEFAULT_RETENTION_DAYS),
    decisionsPageId:
      typeof settings?.decisions_page_id === 'string' && settings.decisions_page_id !== ''
        ? settings.decisions_page_id
        : null,
  };
}

/** When an open discussion last touched at `lastActivityAt` is closed. */
export function idleDeadline(lastActivityAt: Date, policy: DiscussionPolicy): Date {
  return new Date(lastActivityAt.getTime() + policy.idleDays * MS_PER_DAY);
}

/** When a discussion resolved at `resolvedAt` is deleted along with its messages. */
export function retentionDeadline(resolvedAt: Date, policy: DiscussionPolicy): Date {
  return new Date(resolvedAt.getTime() + policy.retentionDays * MS_PER_DAY);
}

/**
 * The deadline to store for a discussion in a given state. The one place that
 * decides which of the two windows applies.
 */
export function nextExpiry(
  status: 'open' | 'resolved',
  at: Date,
  policy: DiscussionPolicy,
): Date {
  return status === 'open' ? idleDeadline(at, policy) : retentionDeadline(at, policy);
}
