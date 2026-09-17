import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { authenticateRequest, requireWorkspace } from '@/lib/api-auth';
import { actorOf, isWorkspaceAdmin } from '@/lib/pages-api';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';
import { toSpaceResource } from '@/lib/spaces/serialize';
import { setSpaceArchived } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

/**
 * Archives a space. Its pages stay readable by everyone who could read them;
 * the space drops out of the default listings and of "all spaces" search, and
 * takes no new pages. Idempotent. Administrators only.
 */
export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;

  if (!isWorkspaceAdmin(auth.identity)) {
    return apiError(403, 'forbidden', 'Only a workspace administrator can archive a space');
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
      archived: true,
    });
    return apiJson(toSpaceResource(space, { includeRepository: true }), auth.headers ?? {});
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
