import { apiCreated, apiError, apiJson, serviceErrorResponse } from '@/lib/api-response';
import { storeImage } from '@/lib/images/service';
import { readImageUpload, toImageResource } from '@/lib/images/upload';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

/**
 * Uploads an image for a page that does not exist yet.
 *
 * The new-page form has nothing to upload to. An image sent here waits, visible
 * to whoever uploaded it and nobody else, and becomes the page's when that same
 * actor creates a page in this space whose body refers to it. One that no page
 * claims within a day is removed. With a page in hand, upload to the page.
 */
export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES, { body: 'image' });
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    if (resolved.space.archivedAt !== null) {
      return apiError(409, 'conflict', 'This space is archived and takes no new pages', {
        space: resolved.space.key,
      });
    }

    const upload = await readImageUpload(request, auth.actor);
    if ('response' in upload) return upload.response;

    const stored = await storeImage({
      workspaceId: auth.workspaceId,
      spaceId: resolved.space.id,
      pageId: null,
      actor: auth.actor,
      bytes: upload.bytes,
    });
    const resource = toImageResource(stored.image);
    return stored.created ? apiCreated(resource, auth.headers) : apiJson(resource, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
