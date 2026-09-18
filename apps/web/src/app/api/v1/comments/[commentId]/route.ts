import { z } from 'zod';

import {
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { toCommentResource } from '@/lib/comments/serialize';
import { deleteComment, getComment, setCommentResolved } from '@/lib/comments/service';
import { authorizePagesRequest, isWorkspaceAdmin, WRITE_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ commentId: string }> };

const paramsSchema = z.object({ commentId: z.uuid() });
const patchBodySchema = z.object({ resolved: z.boolean() }).strict();

/**
 * Resolves a thread or reopens it. A person may resolve any thread; an agent
 * only one an agent opened — `forbidden` otherwise, with the instruction to
 * reply instead. "Resolved" has to mean a person is satisfied, or an agent's own
 * question was answered; it cannot mean the agent under review says so.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Comment not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = patchBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const existing = await getComment(auth.workspaceId, parsedParams.data.commentId);
    if (!existing) return apiError(404, 'not_found', 'Comment not found');
    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, existing.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Comment not found');

    const updated = await setCommentResolved({
      workspaceId: auth.workspaceId,
      threadId: existing.id,
      actor: { ...auth.actor, label: auth.identity.name },
      resolved: parsed.data.resolved,
    });
    return apiJson(
      {
        thread_id: updated.id,
        page_id: updated.pageId,
        status: updated.resolvedAt ? 'resolved' : 'open',
        resolved_at: updated.resolvedAt?.toISOString() ?? null,
        ...toCommentResource(updated),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/** Deletes a comment: its author, or a workspace administrator. A thread goes with its replies. */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Comment not found');

  try {
    const existing = await getComment(auth.workspaceId, parsedParams.data.commentId);
    if (!existing) return apiError(404, 'not_found', 'Comment not found');
    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, existing.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Comment not found');

    const result = await deleteComment({
      workspaceId: auth.workspaceId,
      commentId: existing.id,
      actor: { ...auth.actor, label: auth.identity.name },
      isAdmin: isWorkspaceAdmin(auth.identity),
    });
    return apiJson({ deleted: result.deleted }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
