'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { changeOwnName, changeOwnPassword } from '@/lib/members/account';
import { MemberError } from '@/lib/members/service';
import type { MemberErrorCode } from '@/lib/members/service';
import { getSessionContext } from '@/lib/session';

export interface AccountFormState {
  error?: MemberErrorCode;
  saved?: boolean;
}

function failure(error: unknown): AccountFormState {
  if (error instanceof MemberError) return { error: error.code };
  console.error('[account] action failed', error);
  return { error: 'generic' };
}

/** Both actions act on the session's own account and take no id: there is nobody else they could reach. */
export async function changeNameAction(_previous: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };
  const name = formData.get('name');
  if (typeof name !== 'string') return { error: 'name' };

  try {
    await changeOwnName({ workspaceId: session.workspace.id, userId: session.userId, headers: await headers() }, name);
    revalidatePath('/', 'layout');
    return { saved: true };
  } catch (error) {
    return failure(error);
  }
}

export async function changePasswordAction(_previous: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };
  const currentPassword = formData.get('currentPassword');
  const newPassword = formData.get('newPassword');
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') return { error: 'password' };

  try {
    await changeOwnPassword(
      { workspaceId: session.workspace.id, userId: session.userId, headers: await headers() },
      { currentPassword, newPassword },
    );
  } catch (error) {
    return failure(error);
  }
  // Changing the password replaces this session too, and its new cookie is only
  // on the *response*: a page re-rendered inside this request would still be
  // read with the old one and look signed out. A redirect is a new request.
  redirect('/settings/account?password=changed');
}
