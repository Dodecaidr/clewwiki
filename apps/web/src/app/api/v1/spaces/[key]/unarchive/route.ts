import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { authenticateRequest, requireWorkspace } from '@/lib/api-auth';
import { actorOf, isWorkspaceAdmin } from '@/lib/pages-api';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';
import { toSpaceResource } from '@/lib/spaces/serialize';
import { setSpaceArchived } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

/**
 * Brings an archived space back into the listings and lets it take new pages
 * again. Idempotent. Administrators only.
 */
export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;

  if (!isWorkspaceAdmin(auth.identity)) {
    return apiError(403, 'forbidden', 'Only a workspace administrator can unarchive a space');
  }

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const space = await setSpaceArchived({
      workspaceId: auth.identity.workspaceId,
      spaceId: resolved.space.id,
      actor: actorOf(auth.identity),
      archived: false,
    });
    return apiJson(toSpaceResource(space, { includeRepository: true }), auth.headers ?? {});
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
