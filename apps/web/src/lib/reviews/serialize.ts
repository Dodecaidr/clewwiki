import type { TextDiff } from '@clewwiki/content/diff';

import type {
  ActorRef,
  ChangeEntry,
  PageReviewRecord,
  PageReviewState,
  PendingPage,
  RevisionReviewStatus,
  RevisionSummary,
  VersionDiff,
} from './service';
import type { RevisionRecord } from '../pages/service';

/**
 * Wire shapes for the change feed, diffs and reviews, in the snake_case of the
 * rest of the API.
 *
 * A diff is returned as data — hunks of numbered lines — and never as markup:
 * the lines are page content, and whoever shows them escapes them.
 */

export interface ActorResource {
  type: 'user' | 'agent';
  id: string;
  label: string;
}

function toActor(actor: ActorRef): ActorResource {
  return { type: actor.type, id: actor.id, label: actor.label };
}

export interface ReviewResource {
  review_id: string;
  decision: 'accepted' | 'reverted';
  /** The baseline the reviewer compared against; exclusive, 0 for none. */
  from_version: number;
  to_version: number;
  /** The version a revert wrote; null for an acceptance. */
  result_version: number | null;
  reviewer: { id: string; label: string };
  note: string | null;
  created_at: string;
}

export function toReviewResource(review: PageReviewRecord): ReviewResource {
  return {
    review_id: review.id,
    decision: review.decision,
    from_version: review.fromVersion,
    to_version: review.toVersion,
    result_version: review.resultVersion,
    reviewer: { id: review.reviewerId, label: review.reviewerLabel },
    note: review.note,
    created_at: review.createdAt.toISOString(),
  };
}

export interface RevisionResource {
  version: number;
  title: string;
  summary: string | null;
  content_hash: string;
  author: ActorResource;
  created_at: string;
  review_status: RevisionReviewStatus;
}

function toRevisionResource(revision: RevisionSummary): RevisionResource {
  return {
    version: revision.version,
    title: revision.title,
    summary: revision.summary,
    content_hash: revision.contentHash,
    author: toActor(revision.author),
    created_at: revision.createdAt.toISOString(),
    review_status: revision.status,
  };
}

export function toPageReviewResource(state: PageReviewState) {
  return {
    page_id: state.page.id,
    path: state.page.path,
    title: state.page.title,
    current_version: state.page.version,
    baseline_version: state.baselineVersion,
    pending: state.pending,
    pending_revisions: state.pendingRevisions.map(toRevisionResource),
    reviews: state.reviews.map(toReviewResource),
  };
}

export function toPendingPageResource(entry: PendingPage) {
  return {
    page_id: entry.page.id,
    path: entry.page.path,
    title: entry.page.title,
    current_version: entry.page.version,
    baseline_version: entry.baselineVersion,
    created_by_agent: entry.created,
    revision_count: entry.revisionCount,
    authors: entry.authors.map(toActor),
    lines_added: entry.stats?.added ?? null,
    lines_removed: entry.stats?.removed ?? null,
    updated_at: entry.page.updatedAt.toISOString(),
  };
}

export function toChangeResource(entry: ChangeEntry) {
  return {
    page_id: entry.page.id,
    path: entry.page.path,
    page_title: entry.page.title,
    current_version: entry.page.version,
    version: entry.version,
    title: entry.title,
    summary: entry.summary,
    content_hash: entry.contentHash,
    author: toActor(entry.author),
    created_at: entry.createdAt.toISOString(),
    review_status: entry.status,
  };
}

export function toRevisionBodyResource(revision: RevisionRecord) {
  return {
    page_id: revision.pageId,
    version: revision.version,
    title: revision.title,
    summary: revision.summary,
    body: revision.body,
    content_hash: revision.contentHash,
    author: { type: revision.authorType, id: revision.authorId },
    created_at: revision.createdAt.toISOString(),
  };
}

export function toDiffResource(diff: TextDiff) {
  return {
    identical: diff.identical,
    only_line_endings: diff.onlyLineEndings,
    coarse: diff.coarse,
    lines_added: diff.stats.added,
    lines_removed: diff.stats.removed,
    hunks: diff.hunks.map((hunk) => ({
      old_start: hunk.oldStart,
      old_lines: hunk.oldLines,
      new_start: hunk.newStart,
      new_lines: hunk.newLines,
      lines: hunk.lines.map((line) => ({
        kind: line.kind,
        text: line.text,
        old_number: line.oldNumber,
        new_number: line.newNumber,
        ...(line.segments ? { segments: line.segments } : {}),
      })),
    })),
  };
}

export function toVersionDiffResource(result: VersionDiff) {
  return {
    page_id: result.pageId,
    from: result.from
      ? { version: result.from.version, title: result.from.title, content_hash: result.from.contentHash }
      : null,
    to: { version: result.to.version, title: result.to.title, content_hash: result.to.contentHash },
    title_changed: result.titleChanged,
    summary_changed: result.summaryChanged,
    ...toDiffResource(result.diff),
  };
}
