import 'server-only';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { pageImages } from '@clewwiki/db';

import type { DbExecutor } from '../db';
import { referencedImageIds } from './detect';

/**
 * Hands a new page the images its author uploaded while writing it.
 *
 * The new-page form has no page to upload to, so its images wait unattached,
 * visible to their uploader alone. When the page is created, the ones its body
 * refers to become the page's — only images this same actor uploaded, in this
 * same space, that no page has claimed: a body naming somebody else's image
 * attaches nothing, and that image stays exactly as visible as it was.
 *
 * It depends on the schema and nothing else, so that the page service can call
 * it inside the transaction that creates the page.
 */
export async function attachUploadedImages(
  executor: DbExecutor,
  input: {
    workspaceId: string;
    spaceId: string;
    pageId: string;
    actor: { type: 'user' | 'agent'; id: string };
    body: string;
  },
): Promise<number> {
  const ids = referencedImageIds(input.body);
  if (ids.length === 0) return 0;

  const attached = await executor
    .update(pageImages)
    .set({ pageId: input.pageId })
    .where(
      and(
        eq(pageImages.workspaceId, input.workspaceId),
        eq(pageImages.spaceId, input.spaceId),
        isNull(pageImages.pageId),
        eq(pageImages.createdByType, input.actor.type),
        eq(pageImages.createdById, input.actor.id),
        inArray(pageImages.id, ids),
      ),
    )
    .returning({ id: pageImages.id });
  return attached.length;
}
