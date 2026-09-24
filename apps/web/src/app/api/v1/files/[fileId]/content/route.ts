import { z } from 'zod';

import { apiError, serviceErrorResponse } from '@/lib/api-response';
import { mayReadFile, serveFileVersion, versionParam } from '@/lib/files/api';
import { getFileAccess, getFileVersion } from '@/lib/files/service';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ fileId: z.uuid() });
type RouteContext = { params: Promise<{ fileId: string }> };

const NOT_FOUND = () => apiError(404, 'not_found', 'File not found');

/** The bytes of one version of a file — the latest unless `?version=` says otherwise. */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NOT_FOUND();
  const wanted = versionParam(new URL(request.url));
  if (wanted === undefined) return apiError(400, 'validation', 'version must be a positive integer or "latest"');

  try {
    const file = await getFileAccess(auth.workspaceId, parsed.data.fileId);
    if (!file || !mayReadFile(auth.identity, file)) return NOT_FOUND();
    const version = wanted === null ? file.latest : await getFileVersion(auth.workspaceId, file.id, wanted);
    if (!version) return apiError(404, 'not_found', `The file has no version ${wanted}`);
    return await serveFileVersion(request, auth.workspaceId, file, version, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
