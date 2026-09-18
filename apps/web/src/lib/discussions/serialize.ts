import { wasClosedForInactivity } from './service';
import type {
  DiscussionMessageRecord,
  DiscussionRecord,
  DiscussionSummary,
} from './service';
import type { SpaceRecord } from '../spaces/service';

/**
 * Wire shapes for discussions, in the snake_case of the rest of the API.
 *
 * `expires_at` is always present and always means "when this thread goes away
 * next": closed for inactivity while it is open, deleted once it is resolved.
 * `cleanup` says which of the two it is, so a client — an agent as much as the
 * interface — never has to infer it from the status.
 */

export interface DiscussionMessageResource {
  message_id: string;
  author: { type: 'user' | 'agent'; id: string; label: string };
  body: string;
  created_at: string;
}

export interface DiscussionResource {
  discussion_id: string;
  space: { key: string; name: string };
  title: string;
  status: 'open' | 'resolved';
  opened_by: { type: 'user' | 'agent'; id: string; label: string };
  opened_at: string;
  /** The page the discussion is about, or null. */
  page_id: string | null;
  section_id: string | null;
  message_count: number;
  participants: Array<{ type: 'user' | 'agent'; label: string }>;
  last_activity_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  decision_page_id: string | null;
  /** `closed_when_idle` while open, `deleted` once resolved. */
  cleanup: 'closed_when_idle' | 'deleted';
  expires_at: string;
  /** True when the sweep closed it because nobody wrote in it. */
  closed_for_inactivity: boolean;
}

export function toDiscussionResource(
  discussion: DiscussionSummary,
  space: Pick<SpaceRecord, 'key' | 'name'>,
): DiscussionResource {
  return {
    discussion_id: discussion.id,
    space: { key: space.key, name: space.name },
    title: discussion.title,
    status: discussion.status,
    opened_by: {
      type: discussion.openedByType,
      id: discussion.openedById,
      label: discussion.openedByLabel,
    },
    opened_at: discussion.createdAt.toISOString(),
    page_id: discussion.pageId,
    section_id: discussion.sectionId,
    message_count: discussion.messageCount,
    participants: discussion.participants.map((entry) => ({
      type: entry.type,
      label: entry.label,
    })),
    last_activity_at: discussion.lastActivityAt.toISOString(),
    resolved_at: discussion.resolvedAt?.toISOString() ?? null,
    resolved_by: discussion.resolvedBy,
    decision_page_id: discussion.decisionPageId,
    cleanup: discussion.status === 'open' ? 'closed_when_idle' : 'deleted',
    expires_at: discussion.expiresAt.toISOString(),
    closed_for_inactivity: wasClosedForInactivity(discussion),
  };
}

export function toDiscussionMessageResource(
  message: DiscussionMessageRecord,
): DiscussionMessageResource {
  return {
    message_id: message.id,
    author: { type: message.authorType, id: message.authorId, label: message.authorLabel },
    body: message.body,
    created_at: message.createdAt.toISOString(),
  };
}

/**
 * The short form a freshly opened thread answers with: enough to keep talking
 * in it, without re-listing what the caller just sent.
 */
export function toDiscussionStub(
  discussion: DiscussionRecord,
  space: Pick<SpaceRecord, 'key' | 'name'>,
): Omit<DiscussionResource, 'message_count' | 'participants'> {
  return {
    discussion_id: discussion.id,
    space: { key: space.key, name: space.name },
    title: discussion.title,
    status: discussion.status,
    opened_by: {
      type: discussion.openedByType,
      id: discussion.openedById,
      label: discussion.openedByLabel,
    },
    opened_at: discussion.createdAt.toISOString(),
    page_id: discussion.pageId,
    section_id: discussion.sectionId,
    last_activity_at: discussion.lastActivityAt.toISOString(),
    resolved_at: discussion.resolvedAt?.toISOString() ?? null,
    resolved_by: discussion.resolvedBy,
    decision_page_id: discussion.decisionPageId,
    cleanup: discussion.status === 'open' ? 'closed_when_idle' : 'deleted',
    expires_at: discussion.expiresAt.toISOString(),
    closed_for_inactivity: wasClosedForInactivity(discussion),
  };
}
