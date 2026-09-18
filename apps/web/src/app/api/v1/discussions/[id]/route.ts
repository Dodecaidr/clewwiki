import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { deleteDiscussion, getDiscussionById, getDiscussionThread } from '@/lib/discussions/service';
import { toDiscussionMessageResource, toDiscussionResource } from '@/lib/discussions/serialize';
import { authorizePagesRequest, isWorkspaceAdmin, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const paramsSchema = z.object({ id: z.uuid() });

/**
 * One discussion with its messages, oldest first. `pages:read`.
 *
 * The bodies are text other people and other agents wrote. Everything that
 * hands them onward — the MCP tools, the interface — says so; nothing in this
 * handler reads them.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Discussion not found');

  try {
    const thread = await getDiscussionThread(auth.workspaceId, parsedParams.data.id);
    if (!thread) return apiError(404, 'not_found', 'Discussion not found');

    const mismatch = requireWorkspace(auth.identity, thread.discussion.workspaceId);
    if (mismatch) return mismatch;
    const outOfReach = requireSpace(auth.identity, thread.discussion.spaceId);
    if (outOfReach) return outOfReach;

    const space = await getSpaceById(auth.workspaceId, thread.discussion.spaceId);
    if (!space) return apiError(404, 'not_found', 'Discussion not found');

    return apiJson(
      {
        ...toDiscussionResource(thread.discussion, space),
        messages: thread.messages.map(toDiscussionMessageResource),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Removes a discussion and its messages before its retention window runs out.
 *
 * A workspace administrator, or whoever opened it. Not every writer: a thread
 * is other people's conversation, and the two cases where removing it early is
 * legitimate are housekeeping and the opener withdrawing their own question.
 * The decision page a resolution produced is untouched — it is an ordinary page
 * and is deleted, if ever, the way pages are.
 *
 * `pages:write`; the audit row records the title and the decision page, because
 * the row it describes no longer exists to be looked up.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Discussion not found');

  try {
    const existing = await getDiscussionById(auth.workspaceId, parsedParams.data.id);
    if (!existing) return apiError(404, 'not_found', 'Discussion not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    const outOfReach = requireSpace(auth.identity, existing.spaceId);
    if (outOfReach) return outOfReach;

    const result = await deleteDiscussion({
      workspaceId: auth.workspaceId,
      discussionId: existing.id,
      actor: { ...auth.actor, label: auth.identity.name },
      isAdmin: isWorkspaceAdmin(auth.identity),
    });

    return apiJson(
      {
        discussion_id: result.discussionId,
        deleted: true,
        title: result.title,
        messages_deleted: result.messagesDeleted,
        // Named in the answer as well as in the log: the caller should see that
        // the decision survived what it just deleted.
        decision_page_id: result.decisionPageId,
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
