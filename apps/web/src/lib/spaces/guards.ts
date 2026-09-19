import 'server-only';

import { getAnchorById } from '../anchors/service';
import type { AnchorRecord } from '../anchors/service';
import { getClaimById } from '../claims/service';
import { getComment } from '../comments/service';
import { getDiscussionById, getDiscussionThread } from '../discussions/service';
import type { DiscussionRecord, DiscussionThread } from '../discussions/service';
import { canView, findPage } from './visibility';
import type { Viewer } from './visibility';

/**
 * "May this person see the thing this id names?" — for server actions.
 *
 * A REST handler looks the resource up and checks its space against the caller
 * because it has to serialise the resource anyway. A server action is often
 * handed an id and passes it straight to a service, which scopes by workspace
 * and knows nothing of who is asking. These are the checks that stand between
 * the two: each resolves an id to the space it lives in and answers whether the
 * viewer can see that space. False covers "no such thing" as well, so an action
 * reports a hidden page exactly as it reports a missing one.
 *
 * `tests/space-visibility-guard.test.ts` lists the actions and fails when one
 * of them takes an id without going through here or through `findPage`.
 */

export async function canViewPage(viewer: Viewer, pageId: string): Promise<boolean> {
  return (await findPage(viewer, pageId)) !== null;
}

export async function canViewClaim(viewer: Viewer, claimId: string): Promise<boolean> {
  const claim = await getClaimById(viewer.workspaceId, claimId);
  return claim !== null && canViewPage(viewer, claim.pageId);
}

export async function canViewAnchor(viewer: Viewer, anchorId: string): Promise<boolean> {
  const anchor = await getAnchorById(viewer.workspaceId, anchorId);
  return anchor !== null && canViewPage(viewer, anchor.pageId);
}

export async function canViewComment(viewer: Viewer, commentId: string): Promise<boolean> {
  const comment = await getComment(viewer.workspaceId, commentId);
  return comment !== null && canView(viewer, comment.spaceId);
}

export async function canViewDiscussion(viewer: Viewer, discussionId: string): Promise<boolean> {
  const discussion = await getDiscussionById(viewer.workspaceId, discussionId);
  return discussion !== null && canView(viewer, discussion.spaceId);
}

/**
 * The loaders for pages and actions that need the record and not only the
 * answer. Metadata counts: a page title is sent to the browser even when the
 * page itself goes on to answer "not found", so whatever a `generateMetadata`
 * reads has to be read through here as well.
 */
export async function findDiscussion(viewer: Viewer, discussionId: string): Promise<DiscussionRecord | null> {
  const discussion = await getDiscussionById(viewer.workspaceId, discussionId);
  return discussion && canView(viewer, discussion.spaceId) ? discussion : null;
}

export async function findDiscussionThread(
  viewer: Viewer,
  discussionId: string,
): Promise<DiscussionThread | null> {
  if ((await findDiscussion(viewer, discussionId)) === null) return null;
  return getDiscussionThread(viewer.workspaceId, discussionId);
}

export async function findAnchor(viewer: Viewer, anchorId: string): Promise<AnchorRecord | null> {
  const anchor = await getAnchorById(viewer.workspaceId, anchorId);
  return anchor && (await canViewPage(viewer, anchor.pageId)) ? anchor : null;
}
