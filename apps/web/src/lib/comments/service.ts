import 'server-only';

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { pageComments, pages } from '@clewwiki/db';
import type { ActorKind } from '@clewwiki/db';
import {
  excerptOf,
  findBlockByQuote,
  resolveAnchor,
  splitParagraphs,
} from '@clewwiki/content/paragraphs';
import type { ParagraphBlock } from '@clewwiki/content/paragraphs';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import type { DbExecutor } from '../db';
import { PageServiceError } from '../pages/errors';
import { getRevision, requirePage } from '../pages/service';
import type { PageRecord } from '../pages/service';

/**
 * Comments on paragraphs: where a reviewer says what is wrong *where* it is
 * wrong, and where the agent that wrote it answers.
 *
 * Three rules.
 *
 * 1. **A comment belongs to a paragraph's text, not to its position.** The
 *    anchor is a fingerprint of the block taken from the version the commenter
 *    was reading. On every read it is looked up in the page as it is now: found,
 *    the comment is `current` and says which lines; not found, it is `outdated`
 *    and keeps the excerpt it was written about. It is never re-attached to
 *    something similar — a comment shown against text it was not written about
 *    misleads, and an outdated one merely asks to be looked at.
 * 2. **Comments stay.** Unlike a discussion, a resolved thread is a record: what
 *    was asked for, what was answered. It goes when the page goes.
 * 3. **An agent cannot clear a person's feedback.** Anybody who may write may
 *    comment and reply. A person may resolve any thread; an agent may resolve
 *    only a thread an agent opened. Otherwise "resolved" would mean "the agent
 *    says it is fine", which is the thing the comment was questioning.
 *
 * Every function takes the caller's `workspaceId` and puts it in the SQL
 * predicate.
 */

export interface CommentActor {
  type: ActorKind;
  id: string;
  label: string;
}

/** Largest comment body, in octets; the column carries the same check. */
export const MAX_COMMENT_BYTES = 8_192;

/** Most unresolved threads one page may carry. Past that the margin is noise. */
export const MAX_OPEN_THREADS_PER_PAGE = 200;

/** Most replies in one thread. A longer exchange is a discussion; open one. */
export const MAX_REPLIES_PER_THREAD = 100;

const encoder = new TextEncoder();

export interface CommentRecord {
  id: string;
  workspaceId: string;
  spaceId: string;
  pageId: string;
  parentId: string | null;
  version: number | null;
  blockFingerprint: string | null;
  blockIndex: number | null;
  quote: string | null;
  authorType: ActorKind;
  authorId: string;
  authorLabel: string;
  body: string;
  resolvedAt: Date | null;
  resolvedByType: ActorKind | null;
  resolvedById: string | null;
  resolvedByLabel: string | null;
  createdAt: Date;
}

const commentColumns = {
  id: pageComments.id,
  workspaceId: pageComments.workspaceId,
  spaceId: pageComments.spaceId,
  pageId: pageComments.pageId,
  parentId: pageComments.parentId,
  version: pageComments.version,
  blockFingerprint: pageComments.blockFingerprint,
  blockIndex: pageComments.blockIndex,
  quote: pageComments.quote,
  authorType: pageComments.authorType,
  authorId: pageComments.authorId,
  authorLabel: pageComments.authorLabel,
  body: pageComments.body,
  resolvedAt: pageComments.resolvedAt,
  resolvedByType: pageComments.resolvedByType,
  resolvedById: pageComments.resolvedById,
  resolvedByLabel: pageComments.resolvedByLabel,
  createdAt: pageComments.createdAt,
} as const;

/**
 * Where a thread points now.
 *
 * - `page` — it was written about the page as a whole.
 * - `current` — its paragraph is still there, at these lines.
 * - `outdated` — its paragraph has been rewritten or removed since.
 */
export type CommentAnchor =
  | { state: 'page' }
  | { state: 'current'; blockIndex: number; startLine: number; endLine: number; quote: string }
  | { state: 'outdated'; quote: string; version: number | null };

export interface CommentThread {
  root: CommentRecord;
  replies: CommentRecord[];
  anchor: CommentAnchor;
}

export function normalizeCommentBody(raw: string): string {
  const body = raw.trim();
  if (body === '') throw new PageServiceError('validation', 'A comment needs a body');
  const bytes = encoder.encode(body).length;
  if (bytes > MAX_COMMENT_BYTES) {
    throw new PageServiceError('validation', `A comment is at most ${MAX_COMMENT_BYTES} bytes`, {
      max_bytes: MAX_COMMENT_BYTES,
      bytes,
    });
  }
  return body;
}

export function anchorOf(root: CommentRecord, blocks: readonly ParagraphBlock[]): CommentAnchor {
  if (root.blockFingerprint === null || root.blockIndex === null) return { state: 'page' };
  const block = resolveAnchor(blocks, {
    fingerprint: root.blockFingerprint,
    index: root.blockIndex,
  });
  if (!block) return { state: 'outdated', quote: root.quote ?? '', version: root.version };
  return {
    state: 'current',
    blockIndex: block.index,
    startLine: block.startLine,
    endLine: block.endLine,
    quote: root.quote ?? '',
  };
}

function toThreads(
  rows: CommentRecord[],
  blocksOf: (pageId: string) => readonly ParagraphBlock[],
): CommentThread[] {
  const replies = new Map<string, CommentRecord[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const list = replies.get(row.parentId) ?? [];
    list.push(row);
    replies.set(row.parentId, list);
  }
  return rows
    .filter((row) => row.parentId === null)
    .map((root) => ({
      root,
      replies: replies.get(root.id) ?? [],
      anchor: anchorOf(root, blocksOf(root.pageId)),
    }));
}

export type ThreadStatusFilter = 'open' | 'resolved' | 'all';

function statusPredicate(status: ThreadStatusFilter) {
  if (status === 'open') return isNull(pageComments.resolvedAt);
  if (status === 'resolved') return isNotNull(pageComments.resolvedAt);
  return undefined;
}

/** The threads of one page, oldest first, each resolved against the page as it is now. */
export async function listPageComments(
  workspaceId: string,
  pageId: string,
  status: ThreadStatusFilter = 'open',
): Promise<{ page: PageRecord; threads: CommentThread[] }> {
  const db = getDatabase();
  const page = await requirePage(workspaceId, pageId);

  const roots = await db
    .select(commentColumns)
    .from(pageComments)
    .where(
      and(
        eq(pageComments.workspaceId, workspaceId),
        eq(pageComments.pageId, pageId),
        isNull(pageComments.parentId),
        statusPredicate(status),
      ),
    )
    .orderBy(asc(pageComments.createdAt), asc(pageComments.id));
  if (roots.length === 0) return { page, threads: [] };

  const replyRows = await db
    .select(commentColumns)
    .from(pageComments)
    .where(
      and(
        eq(pageComments.workspaceId, workspaceId),
        inArray(
          pageComments.parentId,
          roots.map((root) => root.id),
        ),
      ),
    )
    .orderBy(asc(pageComments.createdAt), asc(pageComments.id));

  const blocks = splitParagraphs(page.body);
  return { page, threads: toThreads([...roots, ...replyRows], () => blocks) };
}

/** How many unresolved threads each of these pages has. Pages with none are absent. */
export async function countOpenThreads(
  workspaceId: string,
  pageIds: string[],
  executor: DbExecutor = getDatabase(),
): Promise<Map<string, number>> {
  if (pageIds.length === 0) return new Map();
  const rows = await executor
    .select({ pageId: pageComments.pageId, value: count() })
    .from(pageComments)
    .where(
      and(
        eq(pageComments.workspaceId, workspaceId),
        inArray(pageComments.pageId, pageIds),
        isNull(pageComments.parentId),
        isNull(pageComments.resolvedAt),
      ),
    )
    .groupBy(pageComments.pageId);
  return new Map(rows.map((row) => [row.pageId, Number(row.value)]));
}

export interface SpaceThread extends CommentThread {
  page: { id: string; path: string; title: string; version: number };
}

/**
 * The unresolved threads of a space, newest first: what is waiting for somebody
 * to act on. This is the listing an agent reads before it starts work.
 */
export async function listSpaceComments(
  workspaceId: string,
  spaceId: string,
  options: { status?: ThreadStatusFilter; limit?: number } = {},
): Promise<SpaceThread[]> {
  const db = getDatabase();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const roots = await db
    .select({
      ...commentColumns,
      pagePath: pages.path,
      pageTitle: pages.title,
      pageVersion: pages.version,
      pageBody: pages.body,
    })
    .from(pageComments)
    .innerJoin(pages, eq(pages.id, pageComments.pageId))
    .where(
      and(
        eq(pageComments.workspaceId, workspaceId),
        eq(pageComments.spaceId, spaceId),
        isNull(pageComments.parentId),
        isNull(pages.deletedAt),
        statusPredicate(options.status ?? 'open'),
      ),
    )
    .orderBy(desc(pageComments.createdAt), desc(pageComments.id))
    .limit(limit);
  if (roots.length === 0) return [];

  const replyRows = await db
    .select(commentColumns)
    .from(pageComments)
    .where(
      and(
        eq(pageComments.workspaceId, workspaceId),
        inArray(
          pageComments.parentId,
          roots.map((root) => root.id),
        ),
      ),
    )
    .orderBy(asc(pageComments.createdAt), asc(pageComments.id));

  // One parse per page, however many threads it carries.
  const blocksByPage = new Map<string, ParagraphBlock[]>();
  const pageOf = new Map<string, SpaceThread['page']>();
  for (const root of roots) {
    if (!blocksByPage.has(root.pageId)) {
      blocksByPage.set(root.pageId, splitParagraphs(root.pageBody));
      pageOf.set(root.pageId, {
        id: root.pageId,
        path: root.pagePath,
        title: root.pageTitle,
        version: root.pageVersion,
      });
    }
  }

  return toThreads([...roots, ...replyRows], (pageId) => blocksByPage.get(pageId) ?? []).map(
    (thread) => ({ ...thread, page: pageOf.get(thread.root.pageId)! }),
  );
}

/** One comment by id, root or reply. */
export async function getComment(
  workspaceId: string,
  commentId: string,
  executor: DbExecutor = getDatabase(),
): Promise<CommentRecord | null> {
  const [row] = await executor
    .select(commentColumns)
    .from(pageComments)
    .where(and(eq(pageComments.id, commentId), eq(pageComments.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export interface OpenCommentInput {
  workspaceId: string;
  pageId: string;
  actor: CommentActor;
  body: string;
  /**
   * Where the comment goes. `blockIndex` counts the blocks of `version` — what a
   * reader of the rendered page clicks on. `quote` is a passage of the current
   * body — what a reader of the source has. Neither: the page as a whole.
   */
  blockIndex?: number | null;
  quote?: string | null;
  /** The version the commenter was reading. Defaults to the current one. */
  version?: number | null;
}

export async function openComment(input: OpenCommentInput): Promise<CommentThread> {
  const body = normalizeCommentBody(input.body);
  const db = getDatabase();
  const page = await requirePage(input.workspaceId, input.pageId);

  const hasIndex = input.blockIndex !== undefined && input.blockIndex !== null;
  const hasQuote = typeof input.quote === 'string' && input.quote.trim() !== '';
  if (hasIndex && hasQuote) {
    throw new PageServiceError('validation', 'Give block_index or quote, not both');
  }

  const version = input.version ?? page.version;
  let block: ParagraphBlock | null = null;
  if (hasIndex || hasQuote) {
    let source = page.body;
    if (version !== page.version) {
      const revision = await getRevision(input.workspaceId, page.id, version);
      if (!revision) throw new PageServiceError('not_found', `Version ${version} not found`);
      source = revision.body;
    }
    const blocks = splitParagraphs(source);
    if (hasIndex) {
      block = blocks[input.blockIndex!] ?? null;
      if (!block) {
        throw new PageServiceError(
          'validation',
          `Version ${version} of this page has no block ${input.blockIndex}`,
          { block_count: blocks.length },
        );
      }
    } else {
      const match = findBlockByQuote(blocks, input.quote!);
      if (!match.ok) {
        throw new PageServiceError(
          'validation',
          match.reason === 'not_found'
            ? 'The quoted text is not in this version of the page. Quote a passage exactly as it appears in the body.'
            : `The quoted text appears in ${match.candidates} paragraphs. Quote a longer passage so that it identifies one.`,
          { reason: `quote_${match.reason}`, candidates: match.candidates },
        );
      }
      block = match.block;
    }
  }

  return db.transaction(async (tx) => {
    const [open] = await tx
      .select({ value: count() })
      .from(pageComments)
      .where(
        and(
          eq(pageComments.pageId, page.id),
          isNull(pageComments.parentId),
          isNull(pageComments.resolvedAt),
        ),
      );
    if (Number(open?.value ?? 0) >= MAX_OPEN_THREADS_PER_PAGE) {
      throw new PageServiceError(
        'validation',
        `This page already has ${MAX_OPEN_THREADS_PER_PAGE} unresolved comments. Resolve some before adding more.`,
        { max_open_threads: MAX_OPEN_THREADS_PER_PAGE },
      );
    }

    const [root] = await tx
      .insert(pageComments)
      .values({
        workspaceId: input.workspaceId,
        spaceId: page.spaceId,
        pageId: page.id,
        version,
        blockFingerprint: block?.fingerprint ?? null,
        blockIndex: block?.index ?? null,
        quote: block ? excerptOf(block.text) : null,
        authorType: input.actor.type,
        authorId: input.actor.id,
        authorLabel: input.actor.label,
        body,
      })
      .returning(commentColumns);
    if (!root) throw new Error('comment insert returned no row');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'comment.opened',
        target: root.id,
        // Who commented on what, never the words: those belong to the thread.
        metadata: { result: 'opened', page_id: page.id, path: page.path, anchored: block !== null },
      },
      tx,
    );

    return { root, replies: [], anchor: anchorOf(root, splitParagraphs(page.body)) };
  });
}

async function requireRoot(
  tx: DbExecutor,
  workspaceId: string,
  threadId: string,
): Promise<CommentRecord> {
  // Locked, so a reply and a resolution of the same thread are decided in order.
  await tx.execute(
    sql`select id from page_comments where id = ${threadId}::uuid and workspace_id = ${workspaceId}::uuid for update`,
  );
  const root = await getComment(workspaceId, threadId, tx);
  if (!root) throw new PageServiceError('not_found', 'Comment not found');
  if (root.parentId !== null) {
    throw new PageServiceError('validation', 'That is a reply. Use the id of the comment it replies to.', {
      thread_id: root.parentId,
    });
  }
  return root;
}

export interface ReplyInput {
  workspaceId: string;
  threadId: string;
  actor: CommentActor;
  body: string;
}

export async function replyToComment(input: ReplyInput): Promise<CommentRecord> {
  const body = normalizeCommentBody(input.body);
  return getDatabase().transaction(async (tx) => {
    const root = await requireRoot(tx, input.workspaceId, input.threadId);
    await requirePage(input.workspaceId, root.pageId, tx);
    if (root.resolvedAt !== null) {
      throw new PageServiceError('conflict', 'This comment is resolved. Reopen it to reply.', {
        reason: 'resolved',
      });
    }
    const [replies] = await tx
      .select({ value: count() })
      .from(pageComments)
      .where(eq(pageComments.parentId, root.id));
    if (Number(replies?.value ?? 0) >= MAX_REPLIES_PER_THREAD) {
      throw new PageServiceError(
        'validation',
        `A comment takes at most ${MAX_REPLIES_PER_THREAD} replies. Open a discussion about the page instead.`,
        { max_replies: MAX_REPLIES_PER_THREAD },
      );
    }

    const [reply] = await tx
      .insert(pageComments)
      .values({
        workspaceId: input.workspaceId,
        spaceId: root.spaceId,
        pageId: root.pageId,
        parentId: root.id,
        authorType: input.actor.type,
        authorId: input.actor.id,
        authorLabel: input.actor.label,
        body,
      })
      .returning(commentColumns);
    if (!reply) throw new Error('reply insert returned no row');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'comment.replied',
        target: root.id,
        metadata: { result: 'replied', page_id: root.pageId, reply_id: reply.id },
      },
      tx,
    );
    return reply;
  });
}

export interface ResolveInput {
  workspaceId: string;
  threadId: string;
  actor: CommentActor;
  resolved: boolean;
}

/** Resolves a thread, or reopens it. Idempotent in both directions. */
export async function setCommentResolved(input: ResolveInput): Promise<CommentRecord> {
  return getDatabase().transaction(async (tx) => {
    const root = await requireRoot(tx, input.workspaceId, input.threadId);
    if (input.actor.type === 'agent' && root.authorType !== 'agent') {
      throw new PageServiceError(
        'forbidden',
        'A person opened this comment, so a person resolves it. Reply to say what you changed.',
      );
    }
    if ((root.resolvedAt !== null) === input.resolved) return root;

    const [updated] = await tx
      .update(pageComments)
      .set(
        input.resolved
          ? {
              resolvedAt: new Date(),
              resolvedByType: input.actor.type,
              resolvedById: input.actor.id,
              resolvedByLabel: input.actor.label,
            }
          : { resolvedAt: null, resolvedByType: null, resolvedById: null, resolvedByLabel: null },
      )
      .where(eq(pageComments.id, root.id))
      .returning(commentColumns);
    if (!updated) throw new PageServiceError('not_found', 'Comment not found');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: input.resolved ? 'comment.resolved' : 'comment.reopened',
        target: root.id,
        metadata: { result: input.resolved ? 'resolved' : 'reopened', page_id: root.pageId },
      },
      tx,
    );
    return updated;
  });
}

export interface DeleteCommentInput {
  workspaceId: string;
  commentId: string;
  actor: CommentActor;
  /** True for a workspace administrator, who may remove anybody's comment. */
  isAdmin: boolean;
}

/** Removes a comment; removing the one that opens a thread removes its replies. */
export async function deleteComment(input: DeleteCommentInput): Promise<{ deleted: number }> {
  return getDatabase().transaction(async (tx) => {
    const comment = await getComment(input.workspaceId, input.commentId, tx);
    if (!comment) throw new PageServiceError('not_found', 'Comment not found');
    const own = comment.authorType === input.actor.type && comment.authorId === input.actor.id;
    if (!own && !input.isAdmin) {
      throw new PageServiceError(
        'forbidden',
        'Only its author or a workspace administrator can delete a comment',
      );
    }

    const removed = await tx
      .delete(pageComments)
      .where(
        and(
          eq(pageComments.workspaceId, input.workspaceId),
          sql`(${pageComments.id} = ${comment.id}::uuid or ${pageComments.parentId} = ${comment.id}::uuid)`,
        ),
      )
      .returning({ id: pageComments.id });

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'comment.deleted',
        target: comment.id,
        metadata: {
          result: 'deleted',
          page_id: comment.pageId,
          author_type: comment.authorType,
          author_id: comment.authorId,
          removed: removed.length,
        },
      },
      tx,
    );
    return { deleted: removed.length };
  });
}
