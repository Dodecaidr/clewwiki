import { notFound, redirect } from 'next/navigation';

import { getSessionContext } from '@/lib/session';
import { legacyPageLocation } from '@/lib/spaces/legacy';

export const dynamic = 'force-dynamic';

/** `/pages/{id}/edit` from before spaces: the same editor, under the page's space. */
export default async function LegacyPageEdit({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<never> {
  const session = await getSessionContext();
  if (!session) redirect('/login');
  const location = await legacyPageLocation(session.workspace.id, (await params).id, 'edit');
  if (!location) notFound();
  redirect(location);
}
