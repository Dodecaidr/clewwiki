import { z } from 'zod';

import {
  apiCreated,
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';
import { toPageReviewResource, toReviewResource } from '@/lib/reviews/serialize';
import {
  MAX_REVIEW_NOTE_LENGTH,
  acceptPageChanges,
  getPageReviewState,
  revertPageChanges,
} from '@/lib/reviews/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const paramsSchema = z.object({ id: z.uuid() });

const decideBodySchema = z
  .object({
    decision: z.enum(['accept', 'revert']),
    /** The version the reviewer was looking at; it must still be the newest. */
    version: z.number().int().min(1).max(2_147_483_647),
    note: z.string().max(MAX_REVIEW_NOTE_LENGTH * 2).nullish(),
  })
  .strict();

/**
 * Where a page stands with its reviewers: the baseline, the agent revisions
 * after it, and the decisions recorded so far — notes included, which is how an
 * agent finds out why its change was reverted.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    const hidden = requireSpace(auth.identity, page.spaceId);
    if (hidden) return apiError(404, 'not_found', 'Page not found');

    const state = await getPageReviewState(auth.workspaceId, page.id);
    return apiJson(toPageReviewResource(state), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Records a person's decision about the agent changes on a page.
 *
 * A bearer token is refused whatever its scopes. The review exists so that a
 * person has looked at what agents wrote; a token that could accept would let
 * an agent clear the list it is on, and one that could revert would let agents
 * undo each other outside the claim protocol they already have for that.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;
  if (auth.identity.type !== 'user') {
    return apiError(
      403,
      'forbidden',
      'Reviews are recorded by signed-in people only. An agent token can read a page’s review state and cannot decide it.',
    );
  }

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = decideBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;

    const input = {
      workspaceId: auth.workspaceId,
      pageId: page.id,
      reviewer: { id: auth.identity.userId, label: auth.identity.name },
      headVersion: parsed.data.version,
      note: parsed.data.note ?? null,
    };
    const result =
      parsed.data.decision === 'accept'
        ? await acceptPageChanges(input)
        : await revertPageChanges(input);

    return apiCreated(
      {
        ...toReviewResource(result.review),
        page_id: result.page.id,
        current_version: result.page.version,
        content_hash: result.page.contentHash,
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
