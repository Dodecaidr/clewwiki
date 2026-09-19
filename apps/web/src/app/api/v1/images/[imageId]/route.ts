import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { canSeeSpace } from '@/lib/api-auth';
import type { ApiIdentity } from '@/lib/api-auth';
import { IMAGE_EXTENSIONS } from '@/lib/images/detect';
import { deleteImage, getImageAccess, getImageData } from '@/lib/images/service';
import type { ImageAccess } from '@/lib/images/service';
import { actorOf, authorizePagesRequest, DELETE_SCOPES, READ_SCOPES } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ imageId: z.uuid() });
type RouteContext = { params: Promise<{ imageId: string }> };

const NOT_FOUND = () => apiError(404, 'not_found', 'Image not found');

/**
 * Whether this caller may see this image: whoever can see its page's space,
 * or, while no page has claimed it, only whoever uploaded it. Anything else is
 * "not found", as for a page.
 */
function mayRead(identity: ApiIdentity, image: ImageAccess): boolean {
  if (image.workspaceId !== identity.workspaceId) return false;
  if (!canSeeSpace(identity, image.visibleInSpaceId)) return false;
  if (!image.uploaderOnly) return true;
  const actor = actorOf(identity);
  return actor.type === image.createdByType && actor.id === image.createdById;
}

/**
 * The image, as the type its bytes were found to be and as nothing else.
 *
 * These are bytes somebody uploaded, served from the application's own origin,
 * so the response is fenced in: sniffing is off, the response is sandboxed with
 * a policy that loads nothing, and other origins may not embed it. It is always
 * revalidated — a cheap `304` — so that a browser's copy stops being shown the
 * moment its page moves somewhere the reader cannot follow.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NOT_FOUND();

  try {
    const image = await getImageAccess(auth.workspaceId, parsed.data.imageId);
    if (!image || !mayRead(auth.identity, image)) return NOT_FOUND();

    const etag = `"${image.sha256}"`;
    const headers: Record<string, string> = {
      ...auth.headers,
      'Content-Type': image.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': `inline; filename="${image.id}.${IMAGE_EXTENSIONS[image.contentType]}"`,
      'Cache-Control': 'private, no-cache',
      ETag: etag,
    };

    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers });
    }

    const data = await getImageData(auth.workspaceId, image.id);
    if (!data) return NOT_FOUND();
    return new Response(Buffer.from(data), {
      status: 200,
      headers: { ...headers, 'Content-Length': String(data.byteLength) },
    });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Removes an image for good. Scoped like deleting a page — a token needs
 * `pages:delete` on top of `pages:write` — because it cannot be undone:
 * revisions that refer to the image keep their text and lose the picture.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, DELETE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return NOT_FOUND();

  try {
    const image = await getImageAccess(auth.workspaceId, parsed.data.imageId);
    if (!image || !mayRead(auth.identity, image)) return NOT_FOUND();

    const removed = await deleteImage({
      workspaceId: auth.workspaceId,
      imageId: image.id,
      actor: auth.actor,
    });
    if (!removed) return NOT_FOUND();
    return apiJson({ image_id: image.id, deleted: true }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
