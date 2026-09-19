import { spaceDiscussionHref, spacePageHref } from '../spaces/urls';
import type { Inbox, InboxItem } from './service';

/**
 * The inbox over REST, in the snake_case of the rest of the API. `url` is a
 * path on this instance — where a person would click, and what an agent can
 * hand to a person — and the ids beside it are what the other endpoints take.
 */
export function inboxItemHref(item: InboxItem): string {
  if (item.discussionId !== null && item.kind !== 'discussion.resolved') {
    return spaceDiscussionHref(item.space.key, item.discussionId);
  }
  if (item.kind === 'discussion.resolved') {
    return item.pageId !== null
      ? spacePageHref(item.space.key, item.pageId)
      : spaceDiscussionHref(item.space.key, item.discussionId ?? item.id);
  }
  const page = spacePageHref(item.space.key, item.pageId ?? '');
  // A comment lands on its thread, which the page's comments panel anchors.
  return item.threadId === null ? page : `${page}#thread-${item.threadId}`;
}

export function toInboxItemResource(item: InboxItem): Record<string, unknown> {
  return {
    kind: item.kind,
    id: item.id,
    at: item.at.toISOString(),
    unread: item.unread,
    space: item.space.key,
    by: item.by,
    title: item.title,
    excerpt: item.excerpt,
    discussion_id: item.discussionId,
    page_id: item.pageId,
    thread_id: item.threadId,
    decision: item.decision,
    url: inboxItemHref(item),
  };
}

export function toInboxResource(inbox: Inbox): Record<string, unknown> {
  return {
    unread: inbox.unread,
    seen_at: inbox.seenAt.toISOString(),
    items: inbox.items.map(toInboxItemResource),
  };
}
