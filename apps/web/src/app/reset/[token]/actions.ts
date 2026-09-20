'use server';

import { redirect } from 'next/navigation';

import { completePasswordReset } from '@/lib/members/account';
import { MemberError } from '@/lib/members/service';

export interface ResetFormState {
  error?: 'invalidReset' | 'password' | 'generic';
}

/**
 * Sets the password a reset link was made for. It does not sign anybody in: the
 * visitor goes to the sign-in page and proves the new password by using it.
 */
export async function completeResetAction(_previous: ResetFormState, formData: FormData): Promise<ResetFormState> {
  const token = formData.get('token');
  const password = formData.get('password');
  if (typeof token !== 'string' || typeof password !== 'string') return { error: 'generic' };

  try {
    await completePasswordReset({ token, password });
  } catch (error) {
    if (error instanceof MemberError) {
      return { error: error.code === 'invalidReset' || error.code === 'password' ? error.code : 'generic' };
    }
    console.error('[reset] completing a password reset failed', error);
    return { error: 'generic' };
  }
  redirect('/login?reset=done');
}
