import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireSpace } from '@/lib/api-auth';
import { authorizeImportRequest } from '@/lib/imports/auth';
import { toImportResource } from '@/lib/imports/serialize';
import { cancelImport, requireImport } from '@/lib/imports/service';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Closes an import without applying it. The staged rows stay until the import
 * is deleted, so a reviewer who changed their mind can still read what it
 * would have created.
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

    const cancelled = await cancelImport(auth.workspaceId, record.id, auth.actor);
    return apiJson(toImportResource(cancelled, space.key));
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
