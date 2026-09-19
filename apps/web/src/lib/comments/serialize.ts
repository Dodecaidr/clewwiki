import type { CommentAnchor, CommentRecord, CommentThread, SpaceThread } from './service';

/**
 * Wire shapes for comments, in the snake_case of the rest of the API.
 *
 * `anchor.state` always says where a thread points *now* — `page`, `current`
 * with the lines of its paragraph, or `outdated` — so a client never has to
 * work it out from a fingerprint it has no way to compute.
 */

export interface CommentResource {
  comment_id: string;
  author: { type: 'user' | 'agent'; id: string; label: string };
  body: string;
  created_at: string;
  /** On the answer to a write: who the text reached. A name that matched nobody is not here. */
  mentioned?: Array<{ type: 'user' | 'agent'; label: string }>;
}

export function toCommentResource(comment: CommentRecord): CommentResource {
  return {
    comment_id: comment.id,
    author: { type: comment.authorType, id: comment.authorId, label: comment.authorLabel },
    body: comment.body,
    created_at: comment.createdAt.toISOString(),
    ...(comment.mentioned
      ? { mentioned: comment.mentioned.map(({ type, label }) => ({ type, label })) }
      : {}),
  };
}

function toAnchorResource(anchor: CommentAnchor) {
  if (anchor.state === 'page') return { state: 'page' as const };
  if (anchor.state === 'outdated') {
    return { state: 'outdated' as const, quote: anchor.quote, written_on_version: anchor.version };
  }
  return {
    state: 'current' as const,
    block_index: anchor.blockIndex,
    line_start: anchor.startLine,
    line_end: anchor.endLine,
    quote: anchor.quote,
  };
}

export function toThreadResource(thread: CommentThread) {
  const { root } = thread;
  return {
    thread_id: root.id,
    page_id: root.pageId,
    status: root.resolvedAt ? ('resolved' as const) : ('open' as const),
    anchor: toAnchorResource(thread.anchor),
    written_on_version: root.version,
    ...toCommentResource(root),
    resolved_at: root.resolvedAt?.toISOString() ?? null,
    resolved_by:
      root.resolvedByType && root.resolvedById
        ? { type: root.resolvedByType, id: root.resolvedById, label: root.resolvedByLabel ?? '' }
        : null,
    replies: thread.replies.map(toCommentResource),
  };
}

export function toSpaceThreadResource(thread: SpaceThread) {
  return {
    ...toThreadResource(thread),
    page: {
      page_id: thread.page.id,
      path: thread.page.path,
      title: thread.page.title,
      current_version: thread.page.version,
    },
  };
}
