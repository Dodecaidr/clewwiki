import { apiJson, serviceErrorResponse } from '@/lib/api-response';
import { syncStreams } from '@/lib/development/service';
import { spaceFromRoute } from '@/lib/development/space-route';
import { actorOf, authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

/** Reads the space repository's branches into its streams: new ones, merged ones, gone ones. */
export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;
  try {
    const route = await spaceFromRoute(auth.identity, (await context.params).key);
    if (!route.ok) return route.response;
    const result = await syncStreams(auth.workspaceId, route.space.id, actorOf(auth.identity));
    return apiJson(
      {
        default_branch: result.defaultBranch,
        created: result.created,
        merged: result.merged,
        gone: result.gone,
        skipped_history: result.skippedHistory,
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
