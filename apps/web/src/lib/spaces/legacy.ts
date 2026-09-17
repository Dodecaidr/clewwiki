import 'server-only';

import { getPageById } from '../pages/service';
import { getSpaceById } from './service';
import { newSpacePageHref, spacePageEditHref, spacePageHref } from './urls';

/**
 * Where a URL from before spaces now lives.
 *
 * Pages used to be addressed as `/pages/{id}`; they are now
 * `/spaces/{key}/pages/{id}`. The id did not change, so an old link resolves
 * to exactly one new location — or to nothing, when the page is gone or
 * belongs to another workspace, which the old route would have answered with
 * a 404 too.
 */
export type LegacyTarget = 'view' | 'edit' | 'new-child';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function legacyPageLocation(
  workspaceId: string,
  pageId: string,
  target: LegacyTarget = 'view',
): Promise<string | null> {
  if (!UUID_PATTERN.test(pageId)) return null;
  const page = await getPageById(workspaceId, pageId);
  if (!page || page.workspaceId !== workspaceId) return null;
  const space = await getSpaceById(workspaceId, page.spaceId);
  if (!space) return null;
  if (target === 'edit') return spacePageEditHref(space.key, page.id);
  if (target === 'new-child') return newSpacePageHref(space.key, page.id);
  return spacePageHref(space.key, page.id);
}
