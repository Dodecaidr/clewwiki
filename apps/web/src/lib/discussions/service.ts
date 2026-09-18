import 'server-only';

import { and, asc, count, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { discussionMessages, discussions, pages, spaces } from '@clewwiki/db';
import type { SQL } from 'drizzle-orm';
import type { ActorKind, DiscussionStatusValue, SpaceSettings } from '@clewwiki/db';

import { DECISIONS_PAGE_SLUG, buildDecisionPageBody, decisionsParentTemplate } from './decision-page';
import { nextExpiry, readDiscussionPolicy } from './retention';
import type { DiscussionPolicy } from './retention';
import { recordAudit } from '../audit';
import { SECTION_ID_PATTERN, acquireClaim, releaseClaim } from '../claims/service';
import { getDatabase } from '../db';
import type { DbExecutor } from '../db';
import { PageServiceError } from '../pages/errors';
import { createPage, getPageById, updatePage } from '../pages/service';
import type { PageRecord } from '../pages/service';
import type { Locale } from '@/i18n/locale';

/**
 * The discussion service: open a thread, talk in it, resolve it into a
 * decision, and let the rest be cleaned up.
 *
 * Three rules hold the design together.
 *
 * 1. **The conversation is ephemeral and the outcome is not.** Agents working
 *    in parallel need somewhere to ask "I am changing the auth contract, does
 *    anything of yours depend on it?", and that exchange is worth nothing to
 *    anybody a month later. So a thread that goes quiet is closed, a resolved
 *    thread is deleted with its messages, and what survives is a decision page
 *    — an ordinary page, versioned and searchable like every other.
 * 2. **One deadline.** `expires_at` says when a discussion is next acted on:
 *    closed while it is open, deleted once it is resolved. Expiry is applied
 *    lazily wherever the answer matters, and by a sweep for everything nobody
 *    asked about, exactly as claims do it — so "still there" means one thing to
 *    the service, to the listing and to the sweep alike.
 * 3. **The server never writes the decision.** Resolving takes the caller's own
 *    text and puts it under headings. Nothing here reads a thread and decides
 *    what it meant.
 *
 * Every function takes the caller's `workspaceId` and puts it in the SQL
 * predicate, so a discussion in another workspace is invisible rather than
 * merely forbidden.
 */

export interface DiscussionActor {
  type: ActorKind;
  id: string;
  /** Display name snapshotted onto the thread, the way a claim snapshots its holder. */
  label: string;
}

export interface DiscussionRecord {
  id: string;
  workspaceId: string;
  spaceId: string;
  title: string;
  status: DiscussionStatusValue;
  openedByType: ActorKind;
  openedById: string;
  openedByLabel: string;
  pageId: string | null;
  sectionId: string | null;
  lastActivityAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  decisionPageId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface DiscussionMessageRecord {
  id: string;
  discussionId: string;
  workspaceId: string;
  authorType: ActorKind;
  authorId: string;
  authorLabel: string;
  body: string;
  createdAt: Date;
}

export interface DiscussionParticipant {
  type: ActorKind;
  label: string;
}

/** A discussion with the numbers a listing shows. */
export interface DiscussionSummary extends DiscussionRecord {
  messageCount: number;
  participants: DiscussionParticipant[];
}

const discussionColumns = {
  id: discussions.id,
  workspaceId: discussions.workspaceId,
  spaceId: discussions.spaceId,
  title: discussions.title,
  status: discussions.status,
  openedByType: discussions.openedByType,
  openedById: discussions.openedById,
  openedByLabel: discussions.openedByLabel,
  pageId: discussions.pageId,
  sectionId: discussions.sectionId,
  lastActivityAt: discussions.lastActivityAt,
  resolvedAt: discussions.resolvedAt,
  resolvedBy: discussions.resolvedBy,
  decisionPageId: discussions.decisionPageId,
  expiresAt: discussions.expiresAt,
  createdAt: discussions.createdAt,
} as const;

const messageColumns = {
  id: discussionMessages.id,
  discussionId: discussionMessages.discussionId,
  workspaceId: discussionMessages.workspaceId,
  authorType: discussionMessages.authorType,
  authorId: discussionMessages.authorId,
  authorLabel: discussionMessages.authorLabel,
  body: discussionMessages.body,
  createdAt: discussionMessages.createdAt,
} as const;

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** Longest title a thread can carry; the column enforces the same. */
export const MAX_DISCUSSION_TITLE_LENGTH = 200;

/**
 * Largest message body, in octets rather than characters — the cap bounds what
 * a thread costs to read back, and a message of Cyrillic is twice its character
 * count. The column carries the same check.
 */
export const MAX_MESSAGE_BYTES = 8_192;

/**
 * Most messages one thread may hold.
 *
 * A discussion that has run past two hundred messages is not a discussion any
 * more; it is a document nobody wrote. The cap is a refusal with an
 * instruction — resolve this and open a new one — rather than a silent truncation.
 */
export const MAX_MESSAGES_PER_DISCUSSION = 200;

/**
 * Most discussions a space may have open at once. A hundred open threads is
 * already more than a team can read; past that the listing stops being useful
 * and the cap stops a loop from filling the table.
 */
export const MAX_OPEN_DISCUSSIONS_PER_SPACE = 100;

/** Longest each free-text field of a decision may be. */
export const MAX_DECISION_FIELD_LENGTH = 20_000;

const encoder = new TextEncoder();

export function messageByteLength(body: string): number {
  return encoder.encode(body).length;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export function normalizeDiscussionTitle(raw: string): string {
  const title = raw.trim().replace(/\s+/g, ' ');
  if (title.length === 0) {
    throw new PageServiceError('validation', 'A discussion needs a title');
  }
  if (title.length > MAX_DISCUSSION_TITLE_LENGTH) {
    throw new PageServiceError(
      'validation',
      `A discussion title is at most ${MAX_DISCUSSION_TITLE_LENGTH} characters`,
      { max_length: MAX_DISCUSSION_TITLE_LENGTH },
    );
  }
  return title;
}

export function normalizeMessageBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) {
    throw new PageServiceError('validation', 'A message needs a body');
  }
  const bytes = messageByteLength(body);
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new PageServiceError('validation', `A message is at most ${MAX_MESSAGE_BYTES} bytes`, {
      max_bytes: MAX_MESSAGE_BYTES,
      bytes,
    });
  }
  return body;
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

function normalizeDecisionField(raw: string | null | undefined, field: string): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  if (value.length > MAX_DECISION_FIELD_LENGTH) {
    throw new PageServiceError(
      'validation',
      `${field} is at most ${MAX_DECISION_FIELD_LENGTH} characters`,
      { field, max_length: MAX_DECISION_FIELD_LENGTH },
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Space lookup                                                        */
/* ------------------------------------------------------------------ */

interface SpaceContext {
  id: string;
  key: string;
  settings: SpaceSettings;
  archivedAt: Date | null;
  policy: DiscussionPolicy;
}

async function requireSpaceContext(
  workspaceId: string,
  spaceId: string,
  executor: DbExecutor = getDatabase(),
): Promise<SpaceContext> {
  const [row] = await executor
    .select({
      id: spaces.id,
      key: spaces.key,
      settings: spaces.settings,
      archivedAt: spaces.archivedAt,
    })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new PageServiceError('not_found', 'Space not found');
  return { ...row, policy: readDiscussionPolicy(row.settings) };
}

/* ------------------------------------------------------------------ */
/* Expiry                                                              */
/* ------------------------------------------------------------------ */

interface DueRow extends DiscussionRecord {
  settings: SpaceSettings;
}

async function selectDue(
  tx: DbExecutor,
  status: DiscussionStatusValue,
  now: Date,
  predicate: SQL | undefined,
): Promise<DueRow[]> {
  return tx
    .select({ ...discussionColumns, settings: spaces.settings })
    .from(discussions)
    .innerJoin(spaces, eq(spaces.id, discussions.spaceId))
    .where(and(eq(discussions.status, status), lte(discussions.expiresAt, now), predicate))
    .limit(500);
}

/**
 * Closes the open discussions that have gone quiet, and deletes the resolved
 * ones whose retention window has run out.
 *
 * Both halves are guarded by the state they expect (`status = 'open'`,
 * `status = 'resolved'`), so running this from several replicas at once ends a
 * thread exactly once. Deleting a discussion takes its messages with it — the
 * foreign key cascades — and never touches `decision_page_id`: the page it
 * points at is an ordinary page and outlives the conversation on purpose.
 *
 * A closed-for-inactivity thread is not merely marked. It is resolved with
 * `resolved_by = 'system'` and no decision page, which is exactly what "nobody
 * wrote down an outcome" looks like, and it is what the interface reads to show
 * the note saying so. No English sentence is stored in the row, so the note
 * reads in whatever language the person looking at it uses.
 */
export async function expireDiscussions(
  now: Date = new Date(),
  scope: SQL | undefined = undefined,
): Promise<{ closed: number; deleted: number }> {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    let closed = 0;
    let deleted = 0;

    for (const row of await selectDue(tx, 'open', now, scope)) {
      const policy = readDiscussionPolicy(row.settings);
      const [updated] = await tx
        .update(discussions)
        .set({
          status: 'resolved',
          resolvedAt: now,
          resolvedBy: 'system',
          expiresAt: nextExpiry('resolved', now, policy),
        })
        .where(and(eq(discussions.id, row.id), eq(discussions.status, 'open')))
        .returning({ id: discussions.id });
      if (!updated) continue;
      closed += 1;
      await recordAudit(
        {
          workspaceId: row.workspaceId,
          // Attributed to whoever opened the thread, the way an expired claim is
          // attributed to its holder: the row says whose thread lapsed, and the
          // metadata says that the sweep is what ended it.
          actorType: row.openedByType,
          actorId: row.openedById,
          action: 'discussion.expired',
          target: row.id,
          metadata: {
            result: 'expired',
            by: 'system',
            title: row.title,
            idle_days: policy.idleDays,
            last_activity_at: row.lastActivityAt.toISOString(),
          },
        },
        tx,
      );
    }

    const due = await selectDue(tx, 'resolved', now, scope);
    if (due.length > 0) {
      const ids = due.map((row) => row.id);
      const messageCounts = await tx
        .select({ discussionId: discussionMessages.discussionId, total: count() })
        .from(discussionMessages)
        .where(inArray(discussionMessages.discussionId, ids))
        .groupBy(discussionMessages.discussionId);
      const countById = new Map(messageCounts.map((row) => [row.discussionId, row.total]));

      const removed = await tx
        .delete(discussions)
        .where(and(inArray(discussions.id, ids), eq(discussions.status, 'resolved')))
        .returning({ id: discussions.id });
      const removedIds = new Set(removed.map((row) => row.id));
      deleted = removedIds.size;

      for (const row of due) {
        if (!removedIds.has(row.id)) continue;
        await recordAudit(
          {
            workspaceId: row.workspaceId,
            actorType: row.openedByType,
            actorId: row.openedById,
            action: 'discussion.deleted',
            target: row.id,
            // The title and the decision page are recorded here because the row
            // they came from is gone: without them the log would say that
            // something was deleted and nothing about what.
            metadata: {
              result: 'expired',
              by: 'system',
              title: row.title,
              decision_page_id: row.decisionPageId,
              messages_deleted: countById.get(row.id) ?? 0,
              resolved_at: row.resolvedAt?.toISOString() ?? null,
            },
          },
          tx,
        );
      }
    }

    return { closed, deleted };
  });
}

/** The whole-instance sweep, driven by the timer in `instrumentation.ts`. */
export async function sweepDiscussions(
  now: Date = new Date(),
): Promise<{ closed: number; deleted: number }> {
  return expireDiscussions(now);
}

/**
 * Lazy expiry, applied before a space's discussions are read.
 *
 * The sweep already does this on a timer; doing it again here is what keeps a
 * listing from showing a thread that should have gone, on an instance whose
 * sweep is turned off or has not come round yet.
 */
export async function expireDiscussionsInSpace(
  workspaceId: string,
  spaceId: string,
  now: Date = new Date(),
): Promise<void> {
  await expireDiscussions(
    now,
    and(eq(discussions.workspaceId, workspaceId), eq(discussions.spaceId, spaceId)),
  );
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

async function decorate(
  executor: DbExecutor,
  records: DiscussionRecord[],
): Promise<DiscussionSummary[]> {
  if (records.length === 0) return [];
  const ids = records.map((record) => record.id);

  const counts = await executor
    .select({ discussionId: discussionMessages.discussionId, total: count() })
    .from(discussionMessages)
    .where(inArray(discussionMessages.discussionId, ids))
    .groupBy(discussionMessages.discussionId);
  const countById = new Map(counts.map((row) => [row.discussionId, row.total]));

  // Distinct authors per thread, as labels rather than ids: the listing names
  // who is in the conversation, and a label is what a reader recognises.
  const authors = await executor
    .selectDistinct({
      discussionId: discussionMessages.discussionId,
      authorType: discussionMessages.authorType,
      authorLabel: discussionMessages.authorLabel,
    })
    .from(discussionMessages)
    .where(inArray(discussionMessages.discussionId, ids));
  const authorsById = new Map<string, DiscussionParticipant[]>();
  for (const row of authors) {
    const list = authorsById.get(row.discussionId) ?? [];
    list.push({ type: row.authorType, label: row.authorLabel });
    authorsById.set(row.discussionId, list);
  }

  return records.map((record) => {
    const participants: DiscussionParticipant[] = [
      { type: record.openedByType, label: record.openedByLabel },
      ...(authorsById.get(record.id) ?? []),
    ];
    const seen = new Set<string>();
    return {
      ...record,
      messageCount: countById.get(record.id) ?? 0,
      participants: participants.filter((entry) => {
        const key = `${entry.type}:${entry.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  });
}

export interface ListDiscussionsOptions {
  status?: DiscussionStatusValue;
  limit?: number;
}

/** The discussions of one space, newest activity first. */
export async function listDiscussions(
  workspaceId: string,
  spaceId: string,
  options: ListDiscussionsOptions = {},
): Promise<DiscussionSummary[]> {
  await expireDiscussionsInSpace(workspaceId, spaceId);
  const db = getDatabase();
  const filters = [eq(discussions.workspaceId, workspaceId), eq(discussions.spaceId, spaceId)];
  if (options.status) filters.push(eq(discussions.status, options.status));

  const rows = await db
    .select(discussionColumns)
    .from(discussions)
    .where(and(...filters))
    .orderBy(desc(discussions.lastActivityAt))
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 200));

  return decorate(db, rows);
}

/** How many discussions are open in each of the given spaces. */
export async function countOpenDiscussions(
  workspaceId: string,
  spaceIds: readonly string[],
): Promise<Map<string, number>> {
  if (spaceIds.length === 0) return new Map();
  const db = getDatabase();
  const rows = await db
    .select({ spaceId: discussions.spaceId, total: count() })
    .from(discussions)
    .where(
      and(
        eq(discussions.workspaceId, workspaceId),
        eq(discussions.status, 'open'),
        inArray(discussions.spaceId, [...spaceIds]),
      ),
    )
    .groupBy(discussions.spaceId);
  return new Map(rows.map((row) => [row.spaceId, row.total]));
}

/** The open discussions that name one page, for the badge on a page view. */
export async function listOpenDiscussionsForPage(
  workspaceId: string,
  pageId: string,
): Promise<DiscussionRecord[]> {
  const db = getDatabase();
  return db
    .select(discussionColumns)
    .from(discussions)
    .where(
      and(
        eq(discussions.workspaceId, workspaceId),
        eq(discussions.pageId, pageId),
        eq(discussions.status, 'open'),
      ),
    )
    .orderBy(desc(discussions.lastActivityAt))
    .limit(20);
}

export async function getDiscussionById(
  workspaceId: string,
  discussionId: string,
  executor: DbExecutor = getDatabase(),
): Promise<DiscussionRecord | null> {
  const [row] = await executor
    .select(discussionColumns)
    .from(discussions)
    .where(and(eq(discussions.id, discussionId), eq(discussions.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export interface DiscussionThread {
  discussion: DiscussionSummary;
  messages: DiscussionMessageRecord[];
}

/**
 * One discussion with its messages, oldest first.
 *
 * Expiry is applied to the thread's space before it is read, so a thread whose
 * deadline has passed answers `not_found` here rather than being shown one last
 * time to whoever happened to open it.
 */
export async function getDiscussionThread(
  workspaceId: string,
  discussionId: string,
): Promise<DiscussionThread | null> {
  const db = getDatabase();
  const existing = await getDiscussionById(workspaceId, discussionId);
  if (!existing) return null;
  await expireDiscussionsInSpace(workspaceId, existing.spaceId);

  const current = await getDiscussionById(workspaceId, discussionId);
  if (!current) return null;

  const messages = await db
    .select(messageColumns)
    .from(discussionMessages)
    .where(eq(discussionMessages.discussionId, current.id))
    .orderBy(asc(discussionMessages.createdAt))
    .limit(MAX_MESSAGES_PER_DISCUSSION);

  const [summary] = await decorate(db, [current]);
  if (!summary) return null;
  return { discussion: summary, messages };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export interface OpenDiscussionInput {
  workspaceId: string;
  spaceId: string;
  actor: DiscussionActor;
  title: string;
  /** The first message. A thread with nothing in it is not a question. */
  body: string;
  pageId?: string | null;
  sectionId?: string | null;
}

export interface OpenDiscussionResult {
  discussion: DiscussionRecord;
  message: DiscussionMessageRecord;
}

export async function openDiscussion(
  input: OpenDiscussionInput,
): Promise<OpenDiscussionResult> {
  const title = normalizeDiscussionTitle(input.title);
  const body = normalizeMessageBody(input.body);
  const sectionId = normalizeSectionId(input.sectionId);

  const db = getDatabase();
  const space = await requireSpaceContext(input.workspaceId, input.spaceId);
  if (space.archivedAt !== null) {
    throw new PageServiceError('conflict', 'This space is archived and takes no new discussions', {
      space: space.key,
    });
  }

  if (input.pageId) {
    const page = await getPageById(input.workspaceId, input.pageId);
    if (!page || page.spaceId !== space.id) {
      // "Not found" rather than "in another space", so the refusal says nothing
      // about a page the caller may not be able to see.
      throw new PageServiceError('not_found', 'Page not found');
    }
  }

  // Applied before the count, so threads that should already be gone do not
  // hold the cap closed.
  await expireDiscussionsInSpace(input.workspaceId, space.id);

  return db.transaction(async (tx) => {
    const [open] = await tx
      .select({ total: count() })
      .from(discussions)
      .where(
        and(
          eq(discussions.workspaceId, input.workspaceId),
          eq(discussions.spaceId, space.id),
          eq(discussions.status, 'open'),
        ),
      );
    if ((open?.total ?? 0) >= MAX_OPEN_DISCUSSIONS_PER_SPACE) {
      throw new PageServiceError(
        'validation',
        `This space already has ${MAX_OPEN_DISCUSSIONS_PER_SPACE} open discussions; resolve some before opening another`,
        { max_open: MAX_OPEN_DISCUSSIONS_PER_SPACE, space: space.key },
      );
    }

    const now = new Date();
    const [created] = await tx
      .insert(discussions)
      .values({
        workspaceId: input.workspaceId,
        spaceId: space.id,
        title,
        status: 'open',
        openedByType: input.actor.type,
        openedById: input.actor.id,
        openedByLabel: input.actor.label,
        pageId: input.pageId ?? null,
        sectionId,
        lastActivityAt: now,
        expiresAt: nextExpiry('open', now, space.policy),
      })
      .returning(discussionColumns);
    if (!created) throw new PageServiceError('conflict', 'The discussion could not be opened');

    const [message] = await tx
      .insert(discussionMessages)
      .values({
        discussionId: created.id,
        workspaceId: input.workspaceId,
        authorType: input.actor.type,
        authorId: input.actor.id,
        authorLabel: input.actor.label,
        body,
      })
      .returning(messageColumns);
    if (!message) throw new PageServiceError('conflict', 'The discussion could not be opened');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'discussion.opened',
        target: created.id,
        metadata: {
          space: space.key,
          title: created.title,
          page_id: created.pageId,
          section_id: created.sectionId,
        },
      },
      tx,
    );

    return { discussion: created, message };
  });
}

export interface PostDiscussionMessageInput {
  workspaceId: string;
  discussionId: string;
  actor: DiscussionActor;
  body: string;
}

export interface PostDiscussionMessageResult {
  discussion: DiscussionRecord;
  message: DiscussionMessageRecord;
}

/**
 * Adds a message and pushes the thread's deadline out.
 *
 * Posting is what "activity" means, so every message resets the idle window —
 * which is also why a resolved thread refuses one: its deadline is now a
 * deletion date, and reopening the conversation by writing into it would quietly
 * turn the record of a decision back into a conversation.
 */
export async function postDiscussionMessage(
  input: PostDiscussionMessageInput,
): Promise<PostDiscussionMessageResult> {
  const body = normalizeMessageBody(input.body);
  const db = getDatabase();

  const existing = await getDiscussionById(input.workspaceId, input.discussionId);
  if (!existing) throw new PageServiceError('not_found', 'Discussion not found');
  await expireDiscussionsInSpace(input.workspaceId, existing.spaceId);

  const space = await requireSpaceContext(input.workspaceId, existing.spaceId);

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(discussionColumns)
      .from(discussions)
      .where(
        and(eq(discussions.id, input.discussionId), eq(discussions.workspaceId, input.workspaceId)),
      )
      .limit(1)
      .for('update');
    if (!current) throw new PageServiceError('not_found', 'Discussion not found');
    if (current.status !== 'open') {
      throw new PageServiceError(
        'conflict',
        'This discussion is resolved; open a new one instead of reopening it',
        { discussion_id: current.id, decision_page_id: current.decisionPageId },
      );
    }

    const [existingCount] = await tx
      .select({ total: count() })
      .from(discussionMessages)
      .where(eq(discussionMessages.discussionId, current.id));
    if ((existingCount?.total ?? 0) >= MAX_MESSAGES_PER_DISCUSSION) {
      throw new PageServiceError(
        'validation',
        `This discussion has reached ${MAX_MESSAGES_PER_DISCUSSION} messages; resolve it with a decision and open a new one`,
        { max_messages: MAX_MESSAGES_PER_DISCUSSION, discussion_id: current.id },
      );
    }

    const now = new Date();
    const [message] = await tx
      .insert(discussionMessages)
      .values({
        discussionId: current.id,
        workspaceId: input.workspaceId,
        authorType: input.actor.type,
        authorId: input.actor.id,
        authorLabel: input.actor.label,
        body,
      })
      .returning(messageColumns);
    if (!message) throw new PageServiceError('conflict', 'The message could not be posted');

    const [updated] = await tx
      .update(discussions)
      .set({ lastActivityAt: now, expiresAt: nextExpiry('open', now, space.policy) })
      .where(eq(discussions.id, current.id))
      .returning(discussionColumns);
    if (!updated) throw new PageServiceError('not_found', 'Discussion not found');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'discussion.message',
        target: current.id,
        // The body is not in the metadata: the audit log says who spoke and
        // when, and the message itself is the thread's, which is deleted with it.
        metadata: { space: space.key, message_id: message.id, bytes: messageByteLength(body) },
      },
      tx,
    );

    return { discussion: updated, message };
  });
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Finds the page decision pages go under, creating `/decisions` the first time
 * anything is resolved in the space and recording it in the space settings.
 *
 * A configured page that has since been deleted, or was moved to another space,
 * is treated as absent rather than as an error: the resolution is the thing
 * that matters, and it must not fail because somebody tidied up a page.
 */
async function resolveDecisionsParent(
  space: SpaceContext,
  workspaceId: string,
  actor: DiscussionActor,
  locale: Locale,
): Promise<PageRecord> {
  const db = getDatabase();

  const configured = space.policy.decisionsPageId
    ? await getPageById(workspaceId, space.policy.decisionsPageId)
    : null;
  if (configured && configured.spaceId === space.id && configured.deletedAt === null) {
    return configured;
  }

  const [existing] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.spaceId, space.id),
        eq(pages.path, `/${DECISIONS_PAGE_SLUG}`),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);

  const parent =
    (existing ? await getPageById(workspaceId, existing.id) : null) ??
    (await createPage({
      workspaceId,
      spaceId: space.id,
      actor: { type: actor.type, id: actor.id },
      title: decisionsParentTemplate(locale).title,
      body: decisionsParentTemplate(locale).body,
      kind: 'technical',
      slug: DECISIONS_PAGE_SLUG,
    }));

  await db
    .update(spaces)
    .set({
      settings: { ...space.settings, decisions_page_id: parent.id },
      updatedAt: new Date(),
    })
    .where(and(eq(spaces.id, space.id), eq(spaces.workspaceId, workspaceId)));
  space.policy.decisionsPageId = parent.id;
  space.settings = { ...space.settings, decisions_page_id: parent.id };

  return parent;
}

/**
 * Rewrites an existing decision page, taking and giving back a claim around the
 * write.
 *
 * It goes through the ordinary claim protocol rather than around it. A decision
 * page is a page: if somebody is editing it right now, the resolution is refused
 * with the conflict that names them, exactly as any other write would be.
 */
async function rewriteDecisionPage(
  workspaceId: string,
  page: PageRecord,
  actor: DiscussionActor,
  title: string,
  body: string,
): Promise<PageRecord> {
  const { claim } = await acquireClaim({
    workspaceId,
    pageId: page.id,
    actor: { type: actor.type, id: actor.id, label: actor.label },
  });
  try {
    return await updatePage({
      workspaceId,
      pageId: page.id,
      actor: { type: actor.type, id: actor.id },
      title,
      body,
      claimId: claim.id,
      baseContentHash: claim.baseContentHash,
    });
  } finally {
    await releaseClaim({
      workspaceId,
      claimId: claim.id,
      actor: { type: actor.type, id: actor.id, label: actor.label },
    }).catch((error: unknown) => {
      console.error('[discussions] decision page claim could not be released', error);
    });
  }
}

export interface ResolveDiscussionInput {
  workspaceId: string;
  discussionId: string;
  actor: DiscussionActor;
  /** What was decided, in the caller's words. Required. */
  decision: string;
  context?: string | null;
  options?: string | null;
  consequences?: string | null;
  /** Language of the decision page's headings. Defaults to English. */
  locale?: Locale;
}

export interface ResolveDiscussionResult {
  discussion: DiscussionRecord;
  page: PageRecord;
  /** False when an existing decision page was rewritten. */
  created: boolean;
}

/**
 * Resolves a discussion into a decision page.
 *
 * The decision text is required, and that is the whole point of the feature:
 * closing a thread without writing down what came out of it would throw away
 * the only part worth keeping. Everything the page says comes from the caller;
 * the server contributes four headings and a footer naming who took part.
 */
export async function resolveDiscussion(
  input: ResolveDiscussionInput,
): Promise<ResolveDiscussionResult> {
  const decision = normalizeDecisionField(input.decision, 'decision');
  if (decision === null) {
    throw new PageServiceError('validation', 'Resolving a discussion needs a decision');
  }
  const context = normalizeDecisionField(input.context, 'context');
  const options = normalizeDecisionField(input.options, 'options');
  const consequences = normalizeDecisionField(input.consequences, 'consequences');
  const locale = input.locale ?? 'en';

  const db = getDatabase();
  const thread = await getDiscussionThread(input.workspaceId, input.discussionId);
  if (!thread) throw new PageServiceError('not_found', 'Discussion not found');

  const space = await requireSpaceContext(input.workspaceId, thread.discussion.spaceId);
  if (space.archivedAt !== null) {
    throw new PageServiceError('conflict', 'This space is archived', { space: space.key });
  }

  const resolvedAt = new Date();
  const body = buildDecisionPageBody({
    discussionTitle: thread.discussion.title,
    decision,
    context,
    options,
    consequences,
    participants: [
      thread.discussion.openedByLabel,
      ...thread.messages.map((message) => message.authorLabel),
      input.actor.label,
    ],
    openedAt: thread.discussion.createdAt,
    resolvedAt,
    locale,
  });

  // The page is written before the thread is marked resolved. If the write
  // fails — the space is archived, somebody holds a claim on the decision page —
  // the discussion is left exactly as it was, and the caller can try again.
  const existingPage = thread.discussion.decisionPageId
    ? await getPageById(input.workspaceId, thread.discussion.decisionPageId)
    : null;

  let page: PageRecord;
  let created: boolean;
  if (existingPage && existingPage.deletedAt === null && existingPage.spaceId === space.id) {
    page = await rewriteDecisionPage(
      input.workspaceId,
      existingPage,
      input.actor,
      thread.discussion.title,
      body,
    );
    created = false;
  } else {
    const parent = await resolveDecisionsParent(space, input.workspaceId, input.actor, locale);
    page = await createPage({
      workspaceId: input.workspaceId,
      spaceId: space.id,
      actor: { type: input.actor.type, id: input.actor.id },
      title: thread.discussion.title,
      body,
      kind: 'technical',
      parentId: parent.id,
    });
    created = true;
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(discussions)
      .set({
        status: 'resolved',
        resolvedAt,
        resolvedBy: input.actor.id,
        decisionPageId: page.id,
        lastActivityAt: resolvedAt,
        expiresAt: nextExpiry('resolved', resolvedAt, space.policy),
      })
      .where(
        and(eq(discussions.id, thread.discussion.id), eq(discussions.workspaceId, input.workspaceId)),
      )
      .returning(discussionColumns);
    if (!row) throw new PageServiceError('not_found', 'Discussion not found');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'discussion.resolved',
        target: row.id,
        metadata: {
          space: space.key,
          title: row.title,
          decision_page_id: page.id,
          decision_page_path: page.path,
          message_count: thread.messages.length,
          retention_days: space.policy.retentionDays,
          deletes_at: row.expiresAt.toISOString(),
        },
      },
      tx,
    );
    return row;
  });

  return { discussion: updated, page, created };
}

/* ------------------------------------------------------------------ */
/* Deletion                                                            */
/* ------------------------------------------------------------------ */

export interface DeleteDiscussionInput {
  workspaceId: string;
  discussionId: string;
  actor: DiscussionActor;
  /**
   * True for a workspace administrator. Anyone else may only delete a thread
   * they opened themselves: a discussion is other people's conversation, and
   * removing it early is either housekeeping by an administrator or the opener
   * withdrawing their own question.
   */
  isAdmin: boolean;
}

export interface DeleteDiscussionResult {
  discussionId: string;
  title: string;
  decisionPageId: string | null;
  messagesDeleted: number;
}

export async function deleteDiscussion(
  input: DeleteDiscussionInput,
): Promise<DeleteDiscussionResult> {
  const db = getDatabase();

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(discussionColumns)
      .from(discussions)
      .where(
        and(eq(discussions.id, input.discussionId), eq(discussions.workspaceId, input.workspaceId)),
      )
      .limit(1)
      .for('update');
    if (!current) throw new PageServiceError('not_found', 'Discussion not found');

    const isOpener =
      current.openedByType === input.actor.type && current.openedById === input.actor.id;
    if (!input.isAdmin && !isOpener) {
      throw new PageServiceError(
        'forbidden',
        'Only a workspace administrator or the person who opened a discussion can delete it',
      );
    }

    const [messages] = await tx
      .select({ total: count() })
      .from(discussionMessages)
      .where(eq(discussionMessages.discussionId, current.id));
    const messagesDeleted = messages?.total ?? 0;

    // The messages go with it — the foreign key cascades — and the decision page
    // does not: nothing in this statement mentions `pages`, which is the whole
    // arrangement in one line.
    await tx.delete(discussions).where(eq(discussions.id, current.id));

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'discussion.deleted',
        target: current.id,
        metadata: {
          title: current.title,
          decision_page_id: current.decisionPageId,
          status: current.status,
          messages_deleted: messagesDeleted,
          by: input.isAdmin && !isOpener ? 'admin' : 'opener',
        },
      },
      tx,
    );

    return {
      discussionId: current.id,
      title: current.title,
      decisionPageId: current.decisionPageId,
      messagesDeleted,
    };
  });
}

/**
 * True when the sweep, rather than a person, closed this thread.
 *
 * Derived rather than stored. The alternative — writing a sentence like
 * "closed for inactivity" into the row — would store one language's wording in
 * the database and show it to everybody regardless of what they read in. The
 * state already says it: resolved, by `system`, with no decision page.
 */
export function wasClosedForInactivity(discussion: DiscussionRecord): boolean {
  return (
    discussion.status === 'resolved' &&
    discussion.resolvedBy === 'system' &&
    discussion.decisionPageId === null
  );
}
