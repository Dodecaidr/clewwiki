import { z } from 'zod';

import { apiCreated, apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import {
  fileActorOf,
  fileTooLargeResponse,
  mayReadFile,
  serveFileVersion,
  toFileResource,
  toFileVersionResource,
  versionParam,
} from '@/lib/files/api';
import { FileTooLargeError, getFileByName, getFileVersion, uploadFileVersion } from '@/lib/files/service';
import { fileLimits, filesEnabled } from '@/lib/files/store';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid(), name: z.string().min(1) });
type RouteContext = { params: Promise<{ id: string; name: string }> };

const NOT_FOUND = () => apiError(404, 'not_found', 'File not found');

/**
 * Downloads the file called `name` on the page: its latest version, or the one
 * `?version=` names. This address never changes while the file exists, which
 * is what makes it the one to put in a page or a release note.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NOT_FOUND();
  const wanted = versionParam(new URL(request.url));
  if (wanted === undefined) return apiError(400, 'validation', 'version must be a positive integer or "latest"');

  try {
    const file = await getFileByName(auth.workspaceId, parsed.data.id, parsed.data.name);
    if (!file || !mayReadFile(auth.identity, file)) return NOT_FOUND();

    const version = wanted === null ? file.latest : await getFileVersion(auth.workspaceId, file.id, wanted);
    if (!version) return apiError(404, 'not_found', `The file has no version ${wanted}`);
    return await serveFileVersion(request, auth.workspaceId, file, version, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Uploads the request body as the file `name` on the page: a new file, or the
 * next version of the one the page already has by that name, in any case.
 * `?note=` says what changed; it is shown with the version and in the inbox of
 * whoever watches the page.
 *
 * Answers `201` with the file when a version was added, and `200` when these
 * bytes already were the latest version — so repeating an upload is harmless.
 * The body is streamed, never held; it must declare its size, and one larger
 * than the instance's limit is refused before a byte is read.
 *
 * Uploading changes no page text, so it takes no claim.
 */
export async function PUT(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES, { body: 'file' });
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  if (!filesEnabled()) {
    return apiError(403, 'forbidden', 'Attached files are switched off on this instance (FILES_DRIVER)');
  }

  const limits = fileLimits();
  const declared = request.headers.get('content-length');
  if (declared === null || !/^\d+$/.test(declared.trim())) {
    return apiError(411, 'validation', 'An upload must declare its size (Content-Length)');
  }
  if (Number(declared) > limits.uploadBytes) {
    return fileTooLargeResponse(new FileTooLargeError(Number(declared), limits.uploadBytes));
  }
  if (!request.body || Number(declared) === 0) return apiError(400, 'validation', 'The upload is empty');

  try {
    const page = await getPageById(auth.workspaceId, parsed.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    if (requireSpace(auth.identity, page.spaceId)) return apiError(404, 'not_found', 'Page not found');

    const result = await uploadFileVersion({
      workspaceId: auth.workspaceId,
      pageId: page.id,
      name: parsed.data.name,
      body: request.body,
      declaredType: request.headers.get('content-type'),
      note: new URL(request.url).searchParams.get('note'),
      actor: fileActorOf(auth.identity),
      declaredBytes: Number(declared),
    });
    const body = { ...toFileResource(result.file), version: toFileVersionResource(result.file.id, result.version) };
    return result.created ? apiCreated(body, auth.headers) : apiJson(body, auth.headers);
  } catch (error) {
    if (error instanceof FileTooLargeError) return fileTooLargeResponse(error);
    return serviceErrorResponse(error);
  }
}
