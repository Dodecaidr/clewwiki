import { redirect } from 'next/navigation';

import { getSessionContext } from '@/lib/session';
import { listSpaces } from '@/lib/spaces/service';
import { spaceSettingsHref } from '@/lib/spaces/urls';

export const dynamic = 'force-dynamic';

/**
 * The repository used to be one setting for the whole workspace. It is now
 * part of each space's settings; with exactly one space there is no question
 * which one was meant, otherwise the space list is where to pick.
 */
export default async function LegacyRepositorySettings(): Promise<never> {
  const session = await getSessionContext();
  if (!session) redirect('/login');
  const spaces = await listSpaces(session.workspace.id);
  const [only] = spaces;
  redirect(spaces.length === 1 && only ? spaceSettingsHref(only.key) : '/');
}
