import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireSpace } from '@/lib/api-auth';
import { authorizeImportRequest } from '@/lib/imports/auth';
import { toApplyResource } from '@/lib/imports/serialize';
import { applyImport, requireImport } from '@/lib/imports/service';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The one call that writes pages.
 *
 * Everything before it was staging. This walks the reviewed items in order,
 * creates the pages, and answers with what landed and what did not — an item
 * whose path is taken, or whose page somebody else is holding, is reported as
 * skipped with the reason rather than forced through.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizeImportRequest(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  try {
    const record = await requireImport(auth.workspaceId, id);
    const space = await getSpaceById(auth.workspaceId, record.spaceId);
    if (!space) return apiError(404, 'not_found', 'Import not found');
    const outside = requireSpace(auth.identity, space.id);
    if (outside) return outside;

    const result = await applyImport({
      workspaceId: auth.workspaceId,
      importId: record.id,
      actor: auth.actor,
    });
    return apiJson(toApplyResource(result, space.key));
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
