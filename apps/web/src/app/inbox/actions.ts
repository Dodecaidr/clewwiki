'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { markInboxRead } from '@/lib/inbox/service';
import { getSessionContext } from '@/lib/session';

/**
 * Marks the signed-in person's inbox read, up to the moment the page they are
 * looking at was rendered — so what arrived while they were reading it is still
 * unread when the page comes back.
 */
export async function markInboxReadAction(formData: FormData): Promise<void> {
  const session = await getSessionContext();
  if (!session) redirect('/login');

  const raw = formData.get('upTo');
  const upTo = typeof raw === 'string' ? new Date(raw) : new Date();
  await markInboxRead(
    session.workspace.id,
    { type: 'user', id: session.userId },
    Number.isNaN(upTo.getTime()) ? new Date() : upTo,
  );
  revalidatePath('/', 'layout');
}
