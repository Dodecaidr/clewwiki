import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireSpace } from '@/lib/api-auth';
import { authorizeImportRequest } from '@/lib/imports/auth';
import { toImportPreviewResource } from '@/lib/imports/serialize';
import { deleteImport, previewImport, requireImport } from '@/lib/imports/service';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * One import: its status, its counts, and every staged item with the target
 * path it will take, the warnings its conversion produced, and whether a page
 * is already there or is being held by somebody.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizeImportRequest(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  try {
    const record = await requireImport(auth.workspaceId, id);
    const space = await getSpaceById(auth.workspaceId, record.spaceId);
    if (!space) return apiError(404, 'not_found', 'Import not found');
    const outside = requireSpace(auth.identity, space.id);
    if (outside) return outside;

    const preview = await previewImport(auth.workspaceId, record.id);
    return apiJson(toImportPreviewResource(preview, space.key));
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Removes the import and its staged items. Pages it already created stay: they
 * are ordinary pages, and forgetting how they arrived is not deleting them.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizeImportRequest(request);
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  try {
    const record = await requireImport(auth.workspaceId, id);
    const space = await getSpaceById(auth.workspaceId, record.spaceId);
    if (!space) return apiError(404, 'not_found', 'Import not found');
    const outside = requireSpace(auth.identity, space.id);
    if (outside) return outside;

    await deleteImport(auth.workspaceId, record.id, auth.actor);
    return apiJson({ deleted: true, id: record.id });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
