import { z } from 'zod';

import { apiCreated, apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { listImagesForPage, storeImage } from '@/lib/images/service';
import { readImageUpload, toImageResource } from '@/lib/images/upload';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });
type RouteContext = { params: Promise<{ id: string }> };

/** The images of a page, newest first, without their bytes. */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const page = await getPageById(auth.workspaceId, parsed.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    if (requireSpace(auth.identity, page.spaceId)) return apiError(404, 'not_found', 'Page not found');

    const images = await listImagesForPage(auth.workspaceId, page.id);
    return apiJson({ page_id: page.id, images: images.map(toImageResource) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Uploads an image into a page. The request body is the image itself — PNG,
 * JPEG, GIF or WebP, decided from its bytes — and the answer carries the
 * relative `url` to put in the page body.
 *
 * Uploading changes no page, so it takes no claim: the image shows up nowhere
 * until a write under a claim refers to it. The same bytes uploaded to the same
 * page again answer `200` with the image that is already there.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES, { body: 'image' });
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const page = await getPageById(auth.workspaceId, parsed.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');
    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;
    if (requireSpace(auth.identity, page.spaceId)) return apiError(404, 'not_found', 'Page not found');

    const upload = await readImageUpload(request, auth.actor);
    if ('response' in upload) return upload.response;

    const stored = await storeImage({
      workspaceId: auth.workspaceId,
      spaceId: page.spaceId,
      pageId: page.id,
      actor: auth.actor,
      bytes: upload.bytes,
    });
    const resource = toImageResource(stored.image);
    return stored.created ? apiCreated(resource, auth.headers) : apiJson(resource, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
