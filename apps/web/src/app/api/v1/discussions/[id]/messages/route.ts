import { z } from 'zod';

import {
  apiCreated,
  apiError,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { consumeMessageBudget } from '@/lib/discussions/rate-limit';
import { MAX_MESSAGE_BYTES, getDiscussionById, postDiscussionMessage } from '@/lib/discussions/service';
import { toDiscussionMessageResource, toDiscussionStub } from '@/lib/discussions/serialize';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const paramsSchema = z.object({ id: z.uuid() });

// The schema's ceiling is deliberately looser than the service's: the service
// counts octets, which is the limit that matters, and answers with a
// `validation` error naming the real number. This one only keeps an absurd
// payload from being parsed at all.
const bodySchema = z.object({ body: z.string().min(1).max(MAX_MESSAGE_BYTES * 2) }).strict();

/**
 * Adds a message to an open discussion. `pages:write`.
 *
 * Two limits apply on top of the general one. The actor's own message bucket —
 * a message is the cheapest write in the API to repeat, and a flooded thread is
 * useless to everyone else — and the cap on messages in one thread, which is a
 * refusal with an instruction rather than a silent truncation.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Discussion not found');

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
    return apiError(429, 'rate_limited', 'Too many discussion messages; slow down', {
      retry_after_seconds: budget.resetAfterSeconds,
      limit: budget.limit,
    });
  }

  try {
    const existing = await getDiscussionById(auth.workspaceId, parsedParams.data.id);
    if (!existing) return apiError(404, 'not_found', 'Discussion not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    const outOfReach = requireSpace(auth.identity, existing.spaceId);
    if (outOfReach) return outOfReach;

    const result = await postDiscussionMessage({
      workspaceId: auth.workspaceId,
      discussionId: existing.id,
      actor: { ...auth.actor, label: auth.identity.name },
      body: parsed.data.body,
    });

    const space = await getSpaceById(auth.workspaceId, result.discussion.spaceId);
    if (!space) return apiError(404, 'not_found', 'Discussion not found');

    return apiCreated(
      {
        ...toDiscussionStub(result.discussion, space),
        message: toDiscussionMessageResource(result.message),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
