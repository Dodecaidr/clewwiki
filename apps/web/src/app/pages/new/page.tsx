import { redirect } from 'next/navigation';

import { getSessionContext } from '@/lib/session';
import { legacyPageLocation } from '@/lib/spaces/legacy';

export const dynamic = 'force-dynamic';

/**
 * `/pages/new?parent={id}` from before spaces: a new child of that page, in the
 * page's space. Without a parent there is no space to put a page in, so the
 * space list is where to choose one.
 */
export default async function LegacyNewPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string }>;
}): Promise<never> {
  const session = await getSessionContext();
  if (!session) redirect('/login');
  const { parent } = await searchParams;
  const location = parent ? await legacyPageLocation(session.workspace.id, parent, 'new-child') : null;
  redirect(location ?? '/');
}
