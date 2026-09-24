import { z } from 'zod';

import { apiCreated, apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { fileActorOf, mayReadFile, toFileResource, toFileVersionResource } from '@/lib/files/api';
import { getFileAccess, MAX_NOTE_LENGTH, restoreFileVersion } from '@/lib/files/service';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ fileId: z.uuid() });
const bodySchema = z.object({
  version: z.number().int().positive(),
  note: z.string().max(MAX_NOTE_LENGTH).nullish(),
});
type RouteContext = { params: Promise<{ fileId: string }> };

const NOT_FOUND = () => apiError(404, 'not_found', 'File not found');

/**
 * Makes an older version the file's content again, by adding it as a new
 * version: nothing that anybody downloaded changes. Answers `201` with the new
 * version, or `200` when that content already is the latest.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NOT_FOUND();

  try {
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) return validationError(body.error);

    const file = await getFileAccess(auth.workspaceId, parsed.data.fileId);
    if (!file || !mayReadFile(auth.identity, file)) return NOT_FOUND();

    const result = await restoreFileVersion({
      workspaceId: auth.workspaceId,
      fileId: file.id,
      version: body.data.version,
      note: body.data.note,
      actor: fileActorOf(auth.identity),
    });
    const resource = { ...toFileResource(result.file), version: toFileVersionResource(result.file.id, result.version) };
    return result.created ? apiCreated(resource, auth.headers) : apiJson(resource, auth.headers);
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'validation', error.message);
    return serviceErrorResponse(error);
  }
}
