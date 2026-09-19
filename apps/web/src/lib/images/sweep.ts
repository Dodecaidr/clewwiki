import 'server-only';

import { and, isNull, lt } from 'drizzle-orm';
import { pageImages } from '@clewwiki/db';

import { getDatabase } from '../db';

/** How long an image may wait for the page it was uploaded for to be created. */
export const UNATTACHED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Drops images uploaded for a page that was never created.
 *
 * Kept apart from the image service because start-up code schedules it: what
 * is loaded there is traced for every runtime, and this needs the database and
 * nothing else.
 */
export async function sweepUnattachedImages(now: Date = new Date()): Promise<{ removed: number }> {
  const removed = await getDatabase()
    .delete(pageImages)
    .where(
      and(isNull(pageImages.pageId), lt(pageImages.createdAt, new Date(now.getTime() - UNATTACHED_IMAGE_TTL_MS))),
    )
    .returning({ id: pageImages.id });
  return { removed: removed.length };
}
