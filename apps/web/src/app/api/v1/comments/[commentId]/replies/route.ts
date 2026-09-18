import { z } from 'zod';

import {
  apiCreated,
  apiError,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { toCommentResource } from '@/lib/comments/serialize';
import { MAX_COMMENT_BYTES, getComment, replyToComment } from '@/lib/comments/service';
import { consumeMessageBudget } from '@/lib/discussions/rate-limit';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ commentId: string }> };

const paramsSchema = z.object({ commentId: z.uuid() });
const bodySchema = z.object({ body: z.string().min(1).max(MAX_COMMENT_BYTES * 2) }).strict();

/**
 * Replies in a thread. `commentId` is the comment that opened it; a reply's id
 * is refused with the thread's id in the details. `409 conflict` on a resolved
 * thread — reopen it first.
 */
export async function POST(request: Request, context: RouteContext) {
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
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  const budget = consumeMessageBudget(auth.actor.type, auth.actor.id);
  if (!budget.allowed) {
    return apiError(429, 'rate_limited', 'Too many comments and messages; slow down', {
      retry_after_seconds: budget.resetAfterSeconds,
      limit: budget.limit,
    });
  }

  try {
    const existing = await getComment(auth.workspaceId, parsedParams.data.commentId);
    if (!existing) return apiError(404, 'not_found', 'Comment not found');
    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, existing.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Comment not found');

    const reply = await replyToComment({
      workspaceId: auth.workspaceId,
      threadId: existing.id,
      actor: { ...auth.actor, label: auth.identity.name },
      body: parsed.data.body,
    });
    return apiCreated(
      { thread_id: existing.id, page_id: existing.pageId, ...toCommentResource(reply) },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
