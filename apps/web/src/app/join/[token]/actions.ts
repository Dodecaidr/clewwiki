'use server';

import { redirect } from 'next/navigation';

import { MemberError, acceptInvitation } from '@/lib/members/service';

export interface JoinFormState {
  error?: 'invalidInvitation' | 'emailTaken' | 'password' | 'generic';
}

/**
 * Accepts an invitation: the one way, after `/setup`, that an account comes
 * into existence. The authentication library signs the new account in as it
 * creates it, so the person lands in the wiki, not on a second form.
 */
export async function acceptInvitationAction(_previous: JoinFormState, formData: FormData): Promise<JoinFormState> {
  const token = formData.get('token');
  const name = formData.get('name');
  const password = formData.get('password');
  if (typeof token !== 'string' || typeof name !== 'string' || typeof password !== 'string') {
    return { error: 'generic' };
  }

  try {
    await acceptInvitation({ token, name, password });
  } catch (error) {
    if (error instanceof MemberError) {
      const code = error.code;
      return { error: code === 'invalidInvitation' || code === 'emailTaken' || code === 'password' ? code : 'generic' };
    }
    console.error('[join] accepting an invitation failed', error);
    return { error: 'generic' };
  }
  redirect('/');
}
