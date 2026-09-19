import 'server-only';

import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  discussionMessages,
  discussions,
  inboxMarks,
  mentions,
  pageComments,
  pageReviews,
  pages,
  spaces,
} from '@clewwiki/db';

import { getDatabase } from '../db';

/**
 * The inbox: what happened, since you last looked, to things you had a hand in.
 *
 * It answers one question for a person and for an agent alike — *did anybody
 * answer me?* — and it answers it by reading, not by having been told. Nothing
 * is written when a message is posted or a page is reviewed; the inbox is a
 * query over the tables those things already live in:
 *
 * - a message or a comment that addresses you by name (`@[Name]`), wherever it is;
 * - a message in a discussion you opened or spoke in;
 * - a discussion you took part in being resolved;
 * - a reply in a comment thread you started or replied in;
 * - a comment on a page as you left it — on the version you wrote;
 * - a review, accepting or reverting, of changes that include yours.
 *
 * Always by somebody else: nobody is notified of their own words.
 *
 * Being a query is what keeps it honest. A discussion that expired is not in
 * the inbox, because it is not in the database. A space you can no longer see
 * contributes nothing, because `spaceIds` — the same allowlist every other read
 * is held to — is applied when the inbox is read, not when the event happened.
 * A page that was deleted takes its comments and reviews out with it.
 *
 * A mention is the one item that is stored rather than derived, because who a
 * name meant can only be decided when it is written. It is still held to the
 * same rules: the row dies with the message or comment it was written in, and
 * the reader's visibility is applied here, when it is read.
 *
 * The other thing stored is how far each actor has read (`inbox_marks`): a single
 * timestamp, because "mark everything up to here as read" is the operation both
 * a person clicking a button and an agent finishing a turn actually perform.
 */

export type InboxActor = { type: 'user' | 'agent'; id: string };

export const INBOX_KINDS = [
  'mention',
  'discussion.message',
  'discussion.resolved',
  'comment.reply',
  'comment.new',
  'review.decided',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxItem {
  kind: InboxKind;
  /** The row this item is about: a message, a discussion, a comment or a review. */
  id: string;
  at: Date;
  unread: boolean;
  space: { id: string; key: string };
  /** Who did it. Null when the system closed a discussion for inactivity. */
  by: { type: 'user' | 'agent'; label: string } | null;
  /** The discussion's title or the page's. */
  title: string;
  /** The opening of what was said, when something was. */
  excerpt: string | null;
  discussionId: string | null;
  pageId: string | null;
  /** For a comment: the thread it belongs to. */
  threadId: string | null;
  /** For a review: what was decided. */
  decision: string | null;
}

/** Nothing older than this is listed. */
export const INBOX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** An actor who has never read their inbox is not told about anything older than this. */
export const INBOX_FIRST_READ_MS = 14 * 24 * 60 * 60 * 1000;
export const INBOX_MAX_LIMIT = 100;
const EXCERPT_LENGTH = 240;

export interface InboxQuery {
  workspaceId: string;
  actor: InboxActor;
  /** The spaces the caller can see; null for all of them. */
  spaceIds: readonly string[] | null;
  limit?: number;
  unreadOnly?: boolean;
  now?: Date;
}

export interface Inbox {
  items: InboxItem[];
  /** Unread among the items returned — capped by `limit`, like the list. */
  unread: number;
  /** Everything after this is unread. */
  seenAt: Date;
}

export async function getSeenAt(workspaceId: string, actor: InboxActor, now: Date = new Date()): Promise<Date> {
  const [mark] = await getDatabase()
    .select({ seenAt: inboxMarks.seenAt })
    .from(inboxMarks)
    .where(
      and(
        eq(inboxMarks.workspaceId, workspaceId),
        eq(inboxMarks.actorType, actor.type),
        eq(inboxMarks.actorId, actor.id),
      ),
    )
    .limit(1);
  return mark?.seenAt ?? new Date(now.getTime() - INBOX_FIRST_READ_MS);
}

/**
 * Moves the mark forward to `upTo` — never back, and never past now, so that
 * something which arrives while the caller is reading stays unread.
 */
export async function markInboxRead(
  workspaceId: string,
  actor: InboxActor,
  upTo: Date = new Date(),
  now: Date = new Date(),
): Promise<Date> {
  const seenAt = upTo.getTime() > now.getTime() ? now : upTo;
  const [row] = await getDatabase()
    .insert(inboxMarks)
    .values({ workspaceId, actorType: actor.type, actorId: actor.id, seenAt })
    .onConflictDoUpdate({
      target: [inboxMarks.workspaceId, inboxMarks.actorType, inboxMarks.actorId],
      set: { seenAt: sql`greatest(${inboxMarks.seenAt}, excluded.seen_at)` },
    })
    .returning({ seenAt: inboxMarks.seenAt });
  return row?.seenAt ?? seenAt;
}

export async function getInbox(query: InboxQuery): Promise<Inbox> {
  const now = query.now ?? new Date();
  const limit = Math.min(Math.max(query.limit ?? 30, 1), INBOX_MAX_LIMIT);
  const seenAt = await getSeenAt(query.workspaceId, query.actor, now);
  if (query.spaceIds !== null && query.spaceIds.length === 0) return { items: [], unread: 0, seenAt };

  const windowStart = new Date(now.getTime() - INBOX_WINDOW_MS);
  const since = query.unreadOnly === true && seenAt > windowStart ? seenAt : windowStart;
  const scope: Scope = { ...query, since, limit, now };

  const found = await Promise.all([
    messageMentionItems(scope),
    commentMentionItems(scope),
    discussionMessageItems(scope),
    discussionResolvedItems(scope),
    commentItems(scope),
    reviewItems(scope),
  ]);

  // Being addressed in a thread you are already in is one event, not two, and
  // "you were mentioned" is the more useful way to say it.
  const mentioned = new Set(found.flat().filter((item) => item.kind === 'mention').map((item) => item.id));
  const items = found
    .flat()
    .filter((item) => item.kind === 'mention' || !mentioned.has(item.id))
    .sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((item) => ({ ...item, unread: item.at.getTime() > seenAt.getTime() }));

  return { items, unread: items.filter((item) => item.unread).length, seenAt };
}

/** How many unread items there are, up to `cap` — what a badge needs and no more. */
export async function countUnread(query: Omit<InboxQuery, 'limit' | 'unreadOnly'>, cap = 99): Promise<number> {
  const inbox = await getInbox({ ...query, unreadOnly: true, limit: Math.min(cap + 1, INBOX_MAX_LIMIT) });
  return inbox.unread;
}

/* ------------------------------------------------------------------ */
/* The readings                                                        */
/* ------------------------------------------------------------------ */

interface Scope extends InboxQuery {
  since: Date;
  limit: number;
  now: Date;
}

type Draft = Omit<InboxItem, 'unread'>;

function inSpaces(column: typeof spaces.id | typeof discussions.spaceId, scope: Scope): SQL | undefined {
  return scope.spaceIds === null ? undefined : inArray(column, [...scope.spaceIds]);
}

function excerptOf(text: string | null): string | null {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`;
}

/** True for a discussion the actor opened or spoke in before `before`. */
function tookPartInDiscussion(scope: Scope, before: SQL): SQL {
  const { actor } = scope;
  return sql`(
    (${discussions.openedByType} = ${actor.type} and ${discussions.openedById} = ${actor.id})
    or exists (
      select 1 from discussion_messages mine
      where mine.discussion_id = ${discussions.id}
        and mine.author_type = ${actor.type}
        and mine.author_id = ${actor.id}
        and mine.created_at < ${before}
    )
  )`;
}

async function messageMentionItems(scope: Scope): Promise<Draft[]> {
  const { actor } = scope;
  const rows = await getDatabase()
    .select({
      id: discussionMessages.id,
      at: discussionMessages.createdAt,
      authorType: discussionMessages.authorType,
      authorLabel: discussionMessages.authorLabel,
      body: discussionMessages.body,
      discussionId: discussions.id,
      title: discussions.title,
      spaceId: spaces.id,
      spaceKey: spaces.key,
    })
    .from(mentions)
    .innerJoin(discussionMessages, eq(discussionMessages.id, mentions.messageId))
    .innerJoin(discussions, eq(discussions.id, discussionMessages.discussionId))
    .innerJoin(spaces, eq(spaces.id, discussions.spaceId))
    .where(
      and(
        eq(mentions.workspaceId, scope.workspaceId),
        eq(mentions.actorType, actor.type),
        eq(mentions.actorId, actor.id),
        gt(mentions.createdAt, scope.since),
        gt(discussions.expiresAt, scope.now),
        inSpaces(discussions.spaceId, scope),
      ),
    )
    .orderBy(desc(mentions.createdAt))
    .limit(scope.limit);

  return rows.map((row) => ({
    kind: 'mention',
    id: row.id,
    at: row.at,
    space: { id: row.spaceId, key: row.spaceKey },
    by: { type: row.authorType, label: row.authorLabel },
    title: row.title,
    excerpt: excerptOf(row.body),
    discussionId: row.discussionId,
    pageId: null,
    threadId: null,
    decision: null,
  }));
}

async function commentMentionItems(scope: Scope): Promise<Draft[]> {
  const { actor } = scope;
  const rows = await getDatabase()
    .select({
      id: pageComments.id,
      at: pageComments.createdAt,
      parentId: pageComments.parentId,
      authorType: pageComments.authorType,
      authorLabel: pageComments.authorLabel,
      body: pageComments.body,
      pageId: pages.id,
      title: pages.title,
      spaceId: spaces.id,
      spaceKey: spaces.key,
    })
    .from(mentions)
    .innerJoin(pageComments, eq(pageComments.id, mentions.commentId))
    .innerJoin(pages, eq(pages.id, pageComments.pageId))
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .where(
      and(
        eq(mentions.workspaceId, scope.workspaceId),
        eq(mentions.actorType, actor.type),
        eq(mentions.actorId, actor.id),
        gt(mentions.createdAt, scope.since),
        isNull(pages.deletedAt),
        inSpaces(spaces.id, scope),
      ),
    )
    .orderBy(desc(mentions.createdAt))
    .limit(scope.limit);

  return rows.map((row) => ({
    kind: 'mention',
    id: row.id,
    at: row.at,
    space: { id: row.spaceId, key: row.spaceKey },
    by: { type: row.authorType, label: row.authorLabel },
    title: row.title,
    excerpt: excerptOf(row.body),
    discussionId: null,
    pageId: row.pageId,
    threadId: row.parentId ?? row.id,
    decision: null,
  }));
}

async function discussionMessageItems(scope: Scope): Promise<Draft[]> {
  const { actor } = scope;
  const rows = await getDatabase()
    .select({
      id: discussionMessages.id,
      at: discussionMessages.createdAt,
      authorType: discussionMessages.authorType,
      authorLabel: discussionMessages.authorLabel,
      body: discussionMessages.body,
      discussionId: discussions.id,
      title: discussions.title,
      spaceId: spaces.id,
      spaceKey: spaces.key,
    })
    .from(discussionMessages)
    .innerJoin(discussions, eq(discussions.id, discussionMessages.discussionId))
    .innerJoin(spaces, eq(spaces.id, discussions.spaceId))
    .where(
      and(
        eq(discussionMessages.workspaceId, scope.workspaceId),
        gt(discussionMessages.createdAt, scope.since),
        gt(discussions.expiresAt, scope.now),
        inSpaces(discussions.spaceId, scope),
        or(ne(discussionMessages.authorType, actor.type), ne(discussionMessages.authorId, actor.id)),
        tookPartInDiscussion(scope, sql`${discussionMessages.createdAt}`),
      ),
    )
    .orderBy(desc(discussionMessages.createdAt))
    .limit(scope.limit);

  return rows.map((row) => ({
    kind: 'discussion.message',
    id: row.id,
    at: row.at,
    space: { id: row.spaceId, key: row.spaceKey },
    by: { type: row.authorType, label: row.authorLabel },
    title: row.title,
    excerpt: excerptOf(row.body),
    discussionId: row.discussionId,
    pageId: null,
    threadId: null,
    decision: null,
  }));
}

async function discussionResolvedItems(scope: Scope): Promise<Draft[]> {
  const rows = await getDatabase()
    .select({
      id: discussions.id,
      at: discussions.resolvedAt,
      title: discussions.title,
      resolvedBy: discussions.resolvedBy,
      decisionPageId: discussions.decisionPageId,
      spaceId: spaces.id,
      spaceKey: spaces.key,
    })
    .from(discussions)
    .innerJoin(spaces, eq(spaces.id, discussions.spaceId))
    .where(
      and(
        eq(discussions.workspaceId, scope.workspaceId),
        isNotNull(discussions.resolvedAt),
        gt(discussions.resolvedAt, scope.since),
        gt(discussions.expiresAt, scope.now),
        inSpaces(discussions.spaceId, scope),
        // `resolved_by` holds an actor's id, or 'system' for the inactivity sweep.
        ne(discussions.resolvedBy, scope.actor.id),
        tookPartInDiscussion(scope, sql`${discussions.resolvedAt}`),
      ),
    )
    .orderBy(desc(discussions.resolvedAt))
    .limit(scope.limit);

  return rows.map((row) => ({
    kind: 'discussion.resolved',
    id: row.id,
    at: row.at ?? scope.now,
    space: { id: row.spaceId, key: row.spaceKey },
    by: null,
    title: row.title,
    excerpt: null,
    discussionId: row.id,
    pageId: row.decisionPageId,
    threadId: null,
    decision: row.resolvedBy === 'system' ? 'inactive' : row.decisionPageId === null ? 'resolved' : 'decided',
  }));
}

/**
 * Replies in threads the actor is in, and new threads on a page as the actor
 * left it. One reading, because both are rows of `page_comments`.
 */
async function commentItems(scope: Scope): Promise<Draft[]> {
  const { actor } = scope;
  const root = alias(pageComments, 'root');

  const inMyThread = sql`(
    (${root.authorType} = ${actor.type} and ${root.authorId} = ${actor.id})
    or exists (
      select 1 from page_comments mine
      where mine.parent_id = ${pageComments.parentId}
        and mine.author_type = ${actor.type}
        and mine.author_id = ${actor.id}
        and mine.created_at < ${pageComments.createdAt}
    )
  )`;
  const onMyVersion = sql`exists (
    select 1 from page_revisions mine
    where mine.page_id = ${pageComments.pageId}
      and mine.version = ${pageComments.version}
      and mine.author_type = ${actor.type}
      and mine.author_id = ${actor.id}
  )`;

  const rows = await getDatabase()
    .select({
      id: pageComments.id,
      at: pageComments.createdAt,
      parentId: pageComments.parentId,
      authorType: pageComments.authorType,
      authorLabel: pageComments.authorLabel,
      body: pageComments.body,
      pageId: pages.id,
      title: pages.title,
      spaceId: spaces.id,
      spaceKey: spaces.key,
    })
    .from(pageComments)
    .innerJoin(pages, eq(pages.id, pageComments.pageId))
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .leftJoin(root, eq(root.id, pageComments.parentId))
    .where(
      and(
        eq(pageComments.workspaceId, scope.workspaceId),
        gt(pageComments.createdAt, scope.since),
        isNull(pages.deletedAt),
        inSpaces(spaces.id, scope),
        or(ne(pageComments.authorType, actor.type), ne(pageComments.authorId, actor.id)),
        or(
          and(isNotNull(pageComments.parentId), inMyThread),
          and(isNull(pageComments.parentId), onMyVersion),
        ),
      ),
    )
    .orderBy(desc(pageComments.createdAt))
    .limit(scope.limit);

  return rows.map((row) => ({
    kind: row.parentId === null ? 'comment.new' : 'comment.reply',
    id: row.id,
    at: row.at,
    space: { id: row.spaceId, key: row.spaceKey },
    by: { type: row.authorType, label: row.authorLabel },
    title: row.title,
    excerpt: excerptOf(row.body),
    discussionId: null,
    pageId: row.pageId,
    threadId: row.parentId ?? row.id,
    decision: null,
  }));
}

async function reviewItems(scope: Scope): Promise<Draft[]> {
  const { actor } = scope;
  const reviewedMine = sql`exists (
    select 1 from page_revisions mine
    where mine.page_id = ${pageReviews.pageId}
      and mine.version > ${pageReviews.fromVersion}
      and mine.version <= ${pageReviews.toVersion}
      and mine.author_type = ${actor.type}
      and mine.author_id = ${actor.id}
  )`;

  const rows = await getDatabase()
    .select({
      id: pageReviews.id,
      at: pageReviews.createdAt,
      decision: pageReviews.decision,
      reviewerLabel: pageReviews.reviewerLabel,
      note: pageReviews.note,
      pageId: pages.id,
      title: pages.title,
      spaceId: spaces.id,
      spaceKey: spaces.key,
    })
    .from(pageReviews)
    .innerJoin(pages, eq(pages.id, pageReviews.pageId))
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .where(
      and(
        eq(pageReviews.workspaceId, scope.workspaceId),
        gt(pageReviews.createdAt, scope.since),
        isNull(pages.deletedAt),
        inSpaces(spaces.id, scope),
        // Reviews are made by people; a person is not told of their own.
        actor.type === 'user' ? ne(pageReviews.reviewerId, actor.id) : undefined,
        reviewedMine,
      ),
    )
    .orderBy(desc(pageReviews.createdAt))
    .limit(scope.limit);

  return rows.map((row) => ({
    kind: 'review.decided',
    id: row.id,
    at: row.at,
    space: { id: row.spaceId, key: row.spaceKey },
    by: { type: 'user', label: row.reviewerLabel },
    title: row.title,
    excerpt: excerptOf(row.note),
    discussionId: null,
    pageId: row.pageId,
    threadId: null,
    decision: row.decision,
  }));
}
