import { z } from 'zod';

import {
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { getPageSpaceId } from '@/lib/pages/service';
import { getClaimById, releaseClaim, renewClaim } from '@/lib/claims/service';
import { toClaimResource } from '@/lib/claims/serialize';
import { MAX_CLAIM_TTL_SECONDS, MIN_CLAIM_TTL_SECONDS } from '@/lib/claims/ttl';
import {
  authorizePagesRequest,
  claimActorOf,
  isWorkspaceAdmin,
  WRITE_SCOPES,
} from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ claimId: z.uuid() });

const renewBodySchema = z.object({
  ttl_seconds: z
    .number()
    .int()
    .min(MIN_CLAIM_TTL_SECONDS)
    .max(MAX_CLAIM_TTL_SECONDS)
    .optional(),
});

type RouteContext = { params: Promise<{ claimId: string }> };

/**
 * Heartbeat: extends a lease the caller holds.
 *
 * A lease already past its deadline is not revived — the target may have been
 * taken in between — so a late heartbeat answers `404` and the caller claims
 * again, which is the point at which it finds out whether it can.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Claim not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }

  const parsed = renewBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    // Read first so the workspace check is written out in the handler, the way
    // every other endpoint does it, rather than left to the service predicate.
    const existing = await getClaimById(auth.workspaceId, parsedParams.data.claimId);
    if (!existing) return apiError(404, 'not_found', 'Claim not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    // A claim belongs to the space of the page it is on.
    const spaceId = await getPageSpaceId(auth.workspaceId, existing.pageId);
    if (!spaceId || requireSpace(auth.identity, spaceId)) {
      return apiError(404, 'not_found', 'Claim not found');
    }

    const claim = await renewClaim({
      workspaceId: auth.workspaceId,
      claimId: parsedParams.data.claimId,
      actor: claimActorOf(auth.identity),
      ttlSeconds: parsed.data.ttl_seconds,
      settings: auth.identity.workspace.settings,
    });

    return apiJson(toClaimResource(claim), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Releases a lease and deletes the notes bound to it.
 *
 * Idempotent: releasing an already-released claim answers `200`, because a
 * client that timed out on its first attempt must not be told the second one
 * failed. `?force=true` lets a workspace administrator take a claim away from
 * whoever holds it; it is audited under its own action.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Claim not found');

  const force = new URL(request.url).searchParams.get('force') === 'true';
  if (force && !isWorkspaceAdmin(auth.identity)) {
    return apiError(403, 'forbidden', 'Only a workspace administrator can force-release a claim');
  }

  try {
    const existing = await getClaimById(auth.workspaceId, parsedParams.data.claimId);
    if (!existing) return apiError(404, 'not_found', 'Claim not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    // A claim belongs to the space of the page it is on.
    const spaceId = await getPageSpaceId(auth.workspaceId, existing.pageId);
    if (!spaceId || requireSpace(auth.identity, spaceId)) {
      return apiError(404, 'not_found', 'Claim not found');
    }

    const result = await releaseClaim({
      workspaceId: auth.workspaceId,
      claimId: parsedParams.data.claimId,
      actor: claimActorOf(auth.identity),
      force,
    });

    return apiJson(
      {
        claim_id: result.claimId,
        released: true,
        already_released: result.alreadyReleased,
        notes_deleted: result.notesDeleted,
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
