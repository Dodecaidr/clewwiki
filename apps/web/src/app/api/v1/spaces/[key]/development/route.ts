import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { overviewResource } from '@/lib/development/api';
import { buildOverview, countOpenProblems, listReleases, listStreams } from '@/lib/development/service';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

/**
 * The space's development at a glance: each release with its streams and the
 * ones not yet in the default branch, what was merged with no release to ship
 * in, and what is in progress without one.
 */
export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');
  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;
    const [streams, releases] = await Promise.all([
      listStreams(auth.workspaceId, resolved.space.id),
      listReleases(auth.workspaceId, resolved.space.id),
    ]);
    const problems = await countOpenProblems(auth.workspaceId, streams.map((stream) => stream.id));
    return apiJson(
      { space: resolved.space.key, ...overviewResource(buildOverview(streams, releases), auth.identity.workspace, problems) },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
