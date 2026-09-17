import { notFound, redirect } from 'next/navigation';

import { getSessionContext } from '@/lib/session';
import { legacyPageLocation } from '@/lib/spaces/legacy';

export const dynamic = 'force-dynamic';

/** `/pages/{id}` from before spaces: the same page, under its space. */
export default async function LegacyPageView({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<never> {
  const session = await getSessionContext();
  if (!session) redirect('/login');
  const location = await legacyPageLocation(session.workspace.id, (await params).id, 'view');
  if (!location) notFound();
  redirect(location);
}
