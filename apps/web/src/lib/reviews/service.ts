import 'server-only';

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { agentTokens, pageReviews, pageRevisions, pages, users } from '@clewwiki/db';
import type { SQL } from 'drizzle-orm';
import type { ActorKind, ReviewDecisionValue } from '@clewwiki/db';
import { diffText } from '@clewwiki/content/diff';
import type { DiffStats, TextDiff } from '@clewwiki/content/diff';

import { recordAudit } from '../audit';
import { acquireClaim, releaseClaim } from '../claims/service';
import { getDatabase } from '../db';
import type { DbExecutor } from '../db';
import { PageServiceError } from '../pages/errors';
import { getRevision, requirePage, updatePage } from '../pages/service';
import type { PageRecord, RevisionRecord } from '../pages/service';

/**
 * Review after the fact: what agents changed, shown to a person, who leaves it
 * or puts the page back.
 *
 * Three rules hold the design together.
 *
 * 1. **Nothing waits for a review.** An agent's write is the page the moment it
 *    lands. A queue in front of the write would make agents as slow as the
 *    person approving them, and the claim protocol already keeps writers from
 *    overwriting each other. What a person gets is a list of what changed since
 *    they last looked, and a way back.
 * 2. **Pending is derived, not stored.** The baseline of a page is the newest
 *    version a person wrote or accepted; agent revisions after it are pending.
 *    There is no flag to fall out of step with the history, and a person who
 *    edits a page has reviewed it by doing so.
 * 3. **Only a person decides.** The functions that record a decision take a
 *    reviewer, not an actor, and the handlers refuse a bearer token before
 *    calling them. An agent accepting agents' work would make the list
 *    meaningless.
 *
 * Every function takes the caller's `workspaceId` and puts it in the SQL
 * predicate, so a page in another workspace is invisible rather than merely
 * forbidden.
 */

/** Longest note a reviewer can leave; the column enforces the same. */
export const MAX_REVIEW_NOTE_LENGTH = 2_000;

/** Bodies past this size are listed without line counts rather than diffed for a listing. */
const MAX_LISTING_DIFF_BYTES = 512 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Reviewer {
  /** A user id. Never a token. */
  id: string;
  label: string;
}

export interface ActorRef {
  type: ActorKind;
  id: string;
  /** The account's or token's current name; a short id when it no longer exists. */
  label: string;
}

export interface PageReviewRecord {
  id: string;
  pageId: string;
  decision: ReviewDecisionValue;
  fromVersion: number;
  toVersion: number;
  resultVersion: number | null;
  reviewerId: string;
  reviewerLabel: string;
  note: string | null;
  createdAt: Date;
}

const reviewColumns = {
  id: pageReviews.id,
  pageId: pageReviews.pageId,
  decision: pageReviews.decision,
  fromVersion: pageReviews.fromVersion,
  toVersion: pageReviews.toVersion,
  resultVersion: pageReviews.resultVersion,
  reviewerId: pageReviews.reviewerId,
  reviewerLabel: pageReviews.reviewerLabel,
  note: pageReviews.note,
  createdAt: pageReviews.createdAt,
} as const;

/**
 * What became of one revision.
 *
 * - `pending` — an agent wrote it and no person has looked since.
 * - `accepted` — a person accepted a range that includes it.
 * - `reverted` — a person put the page back to what it was before it.
 * - `edited` — a person wrote a later version without deciding explicitly,
 *   which settles it all the same.
 * - `none` — a person wrote it; there is nothing to review.
 */
export type RevisionReviewStatus = 'pending' | 'accepted' | 'reverted' | 'edited' | 'none';

/* ------------------------------------------------------------------ */
/* Baseline                                                            */
/* ------------------------------------------------------------------ */

/**
 * The newest version of a page that a person wrote or accepted, 0 when there is
 * none. Written against the `pages` row of the enclosing query.
 *
 * The outer table is spelled out rather than interpolated: in a query over one
 * table the builder writes a bare `"id"`, which inside these subqueries would
 * mean the revision's or the review's own id.
 */
const baselineVersion: SQL<number> = sql<number>`greatest(
  coalesce((
    select max(r.version) from page_revisions r
    where r.page_id = "pages"."id" and r.author_type = 'user'
  ), 0),
  coalesce((
    select max(v.to_version) from page_reviews v
    where v.page_id = "pages"."id" and v.decision = 'accepted'
  ), 0)
)`.mapWith(Number);

/**
 * True for a page with agent revisions nobody has looked at. The newest
 * revision's author is on the page row, so a page a person wrote last is ruled
 * out before the subqueries run.
 */
const isPending: SQL = sql`("pages"."updated_by_type" = 'agent' and "pages"."version" > ${baselineVersion})`;

/** The status of one revision, given the page's baseline and its review rows. */
export function revisionStatus(
  revision: { version: number; authorType: ActorKind },
  baseline: number,
  reviews: ReadonlyArray<Pick<PageReviewRecord, 'decision' | 'fromVersion' | 'toVersion'>>,
): RevisionReviewStatus {
  if (revision.authorType === 'user') return 'none';
  if (revision.version > baseline) return 'pending';
  const covering = reviews.filter(
    (review) => revision.version > review.fromVersion && revision.version <= review.toVersion,
  );
  // A range can be reverted and, after the agent tries again, a wider range
  // accepted; the revert is what happened to this revision's content.
  if (covering.some((review) => review.decision === 'reverted')) return 'reverted';
  if (covering.some((review) => review.decision === 'accepted')) return 'accepted';
  return 'edited';
}

/* ------------------------------------------------------------------ */
/* Actor names                                                         */
/* ------------------------------------------------------------------ */

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Names for the authors of revisions. A revision records an id and not a name —
 * history is append-only and names change — so the name is looked up when the
 * history is shown. A token that has since been deleted is shown by the start
 * of its id, which is still enough to tell two of them apart.
 */
export async function resolveActors(
  workspaceId: string,
  actors: ReadonlyArray<{ type: ActorKind; id: string }>,
  executor: DbExecutor = getDatabase(),
): Promise<(actor: { type: ActorKind; id: string }) => ActorRef> {
  const tokenIds = [
    ...new Set(actors.filter((a) => a.type === 'agent' && UUID_PATTERN.test(a.id)).map((a) => a.id)),
  ];
  const userIds = [...new Set(actors.filter((a) => a.type === 'user').map((a) => a.id))];

  const names = new Map<string, string>();
  if (tokenIds.length > 0) {
    const rows = await executor
      .select({ id: agentTokens.id, name: agentTokens.name })
      .from(agentTokens)
      .where(and(eq(agentTokens.workspaceId, workspaceId), inArray(agentTokens.id, tokenIds)));
    for (const row of rows) names.set(`agent:${row.id}`, row.name);
  }
  if (userIds.length > 0) {
    const rows = await executor
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const row of rows) names.set(`user:${row.id}`, row.name);
  }

  return (actor) => ({
    type: actor.type,
    id: actor.id,
    label: names.get(`${actor.type}:${actor.id}`) ?? shortId(actor.id),
  });
}

/* ------------------------------------------------------------------ */
/* One page                                                            */
/* ------------------------------------------------------------------ */

export interface RevisionSummary {
  version: number;
  title: string;
  summary: string | null;
  contentHash: string;
  author: ActorRef;
  createdAt: Date;
  status: RevisionReviewStatus;
}

export interface PageReviewState {
  page: PageRecord;
  /** The newest version a person wrote or accepted; 0 when there is none. */
  baselineVersion: number;
  pending: boolean;
  /** The agent revisions after the baseline, oldest first. Empty when not pending. */
  pendingRevisions: RevisionSummary[];
  /** Decisions recorded for this page, newest first. */
  reviews: PageReviewRecord[];
}

async function readBaseline(
  executor: DbExecutor,
  workspaceId: string,
  pageId: string,
): Promise<number> {
  const [row] = await executor
    .select({ baseline: baselineVersion })
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId)))
    .limit(1);
  return row?.baseline ?? 0;
}

async function readReviews(executor: DbExecutor, pageIds: string[]): Promise<PageReviewRecord[]> {
  if (pageIds.length === 0) return [];
  return executor
    .select(reviewColumns)
    .from(pageReviews)
    .where(inArray(pageReviews.pageId, pageIds))
    .orderBy(desc(pageReviews.createdAt), desc(pageReviews.toVersion));
}

/** Where a page stands: its baseline, what is pending, and what was decided before. */
export async function getPageReviewState(
  workspaceId: string,
  pageId: string,
  executor: DbExecutor = getDatabase(),
): Promise<PageReviewState> {
  const page = await requirePage(workspaceId, pageId, executor);
  const baseline = await readBaseline(executor, workspaceId, pageId);
  const reviews = await readReviews(executor, [pageId]);
  const pending = page.updatedByType === 'agent' && page.version > baseline;

  let pendingRevisions: RevisionSummary[] = [];
  if (pending) {
    const rows = await executor
      .select({
        version: pageRevisions.version,
        title: pageRevisions.title,
        summary: pageRevisions.summary,
        contentHash: pageRevisions.contentHash,
        authorType: pageRevisions.authorType,
        authorId: pageRevisions.authorId,
        createdAt: pageRevisions.createdAt,
      })
      .from(pageRevisions)
      .where(and(eq(pageRevisions.pageId, pageId), sql`${pageRevisions.version} > ${baseline}`))
      .orderBy(pageRevisions.version)
      .limit(500);
    const nameOf = await resolveActors(
      workspaceId,
      rows.map((row) => ({ type: row.authorType, id: row.authorId })),
      executor,
    );
    pendingRevisions = rows.map((row) => ({
      version: row.version,
      title: row.title,
      summary: row.summary,
      contentHash: row.contentHash,
      author: nameOf({ type: row.authorType, id: row.authorId }),
      createdAt: row.createdAt,
      status: 'pending',
    }));
  }

  return { page, baselineVersion: baseline, pending, pendingRevisions, reviews };
}

/** Every version of a page, newest first, each with its author's name and what became of it. */
export async function listPageHistory(
  workspaceId: string,
  pageId: string,
  limit = 200,
): Promise<RevisionSummary[]> {
  const db = getDatabase();
  await requirePage(workspaceId, pageId);
  const [baseline, reviews, rows] = await Promise.all([
    readBaseline(db, workspaceId, pageId),
    readReviews(db, [pageId]),
    db
      .select({
        version: pageRevisions.version,
        title: pageRevisions.title,
        summary: pageRevisions.summary,
        contentHash: pageRevisions.contentHash,
        authorType: pageRevisions.authorType,
        authorId: pageRevisions.authorId,
        createdAt: pageRevisions.createdAt,
      })
      .from(pageRevisions)
      .where(eq(pageRevisions.pageId, pageId))
      .orderBy(desc(pageRevisions.version))
      .limit(limit),
  ]);
  const nameOf = await resolveActors(
    workspaceId,
    rows.map((row) => ({ type: row.authorType, id: row.authorId })),
  );
  return rows.map((row) => ({
    version: row.version,
    title: row.title,
    summary: row.summary,
    contentHash: row.contentHash,
    author: nameOf({ type: row.authorType, id: row.authorId }),
    createdAt: row.createdAt,
    status: revisionStatus(row, baseline, reviews),
  }));
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

export interface VersionDiff {
  pageId: string;
  /** Null when `from` is 0: the comparison is against a page that did not exist. */
  from: RevisionRecord | null;
  to: RevisionRecord;
  titleChanged: boolean;
  summaryChanged: boolean;
  diff: TextDiff;
}

/**
 * Compares two versions of a page. `from` may be 0, meaning "before the page
 * existed", which is how a page an agent created is shown in full as added.
 */
export async function diffPageVersions(
  workspaceId: string,
  pageId: string,
  fromVersion: number,
  toVersion: number,
  options: { context?: number } = {},
): Promise<VersionDiff> {
  if (fromVersion < 0 || toVersion < 1 || fromVersion >= toVersion) {
    throw new PageServiceError('validation', '`from` must be lower than `to`', {
      from: fromVersion,
      to: toVersion,
    });
  }
  const to = await getRevision(workspaceId, pageId, toVersion);
  if (!to) throw new PageServiceError('not_found', `Version ${toVersion} not found`);
  const from = fromVersion === 0 ? null : await getRevision(workspaceId, pageId, fromVersion);
  if (fromVersion !== 0 && !from) {
    throw new PageServiceError('not_found', `Version ${fromVersion} not found`);
  }

  return {
    pageId,
    from,
    to,
    titleChanged: from !== null && from.title !== to.title,
    summaryChanged: from !== null && (from.summary ?? '') !== (to.summary ?? ''),
    diff: diffText(from?.body ?? '', to.body, { context: options.context }),
  };
}

/* ------------------------------------------------------------------ */
/* A space                                                             */
/* ------------------------------------------------------------------ */

export interface PendingPage {
  page: { id: string; path: string; title: string; version: number; updatedAt: Date };
  baselineVersion: number;
  /** How many agent revisions are waiting. */
  revisionCount: number;
  /** Who wrote them, without repeats, newest first. */
  authors: ActorRef[];
  /** True when there is no baseline: an agent created the page. */
  created: boolean;
  /** Lines added and removed since the baseline; null when too large to count for a listing. */
  stats: DiffStats | null;
}

export async function countPendingPages(
  workspaceId: string,
  spaceId: string,
  executor: DbExecutor = getDatabase(),
): Promise<number> {
  const [row] = await executor
    .select({ value: sql<number>`count(*)`.mapWith(Number) })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.spaceId, spaceId),
        isNull(pages.deletedAt),
        isPending,
      ),
    );
  return row?.value ?? 0;
}

/** The pages of a space with agent changes nobody has looked at, most recently changed first. */
export async function listPendingPages(
  workspaceId: string,
  spaceId: string,
  limit = 50,
): Promise<PendingPage[]> {
  const db = getDatabase();
  const rows = await db
    .select({
      id: pages.id,
      path: pages.path,
      title: pages.title,
      version: pages.version,
      body: pages.body,
      updatedAt: pages.updatedAt,
      baseline: baselineVersion,
    })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.spaceId, spaceId),
        isNull(pages.deletedAt),
        isPending,
      ),
    )
    .orderBy(desc(pages.updatedAt), desc(pages.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const pageIds = rows.map((row) => row.id);
  const baselineOf = new Map(rows.map((row) => [row.id, row.baseline]));

  // Every revision of these pages, without bodies: the pending ones are counted
  // and attributed, and the baseline ones say which bodies to fetch.
  const revisions = await db
    .select({
      pageId: pageRevisions.pageId,
      version: pageRevisions.version,
      authorType: pageRevisions.authorType,
      authorId: pageRevisions.authorId,
    })
    .from(pageRevisions)
    .where(inArray(pageRevisions.pageId, pageIds))
    .orderBy(desc(pageRevisions.version));
  const pendingRevisions = revisions.filter(
    (revision) => revision.version > (baselineOf.get(revision.pageId) ?? 0),
  );

  const withBaseline = rows.filter((row) => row.baseline > 0);
  const baselineBodies = new Map<string, string>();
  if (withBaseline.length > 0) {
    const bodies = await db
      .select({ pageId: pageRevisions.pageId, body: pageRevisions.body })
      .from(pageRevisions)
      .where(
        or(
          ...withBaseline.map((row) =>
            and(eq(pageRevisions.pageId, row.id), eq(pageRevisions.version, row.baseline)),
          ),
        ),
      );
    for (const row of bodies) baselineBodies.set(row.pageId, row.body);
  }

  const nameOf = await resolveActors(
    workspaceId,
    pendingRevisions.map((revision) => ({ type: revision.authorType, id: revision.authorId })),
  );

  return rows.map((row) => {
    const own = pendingRevisions.filter((revision) => revision.pageId === row.id);
    const seen = new Set<string>();
    const authors: ActorRef[] = [];
    for (const revision of own) {
      const key = `${revision.authorType}:${revision.authorId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      authors.push(nameOf({ type: revision.authorType, id: revision.authorId }));
    }

    const before = row.baseline > 0 ? baselineBodies.get(row.id) : '';
    const countable =
      before !== undefined &&
      before.length <= MAX_LISTING_DIFF_BYTES &&
      row.body.length <= MAX_LISTING_DIFF_BYTES;

    return {
      page: {
        id: row.id,
        path: row.path,
        title: row.title,
        version: row.version,
        updatedAt: row.updatedAt,
      },
      baselineVersion: row.baseline,
      revisionCount: own.length,
      authors,
      created: row.baseline === 0,
      stats: countable ? diffText(before, row.body, { context: 0 }).stats : null,
    };
  });
}

export interface ChangeEntry {
  page: { id: string; path: string; title: string; version: number };
  version: number;
  title: string;
  summary: string | null;
  contentHash: string;
  author: ActorRef;
  createdAt: Date;
  status: RevisionReviewStatus;
  /** Keyset cursor of this entry; pass the last one back as `before`. */
  cursor: string;
}

export interface ListChangesOptions {
  limit?: number;
  /** A cursor from a previous listing: only entries older than it. */
  before?: string | null;
  authorType?: ActorKind;
}

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const separator = cursor.indexOf('_');
  const createdAt = new Date(separator < 0 ? '' : cursor.slice(0, separator));
  const id = separator < 0 ? '' : cursor.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw new PageServiceError('validation', '`before` is not a cursor returned by this endpoint');
  }
  return { createdAt, id };
}

/**
 * The change feed of a space: every revision of its live pages, newest first,
 * each with what became of it.
 *
 * The cursor is the revision's timestamp *and* id. A timestamp alone is not
 * enough: an import writes hundreds of revisions in one transaction, and they
 * all carry its start time.
 */
export async function listChanges(
  workspaceId: string,
  spaceId: string,
  options: ListChangesOptions = {},
): Promise<ChangeEntry[]> {
  const db = getDatabase();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const before = options.before ? decodeCursor(options.before) : null;

  const rows = await db
    .select({
      id: pageRevisions.id,
      version: pageRevisions.version,
      title: pageRevisions.title,
      summary: pageRevisions.summary,
      contentHash: pageRevisions.contentHash,
      authorType: pageRevisions.authorType,
      authorId: pageRevisions.authorId,
      createdAt: pageRevisions.createdAt,
      pageId: pages.id,
      pagePath: pages.path,
      pageTitle: pages.title,
      pageVersion: pages.version,
      baseline: baselineVersion,
    })
    .from(pageRevisions)
    .innerJoin(pages, eq(pages.id, pageRevisions.pageId))
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.spaceId, spaceId),
        isNull(pages.deletedAt),
        options.authorType ? eq(pageRevisions.authorType, options.authorType) : undefined,
        before
          ? or(
              lt(pageRevisions.createdAt, before.createdAt),
              and(eq(pageRevisions.createdAt, before.createdAt), lt(pageRevisions.id, before.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(pageRevisions.createdAt), desc(pageRevisions.id))
    .limit(limit);
  if (rows.length === 0) return [];

  const reviews = await readReviews(db, [...new Set(rows.map((row) => row.pageId))]);
  const nameOf = await resolveActors(
    workspaceId,
    rows.map((row) => ({ type: row.authorType, id: row.authorId })),
  );

  return rows.map((row) => ({
    page: { id: row.pageId, path: row.pagePath, title: row.pageTitle, version: row.pageVersion },
    version: row.version,
    title: row.title,
    summary: row.summary,
    contentHash: row.contentHash,
    author: nameOf({ type: row.authorType, id: row.authorId }),
    createdAt: row.createdAt,
    status: revisionStatus(
      row,
      row.baseline,
      reviews.filter((review) => review.pageId === row.pageId),
    ),
    cursor: encodeCursor(row.createdAt, row.id),
  }));
}

/* ------------------------------------------------------------------ */
/* Deciding                                                            */
/* ------------------------------------------------------------------ */

export function normalizeReviewNote(raw: string | null | undefined): string | null {
  const note = (raw ?? '').trim();
  if (note === '') return null;
  if (note.length > MAX_REVIEW_NOTE_LENGTH) {
    throw new PageServiceError(
      'validation',
      `A review note is at most ${MAX_REVIEW_NOTE_LENGTH} characters`,
      { max_length: MAX_REVIEW_NOTE_LENGTH },
    );
  }
  return note;
}

export interface ReviewPageInput {
  workspaceId: string;
  pageId: string;
  reviewer: Reviewer;
  /**
   * The version the reviewer was looking at. It must still be the newest: a
   * decision about a page that has changed since is a decision about something
   * the reviewer has not seen.
   */
  headVersion: number;
  note?: string | null;
}

export interface ReviewPageResult {
  review: PageReviewRecord;
  page: PageRecord;
}

function staleHead(page: PageRecord, headVersion: number): PageServiceError {
  return new PageServiceError(
    'stale_base',
    `The page is at version ${page.version}, not ${headVersion}. Look at the newer changes before deciding.`,
    { current_version: page.version, reviewed_version: headVersion },
  );
}

function nothingPending(page: PageRecord, baseline: number): PageServiceError {
  return new PageServiceError('conflict', 'This page has no agent changes waiting for a review', {
    reason: 'nothing_pending',
    current_version: page.version,
    baseline_version: baseline,
  });
}

/**
 * Accepts everything agents wrote since the baseline. The page is not touched:
 * the content is already the page, and what changes is that it no longer waits.
 */
export async function acceptPageChanges(input: ReviewPageInput): Promise<ReviewPageResult> {
  const note = normalizeReviewNote(input.note);
  const db = getDatabase();

  return db.transaction(async (tx) => {
    // Locked, so an agent's write and this decision cannot pass each other: the
    // write either lands first and the version check below refuses, or waits
    // and becomes a pending change of its own.
    await tx.execute(
      sql`select id from pages where id = ${input.pageId}::uuid and workspace_id = ${input.workspaceId}::uuid for update`,
    );
    const page = await requirePage(input.workspaceId, input.pageId, tx);
    if (page.version !== input.headVersion) throw staleHead(page, input.headVersion);

    const baseline = await readBaseline(tx, input.workspaceId, input.pageId);
    if (page.updatedByType !== 'agent' || page.version <= baseline) {
      throw nothingPending(page, baseline);
    }

    const [review] = await tx
      .insert(pageReviews)
      .values({
        workspaceId: input.workspaceId,
        spaceId: page.spaceId,
        pageId: page.id,
        decision: 'accepted',
        fromVersion: baseline,
        toVersion: page.version,
        reviewerId: input.reviewer.id,
        reviewerLabel: input.reviewer.label,
        note,
      })
      .returning(reviewColumns);
    if (!review) throw new Error('review insert returned no row');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.reviewer.id,
        action: 'page.review_accepted',
        target: page.id,
        metadata: {
          result: 'accepted',
          path: page.path,
          from_version: baseline,
          to_version: page.version,
        },
      },
      tx,
    );

    return { review, page };
  });
}

/**
 * Puts the page back to its baseline by writing the baseline's content as a new
 * version, authored by the reviewer.
 *
 * Nothing is removed from the history: the agent's revisions stay, followed by
 * the one that undid them, which is the same shape a person undoing the change
 * by hand would have produced. The write goes through the claim protocol like
 * any other, so a page somebody holds a lease on is refused with the conflict
 * that names them — an agent in the middle of a write is not pulled out from
 * under.
 */
export async function revertPageChanges(input: ReviewPageInput): Promise<ReviewPageResult> {
  const note = normalizeReviewNote(input.note);
  const db = getDatabase();

  const page = await requirePage(input.workspaceId, input.pageId);
  if (page.version !== input.headVersion) throw staleHead(page, input.headVersion);

  const baseline = await readBaseline(db, input.workspaceId, input.pageId);
  if (page.updatedByType !== 'agent' || page.version <= baseline) {
    throw nothingPending(page, baseline);
  }
  if (baseline === 0) {
    throw new PageServiceError(
      'conflict',
      'An agent created this page and nobody has reviewed it since, so there is no earlier version to go back to. Accept it, edit it, or delete it.',
      { reason: 'no_baseline', current_version: page.version },
    );
  }
  const target = await getRevision(input.workspaceId, input.pageId, baseline);
  if (!target) throw new PageServiceError('not_found', `Version ${baseline} not found`);

  const actor = { type: 'user' as const, id: input.reviewer.id, label: input.reviewer.label };
  const { claim, created } = await acquireClaim({
    workspaceId: input.workspaceId,
    pageId: page.id,
    actor,
  });

  let reverted: PageRecord;
  try {
    // The claim was taken after the version was read. If somebody wrote in
    // between, the lease starts from their hash and not from the one the
    // reviewer saw, and the revert would silently take their write with it.
    if (claim.baseContentHash !== page.contentHash) {
      const current = await requirePage(input.workspaceId, input.pageId);
      throw staleHead(current, input.headVersion);
    }
    reverted = await updatePage({
      workspaceId: input.workspaceId,
      pageId: page.id,
      actor: { type: 'user', id: input.reviewer.id },
      title: target.title,
      body: target.body,
      summary: target.summary,
      claimId: claim.id,
      baseContentHash: claim.baseContentHash,
    });
  } finally {
    // A lease the reviewer already held — the page open in their editor — was
    // extended, not created, and is theirs to keep.
    if (created) {
      await releaseClaim({ workspaceId: input.workspaceId, claimId: claim.id, actor }).catch(
        (error: unknown) => {
          console.error('[reviews] revert claim could not be released', error);
        },
      );
    }
  }

  // Recorded after the write rather than with it, because the write owns its
  // transaction. Should this insert fail, the page is still consistent: the
  // revert is a person's revision, which is a baseline with or without a row.
  const review = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(pageReviews)
      .values({
        workspaceId: input.workspaceId,
        spaceId: page.spaceId,
        pageId: page.id,
        decision: 'reverted',
        fromVersion: baseline,
        toVersion: page.version,
        resultVersion: reverted.version,
        reviewerId: input.reviewer.id,
        reviewerLabel: input.reviewer.label,
        note,
      })
      .returning(reviewColumns);
    if (!row) throw new Error('review insert returned no row');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.reviewer.id,
        action: 'page.review_reverted',
        target: page.id,
        metadata: {
          result: 'reverted',
          path: page.path,
          from_version: baseline,
          to_version: page.version,
          result_version: reverted.version,
        },
      },
      tx,
    );
    return row;
  });

  return { review, page: reverted };
}
