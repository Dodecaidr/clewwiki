import 'server-only';

import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { claimNotes, claims, pages, spaces } from '@clewwiki/db';
import type { SQL } from 'drizzle-orm';
import type { ActorKind, ClaimReleaseReason, WorkspaceSettings } from '@clewwiki/db';

import { expiryFrom, isExpired, resolveTtlSeconds, targetsOverlap } from './ttl';
import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import type { DbExecutor } from '../db';
import { PageServiceError, isPageServiceError } from '../pages/errors';

/**
 * The claim service: take a lease, heartbeat it, write under it, give it back.
 *
 * Two rules hold everything else up.
 *
 * 1. The decision "is this target free?" and the insert that takes it happen in
 *    one transaction that holds `select … for update` on the *page* row. Two
 *    concurrent claims on the same page — or on a page and one of its sections,
 *    which the unique indexes alone cannot compare — queue behind that lock, so
 *    the second one reads the first one's committed row and loses cleanly. The
 *    partial unique indexes in `0002_claims` are the net under that, not the
 *    mechanism.
 * 2. A lease past its deadline is *released*, not merely ignored. Expiry is
 *    applied lazily inside the same transaction that needs the answer, and by a
 *    sweep for everything nobody asked about, so "active" means one thing to
 *    the service, to the unique indexes and to the presence board alike.
 *
 * Every function takes the caller's `workspaceId` and puts it in the SQL
 * predicate, so a claim belonging to another workspace is invisible rather than
 * merely forbidden.
 */

export interface ClaimActor {
  type: ActorKind;
  id: string;
  /** Display name snapshotted onto the claim: a user's name, a token's name. */
  label: string;
}

export interface ClaimRecord {
  id: string;
  workspaceId: string;
  pageId: string;
  sectionId: string | null;
  holderType: ActorKind;
  holderId: string;
  holderLabel: string;
  baseContentHash: string;
  createdAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
  releasedBy: string | null;
  releaseReason: ClaimReleaseReason | null;
}

export interface ClaimNoteRecord {
  id: string;
  claimId: string;
  workspaceId: string;
  text: string;
  authorType: ActorKind;
  authorId: string;
  authorLabel: string;
  createdAt: Date;
  expiresAt: Date;
}

const claimColumns = {
  id: claims.id,
  workspaceId: claims.workspaceId,
  pageId: claims.pageId,
  sectionId: claims.sectionId,
  holderType: claims.holderType,
  holderId: claims.holderId,
  holderLabel: claims.holderLabel,
  baseContentHash: claims.baseContentHash,
  createdAt: claims.createdAt,
  expiresAt: claims.expiresAt,
  releasedAt: claims.releasedAt,
  releasedBy: claims.releasedBy,
  releaseReason: claims.releaseReason,
} as const;

const noteColumns = {
  id: claimNotes.id,
  claimId: claimNotes.claimId,
  workspaceId: claimNotes.workspaceId,
  text: claimNotes.text,
  authorType: claimNotes.authorType,
  authorId: claimNotes.authorId,
  authorLabel: claimNotes.authorLabel,
  createdAt: claimNotes.createdAt,
  expiresAt: claimNotes.expiresAt,
} as const;

/** Longest note the contract accepts; the column carries the same limit. */
export const MAX_NOTE_LENGTH = 2_000;

/** Shape a section identifier has to have to be storable and comparable. */
export const SECTION_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._/#-]{0,199}$/u;

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      (current as { code?: unknown }).code === UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** The `details` payload a conflicting claim answers with, per `docs/mcp.md`. */
export function conflictDetails(claim: ClaimRecord): Record<string, unknown> {
  return {
    claim_id: claim.id,
    held_by: claim.holderLabel,
    actor_type: claim.holderType,
    holder_id: claim.holderId,
    since: claim.createdAt.toISOString(),
    expires_at: claim.expiresAt.toISOString(),
    ...(claim.sectionId === null ? {} : { section_id: claim.sectionId }),
  };
}

/**
 * Audits an attempt that failed.
 *
 * It cannot join the transaction it describes: that transaction is about to
 * roll back, and a row written inside it would roll back with it. So the
 * rejection is recorded on its own connection, right after the failure, which
 * is the closest thing to "same transaction" that a refused attempt allows.
 */
async function recordRejection(
  workspaceId: string,
  actor: ClaimActor,
  action: string,
  target: string | null,
  error: unknown,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const code = isPageServiceError(error) ? error.code : 'internal_error';
  try {
    await recordAudit({
      workspaceId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      target,
      metadata: { ...metadata, result: 'rejected', reason: code },
    });
  } catch (auditError) {
    console.error('[claims] rejection could not be audited', auditError);
  }
}

/* ------------------------------------------------------------------ */
/* Expiry                                                              */
/* ------------------------------------------------------------------ */

/**
 * Releases every active claim matching `predicate` whose deadline has passed,
 * and deletes the notes hanging on them.
 *
 * Returns the rows it ended, so the caller can audit them. Runs inside whatever
 * executor it is given: a caller-owned transaction for the lazy path, a
 * transaction of its own for the sweep.
 */
async function expireMatchingClaims(
  tx: DbExecutor,
  predicate: SQL | undefined,
  now: Date,
): Promise<ClaimRecord[]> {
  const expired = await tx
    .update(claims)
    .set({
      releasedAt: now,
      releasedBy: 'system',
      releaseReason: 'expired',
    })
    .where(and(isNull(claims.releasedAt), lte(claims.expiresAt, now), predicate))
    .returning(claimColumns);

  if (expired.length > 0) {
    await tx.delete(claimNotes).where(
      inArray(
        claimNotes.claimId,
        expired.map((row) => row.id),
      ),
    );
  }
  return expired;
}

async function auditExpired(tx: DbExecutor, expired: ClaimRecord[]): Promise<void> {
  for (const claim of expired) {
    await recordAudit(
      {
        workspaceId: claim.workspaceId,
        actorType: claim.holderType,
        actorId: claim.holderId,
        action: 'claim.expired',
        target: claim.id,
        metadata: { pageId: claim.pageId, sectionId: claim.sectionId, result: 'expired' },
      },
      tx,
    );
  }
}

/**
 * The periodic sweep.
 *
 * Presence and the claim checks already ignore a lease past its deadline, so
 * the sweep changes no decision — it frees the partial unique indexes, deletes
 * notes that should no longer be readable, and leaves the audit trail that says
 * when each lease actually ended. Safe to run from several replicas: the
 * `update … where released_at is null` only ever ends a claim once.
 */
export async function expireStaleClaims(now: Date = new Date()): Promise<{ expired: number }> {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const expired = await expireMatchingClaims(tx, undefined, now);
    await auditExpired(tx, expired);
    return { expired: expired.length };
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

function activeClaimFilter(now: Date): SQL | undefined {
  return and(isNull(claims.releasedAt), sql`${claims.expiresAt} > ${now.toISOString()}::timestamptz`);
}

export async function getClaimById(
  workspaceId: string,
  claimId: string,
  executor: DbExecutor = getDatabase(),
): Promise<ClaimRecord | null> {
  const [row] = await executor
    .select(claimColumns)
    .from(claims)
    .where(and(eq(claims.id, claimId), eq(claims.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Every live claim on one page, page-level and section alike. */
export async function getActiveClaimsForPage(
  workspaceId: string,
  pageId: string,
  now: Date = new Date(),
): Promise<ClaimRecord[]> {
  const db = getDatabase();
  return db
    .select(claimColumns)
    .from(claims)
    .where(
      and(eq(claims.workspaceId, workspaceId), eq(claims.pageId, pageId), activeClaimFilter(now)),
    )
    .orderBy(asc(claims.createdAt));
}

/**
 * The live claims of a whole workspace, keyed by page.
 *
 * The tree and the page header need "is this page spoken for, and by whom" for
 * many pages at once; one query answers it for all of them. A page-level claim
 * wins the slot over a section claim, because that is the stronger statement.
 */
export async function getActiveClaimsByPage(
  workspaceId: string,
  now: Date = new Date(),
): Promise<Map<string, ClaimRecord>> {
  const db = getDatabase();
  const rows = await db
    .select(claimColumns)
    .from(claims)
    .where(and(eq(claims.workspaceId, workspaceId), activeClaimFilter(now)))
    .orderBy(asc(claims.createdAt));

  const byPage = new Map<string, ClaimRecord>();
  for (const row of rows) {
    const held = byPage.get(row.pageId);
    if (!held || (held.sectionId !== null && row.sectionId === null)) {
      byPage.set(row.pageId, row);
    }
  }
  return byPage;
}

export interface PresenceEntry {
  claim: ClaimRecord;
  spaceId: string;
  spaceKey: string;
  spaceName: string;
  path: string;
  title: string;
  notes: ClaimNoteRecord[];
}

export interface PresenceOptions {
  /** Only claims on pages in these spaces; omit for every space. */
  spaceIds?: readonly string[] | null;
  now?: Date;
}

/**
 * Who is working on what in this workspace right now.
 *
 * Expired leases are filtered by the query rather than trusted to the sweep, so
 * the board is correct the instant a TTL passes instead of one sweep interval
 * later. Claims on a deleted page are dropped by the join for the same reason.
 */
export async function getPresence(
  workspaceId: string,
  options: PresenceOptions = {},
): Promise<PresenceEntry[]> {
  const now = options.now ?? new Date();
  if (options.spaceIds && options.spaceIds.length === 0) return [];
  const db = getDatabase();

  const rows = await db
    .select({
      claim: claimColumns,
      path: pages.path,
      title: pages.title,
      spaceId: spaces.id,
      spaceKey: spaces.key,
      spaceName: spaces.name,
    })
    .from(claims)
    .innerJoin(pages, eq(pages.id, claims.pageId))
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .where(
      and(
        eq(claims.workspaceId, workspaceId),
        isNull(pages.deletedAt),
        activeClaimFilter(now),
        options.spaceIds ? inArray(pages.spaceId, [...options.spaceIds]) : undefined,
      ),
    )
    .orderBy(desc(claims.createdAt));

  if (rows.length === 0) return [];

  const notes = await db
    .select(noteColumns)
    .from(claimNotes)
    .where(
      and(
        eq(claimNotes.workspaceId, workspaceId),
        inArray(
          claimNotes.claimId,
          rows.map((row) => row.claim.id),
        ),
        sql`${claimNotes.expiresAt} > ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(claimNotes.createdAt));

  const notesByClaim = new Map<string, ClaimNoteRecord[]>();
  for (const note of notes) {
    const bucket = notesByClaim.get(note.claimId);
    if (bucket) bucket.push(note);
    else notesByClaim.set(note.claimId, [note]);
  }

  return rows.map((row) => ({
    claim: row.claim,
    spaceId: row.spaceId,
    spaceKey: row.spaceKey,
    spaceName: row.spaceName,
    path: row.path,
    title: row.title,
    notes: notesByClaim.get(row.claim.id) ?? [],
  }));
}

/** Active notes on the active claims of one page, oldest first. */
export async function getActiveNotesForPage(
  workspaceId: string,
  pageId: string,
  now: Date = new Date(),
): Promise<ClaimNoteRecord[]> {
  const db = getDatabase();
  return db
    .select(noteColumns)
    .from(claimNotes)
    .innerJoin(claims, eq(claims.id, claimNotes.claimId))
    .where(
      and(
        eq(claimNotes.workspaceId, workspaceId),
        eq(claims.pageId, pageId),
        activeClaimFilter(now),
        sql`${claimNotes.expiresAt} > ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(claimNotes.createdAt));
}

/* ------------------------------------------------------------------ */
/* Acquire                                                             */
/* ------------------------------------------------------------------ */

export interface AcquireClaimInput {
  workspaceId: string;
  pageId: string;
  /** A named section, or null/undefined for the whole page. */
  sectionId?: string | null;
  actor: ClaimActor;
  ttlSeconds?: number | null;
  /** The workspace's settings row, source of the default TTL. */
  settings?: WorkspaceSettings | null;
}

export interface AcquireClaimResult {
  claim: ClaimRecord;
  /** False when the caller already held this exact target and it was extended. */
  created: boolean;
}

function normalizeSectionId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!SECTION_ID_PATTERN.test(trimmed)) {
    throw new PageServiceError('validation', 'Section identifier is not valid');
  }
  return trimmed;
}

/**
 * Takes a lease on a page or one of its sections.
 *
 * The page row is locked first and held for the whole transaction. That is what
 * makes the overlap check meaningful: a second caller reaching this code at the
 * same instant waits on the lock, then reads the committed claim and is told
 * who has it, instead of both of them reading "free" and both inserting.
 */
export async function acquireClaim(input: AcquireClaimInput): Promise<AcquireClaimResult> {
  const sectionId = normalizeSectionId(input.sectionId);
  const ttlSeconds = resolveTtlSeconds(input.ttlSeconds, input.settings);
  const db = getDatabase();

  try {
    return await db.transaction(async (tx) => {
      const now = new Date();

      // The page row is the rendezvous point for every writer on this page,
      // including the ones claiming a section of it, so the lock is taken here
      // and not on the claims table.
      const [page] = await tx
        .select({ id: pages.id, contentHash: pages.contentHash })
        .from(pages)
        .where(
          and(
            eq(pages.id, input.pageId),
            eq(pages.workspaceId, input.workspaceId),
            isNull(pages.deletedAt),
          ),
        )
        .limit(1)
        .for('update');

      if (!page) {
        throw new PageServiceError('not_found', 'Page not found');
      }

      const expired = await expireMatchingClaims(tx, eq(claims.pageId, page.id), now);
      await auditExpired(tx, expired);

      const active = await tx
        .select(claimColumns)
        .from(claims)
        .where(and(eq(claims.pageId, page.id), isNull(claims.releasedAt)))
        .orderBy(asc(claims.createdAt));

      const overlapping = active.filter((claim) => targetsOverlap(claim.sectionId, sectionId));
      const held = overlapping[0];

      if (held) {
        const sameHolder =
          held.holderType === input.actor.type && held.holderId === input.actor.id;
        const sameTarget = held.sectionId === sectionId;

        // Re-claiming what you already hold is a heartbeat, not a conflict:
        // an agent that lost its claim id to a restart would otherwise be
        // locked out of its own lease until the TTL ran down.
        if (sameHolder && sameTarget) {
          const [renewed] = await tx
            .update(claims)
            .set({ expiresAt: expiryFrom(now, ttlSeconds), holderLabel: input.actor.label })
            .where(eq(claims.id, held.id))
            .returning(claimColumns);

          if (!renewed) {
            throw new PageServiceError('conflict', 'Claim could not be extended');
          }

          await tx
            .update(claimNotes)
            .set({ expiresAt: renewed.expiresAt })
            .where(eq(claimNotes.claimId, renewed.id));

          await recordAudit(
            {
              workspaceId: input.workspaceId,
              actorType: input.actor.type,
              actorId: input.actor.id,
              action: 'claim.renewed',
              target: renewed.id,
              metadata: {
                pageId: page.id,
                sectionId,
                result: 'success',
                expiresAt: renewed.expiresAt.toISOString(),
                viaAcquire: true,
              },
            },
            tx,
          );

          return { claim: renewed, created: false };
        }

        throw new PageServiceError(
          'conflict',
          sameHolder
            ? 'You already hold an overlapping claim on this page'
            : 'This page is claimed by someone else',
          conflictDetails(held),
        );
      }

      const [created] = await tx
        .insert(claims)
        .values({
          workspaceId: input.workspaceId,
          pageId: page.id,
          sectionId,
          holderType: input.actor.type,
          holderId: input.actor.id,
          holderLabel: input.actor.label,
          baseContentHash: page.contentHash,
          expiresAt: expiryFrom(now, ttlSeconds),
        })
        .returning(claimColumns);

      if (!created) {
        throw new PageServiceError('conflict', 'Claim could not be created');
      }

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'claim.acquired',
          target: created.id,
          metadata: {
            pageId: page.id,
            sectionId,
            result: 'success',
            ttlSeconds,
            expiresAt: created.expiresAt.toISOString(),
          },
        },
        tx,
      );

      return { claim: created, created: true };
    });
  } catch (error) {
    // The partial unique indexes are the net under the row lock. Reaching one
    // means two inserts got past the check; the answer is still a conflict,
    // named after whoever actually holds the target now.
    if (isUniqueViolation(error)) {
      const [holder] = await getActiveClaimsForPage(input.workspaceId, input.pageId).then((list) =>
        list.filter((claim) => targetsOverlap(claim.sectionId, sectionId)),
      );
      const conflict = new PageServiceError(
        'conflict',
        'This page is claimed by someone else',
        holder ? conflictDetails(holder) : undefined,
      );
      await recordRejection(input.workspaceId, input.actor, 'claim.rejected', input.pageId, conflict, {
        sectionId,
      });
      throw conflict;
    }
    if (isPageServiceError(error)) {
      await recordRejection(input.workspaceId, input.actor, 'claim.rejected', input.pageId, error, {
        sectionId,
      });
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Renew, release                                                      */
/* ------------------------------------------------------------------ */

export interface RenewClaimInput {
  workspaceId: string;
  claimId: string;
  actor: ClaimActor;
  ttlSeconds?: number | null;
  settings?: WorkspaceSettings | null;
}

/**
 * Extends a lease the caller holds.
 *
 * A lease already past its deadline is not extended, even a millisecond late:
 * the target may have been taken by someone else in between, and quietly
 * reviving the old claim would hand two writers the same page.
 */
export async function renewClaim(input: RenewClaimInput): Promise<ClaimRecord> {
  const ttlSeconds = resolveTtlSeconds(input.ttlSeconds, input.settings);
  const db = getDatabase();

  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const claim = await lockClaim(tx, input.workspaceId, input.claimId);

      if (!claim) throw new PageServiceError('not_found', 'Claim not found');
      if (claim.releasedAt !== null) {
        throw new PageServiceError('not_found', 'Claim has been released');
      }
      if (claim.holderType !== input.actor.type || claim.holderId !== input.actor.id) {
        throw new PageServiceError(
          'forbidden',
          'Claim is held by another actor',
          conflictDetails(claim),
        );
      }
      if (isExpired(claim.expiresAt, now)) {
        const expired = await expireMatchingClaims(tx, eq(claims.id, claim.id), now);
        await auditExpired(tx, expired);
        throw new PageServiceError('not_found', 'Claim has expired');
      }

      const [renewed] = await tx
        .update(claims)
        .set({ expiresAt: expiryFrom(now, ttlSeconds), holderLabel: input.actor.label })
        .where(eq(claims.id, claim.id))
        .returning(claimColumns);

      if (!renewed) throw new PageServiceError('not_found', 'Claim not found');

      // Notes live exactly as long as the claim they hang on, so extending one
      // extends the other.
      await tx
        .update(claimNotes)
        .set({ expiresAt: renewed.expiresAt })
        .where(eq(claimNotes.claimId, renewed.id));

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'claim.renewed',
          target: renewed.id,
          metadata: {
            pageId: renewed.pageId,
            sectionId: renewed.sectionId,
            result: 'success',
            expiresAt: renewed.expiresAt.toISOString(),
          },
        },
        tx,
      );

      return renewed;
    });
  } catch (error) {
    if (isPageServiceError(error)) {
      await recordRejection(
        input.workspaceId,
        input.actor,
        'claim.renew_rejected',
        input.claimId,
        error,
      );
    }
    throw error;
  }
}

async function lockClaim(
  tx: DbExecutor,
  workspaceId: string,
  claimId: string,
): Promise<ClaimRecord | null> {
  const [row] = await tx
    .select(claimColumns)
    .from(claims)
    .where(and(eq(claims.id, claimId), eq(claims.workspaceId, workspaceId)))
    .limit(1)
    .for('update');
  return row ?? null;
}

export interface ReleaseClaimInput {
  workspaceId: string;
  claimId: string;
  actor: ClaimActor;
  /** An administrator taking a claim away from whoever holds it. */
  force?: boolean;
}

export interface ReleaseClaimResult {
  released: true;
  claimId: string;
  /** True when the claim had already ended before this call. */
  alreadyReleased: boolean;
  notesDeleted: number;
}

/**
 * Gives a lease back, and deletes the notes bound to it.
 *
 * Idempotent on purpose: a client that releases, times out and retries must not
 * be told its second attempt failed. `force` is the administrator's override and
 * is audited under its own action, because taking someone else's claim away is
 * a different event from letting go of your own.
 */
export async function releaseClaim(input: ReleaseClaimInput): Promise<ReleaseClaimResult> {
  const db = getDatabase();

  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const claim = await lockClaim(tx, input.workspaceId, input.claimId);
      if (!claim) throw new PageServiceError('not_found', 'Claim not found');

      const isHolder =
        claim.holderType === input.actor.type && claim.holderId === input.actor.id;
      if (!isHolder && input.force !== true) {
        throw new PageServiceError(
          'forbidden',
          'Claim is held by another actor',
          conflictDetails(claim),
        );
      }

      if (claim.releasedAt !== null) {
        return {
          released: true as const,
          claimId: claim.id,
          alreadyReleased: true,
          notesDeleted: 0,
        };
      }

      const deletedNotes = await tx
        .delete(claimNotes)
        .where(eq(claimNotes.claimId, claim.id))
        .returning({ id: claimNotes.id });

      const reason: ClaimReleaseReason = input.force === true && !isHolder ? 'forced' : 'released';

      await tx
        .update(claims)
        .set({ releasedAt: now, releasedBy: input.actor.id, releaseReason: reason })
        .where(eq(claims.id, claim.id));

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: reason === 'forced' ? 'claim.force_released' : 'claim.released',
          target: claim.id,
          metadata: {
            pageId: claim.pageId,
            sectionId: claim.sectionId,
            result: 'success',
            heldBy: claim.holderLabel,
            holderId: claim.holderId,
            holderType: claim.holderType,
            notesDeleted: deletedNotes.length,
          },
        },
        tx,
      );

      return {
        released: true as const,
        claimId: claim.id,
        alreadyReleased: false,
        notesDeleted: deletedNotes.length,
      };
    });
  } catch (error) {
    if (isPageServiceError(error)) {
      await recordRejection(
        input.workspaceId,
        input.actor,
        input.force === true ? 'claim.force_release_rejected' : 'claim.release_rejected',
        input.claimId,
        error,
      );
    }
    throw error;
  }
}

/**
 * Releases every active claim on a set of pages, as an administrator would.
 *
 * Used when pages stop existing: a claim pointing at a deleted page would
 * otherwise sit in the presence board until its TTL ran out, naming a page
 * nobody can open.
 */
export async function releaseClaimsForPages(
  tx: DbExecutor,
  workspaceId: string,
  pageIds: readonly string[],
  actor: Pick<ClaimActor, 'id'>,
  now: Date = new Date(),
): Promise<number> {
  if (pageIds.length === 0) return 0;

  const affected = await tx
    .update(claims)
    .set({ releasedAt: now, releasedBy: actor.id, releaseReason: 'forced' })
    .where(
      and(
        eq(claims.workspaceId, workspaceId),
        inArray(claims.pageId, [...pageIds]),
        isNull(claims.releasedAt),
      ),
    )
    .returning({ id: claims.id });

  if (affected.length > 0) {
    await tx.delete(claimNotes).where(
      inArray(
        claimNotes.claimId,
        affected.map((row) => row.id),
      ),
    );
  }
  return affected.length;
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

export interface PostNoteInput {
  workspaceId: string;
  claimId: string;
  text: string;
  actor: ClaimActor;
}

/**
 * Leaves a short-lived note on a claim.
 *
 * Only the holder may write one: a note says what the holder is doing, and it
 * dies with the lease. Notes never reach `page_revisions` — they are intent
 * while an edit is in flight, not a version of the document.
 */
export async function postNote(input: PostNoteInput): Promise<ClaimNoteRecord> {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new PageServiceError('validation', 'A note must not be empty');
  }
  if (text.length > MAX_NOTE_LENGTH) {
    throw new PageServiceError('validation', `A note must be at most ${MAX_NOTE_LENGTH} characters`);
  }

  const db = getDatabase();

  try {
    return await db.transaction(async (tx) => {
      const now = new Date();
      const claim = await lockClaim(tx, input.workspaceId, input.claimId);
      if (!claim) throw new PageServiceError('not_found', 'Claim not found');

      if (claim.holderType !== input.actor.type || claim.holderId !== input.actor.id) {
        throw new PageServiceError(
          'forbidden',
          'Claim is held by another actor',
          conflictDetails(claim),
        );
      }
      if (claim.releasedAt !== null || isExpired(claim.expiresAt, now)) {
        throw new PageServiceError('conflict', 'Claim is no longer active');
      }

      const [note] = await tx
        .insert(claimNotes)
        .values({
          claimId: claim.id,
          workspaceId: input.workspaceId,
          text,
          authorType: input.actor.type,
          authorId: input.actor.id,
          authorLabel: input.actor.label,
          expiresAt: claim.expiresAt,
        })
        .returning(noteColumns);

      if (!note) throw new PageServiceError('conflict', 'Note could not be stored');

      await recordAudit(
        {
          workspaceId: input.workspaceId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: 'note.posted',
          target: note.id,
          metadata: {
            claimId: claim.id,
            pageId: claim.pageId,
            result: 'success',
            length: text.length,
          },
        },
        tx,
      );

      return note;
    });
  } catch (error) {
    if (isPageServiceError(error)) {
      await recordRejection(
        input.workspaceId,
        input.actor,
        'note.rejected',
        input.claimId,
        error,
      );
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* The write guard                                                     */
/* ------------------------------------------------------------------ */

export interface ClaimForWriteInput {
  tx: DbExecutor;
  workspaceId: string;
  pageId: string;
  claimId: string | null | undefined;
  /** Only identity matters here; the display label is set when a claim is taken. */
  actor: Pick<ClaimActor, 'type' | 'id'>;
  now?: Date;
}

/**
 * The check `PATCH /pages/{id}` runs before it writes anything.
 *
 * It is called inside the write transaction, after that transaction has locked
 * the page row, so a claim cannot expire or change hands between the check and
 * the update. The failure modes are the ones `docs/mcp.md` names for
 * `wiki.write_page`: no usable claim is a `conflict`, an expired or released
 * one is `not_found`, somebody else's is `forbidden`.
 */
export async function requireClaimForWrite(input: ClaimForWriteInput): Promise<ClaimRecord> {
  const now = input.now ?? new Date();

  if (!input.claimId) {
    throw new PageServiceError(
      'conflict',
      'A write requires an active claim on this page',
      { reason: 'claim_required' },
    );
  }

  const claim = await lockClaim(input.tx, input.workspaceId, input.claimId);
  if (!claim) throw new PageServiceError('not_found', 'Claim not found');

  if (claim.pageId !== input.pageId) {
    throw new PageServiceError('conflict', 'Claim does not cover this page', {
      reason: 'claim_page_mismatch',
    });
  }
  if (claim.holderType !== input.actor.type || claim.holderId !== input.actor.id) {
    throw new PageServiceError(
      'forbidden',
      'Claim is held by another actor',
      conflictDetails(claim),
    );
  }
  if (claim.releasedAt !== null) {
    throw new PageServiceError('not_found', 'Claim has been released');
  }
  if (isExpired(claim.expiresAt, now)) {
    const expired = await expireMatchingClaims(input.tx, eq(claims.id, claim.id), now);
    await auditExpired(input.tx, expired);
    throw new PageServiceError('not_found', 'Claim has expired');
  }

  return claim;
}

/**
 * Moves a claim's base hash forward after its holder writes.
 *
 * Without this the holder's second write under the same lease would be refused
 * as stale against its own first write.
 */
export async function advanceClaimBaseHash(
  tx: DbExecutor,
  claimId: string,
  contentHash: string,
): Promise<void> {
  await tx.update(claims).set({ baseContentHash: contentHash }).where(eq(claims.id, claimId));
}
