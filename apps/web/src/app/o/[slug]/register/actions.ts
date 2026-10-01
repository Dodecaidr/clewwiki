'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { clientKey } from '@/lib/client-address';
import { AccessError, requestAccess } from '@/lib/orgs/access';
import type { AccessErrorCode } from '@/lib/orgs/access';
import { attemptLogin } from '@/lib/login';
import { getSignedInUser } from '@/lib/session';
import { getWorkspaceBySlug } from '@/lib/workspace';

export interface RegisterFormState {
  error?: AccessErrorCode;
}

export async function requestAccessAction(
  _previous: RegisterFormState,
  formData: FormData,
): Promise<RegisterFormState> {
  const workspace = await getWorkspaceBySlug(String(formData.get('org') ?? ''));
  if (!workspace) return { error: 'closed' };
  const requestHeaders = new Headers(await headers());
  const client = clientKey(requestHeaders);
  const message = String(formData.get('message') ?? '');
  const user = await getSignedInUser();

  try {
    if (user) {
      await requestAccess({ workspace, client, message, existingUserId: user.id });
    } else {
      const email = String(formData.get('email') ?? '');
      const password = String(formData.get('password') ?? '');
      await requestAccess({
        workspace,
        client,
        message,
        name: String(formData.get('name') ?? ''),
        email,
        password,
      });
      // Signed in straight away, so the next screen can say "waiting" to the
      // right person and approval needs nothing more from them.
      await attemptLogin({ email, password, headers: requestHeaders });
    }
  } catch (error) {
    if (error instanceof AccessError) return { error: error.code };
    console.error('[access] a request to join failed', error);
    return { error: 'generic' };
  }
  redirect('/pending');
}
