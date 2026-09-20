'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { deleteImage, getImageAccess } from '@/lib/images/service';
import { getWriterSession } from '@/lib/session';
import { canView } from '@/lib/spaces/visibility';

export interface ImageActionState {
  error?: 'forbidden' | 'not_found' | 'generic';
}

/**
 * Removes an uploaded image for good.
 *
 * An image is reached through its page, so the check is the page's: whoever can
 * see the space the page is in now may remove its images, as they may edit or
 * delete the page itself. One that no page has claimed yet belongs to whoever
 * uploaded it and to nobody else. Anything the person may not see is reported
 * as missing, never as forbidden.
 */
export async function deleteImageAction(
  _previous: ImageActionState,
  formData: FormData,
): Promise<ImageActionState> {
  const session = await getWriterSession();
  if (!session) return { error: 'forbidden' };

  const parsed = z.uuid().safeParse(formData.get('imageId'));
  if (!parsed.success) return { error: 'not_found' };

  try {
    const image = await getImageAccess(session.workspace.id, parsed.data);
    if (!image || !canView(session, image.visibleInSpaceId)) return { error: 'not_found' };
    if (image.uploaderOnly && (image.createdByType !== 'user' || image.createdById !== session.userId)) {
      return { error: 'not_found' };
    }

    const removed = await deleteImage({
      workspaceId: session.workspace.id,
      imageId: image.id,
      actor: { type: 'user', id: session.userId },
    });
    if (!removed) return { error: 'not_found' };
  } catch (error) {
    console.error('[images] delete failed', error);
    return { error: 'generic' };
  }

  revalidatePath('/', 'layout');
  return {};
}
