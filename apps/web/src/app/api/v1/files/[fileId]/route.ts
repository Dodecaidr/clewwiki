import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { fileActorOf, mayReadFile, toFileResource, toFileVersionResource } from '@/lib/files/api';
import { deleteFile, getFileAccess, listFileVersions } from '@/lib/files/service';
import { authorizePagesRequest, DELETE_SCOPES, READ_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ fileId: z.uuid() });
type RouteContext = { params: Promise<{ fileId: string }> };

const NOT_FOUND = () => apiError(404, 'not_found', 'File not found');

/** A file and every version of it, newest first, without their bytes. */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NOT_FOUND();

  try {
    const file = await getFileAccess(auth.workspaceId, parsed.data.fileId);
    if (!file || !mayReadFile(auth.identity, file)) return NOT_FOUND();
    const versions = await listFileVersions(auth.workspaceId, file.id);
    return apiJson(
      { ...toFileResource(file), versions: versions.map((version) => toFileVersionResource(file.id, version)) },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Removes a file with all its versions. Scoped like deleting a page or an
 * image — a token needs `pages:delete` on top of `pages:write` — because it
 * cannot be undone.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, DELETE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NOT_FOUND();

  try {
    const file = await getFileAccess(auth.workspaceId, parsed.data.fileId);
    if (!file || !mayReadFile(auth.identity, file)) return NOT_FOUND();
    const removed = await deleteFile({ workspaceId: auth.workspaceId, fileId: file.id, actor: fileActorOf(auth.identity) });
    if (!removed) return NOT_FOUND();
    return apiJson({ file_id: file.id, deleted: true }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
