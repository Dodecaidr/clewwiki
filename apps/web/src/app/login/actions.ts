'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { attemptLogin } from '@/lib/login';
import { OIDC_PROVIDER_ID } from '@/lib/oidc';

export interface LoginFormState {
  error?: 'invalid';
}

const loginSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(256),
});

export async function signInAction(
  _prevState: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  // A malformed address, a wrong password and an attempt refused by the login
  // rate limit all get the same answer: the form must not let a caller
  // distinguish "no such account" from "wrong password" from "slow down".
  if (!parsed.success) {
    return { error: 'invalid' };
  }

  const result = await attemptLogin({
    email: parsed.data.email,
    password: parsed.data.password,
    headers: new Headers(await headers()),
  });
  if (!result.ok) {
    return { error: 'invalid' };
  }

  redirect('/');
}

/**
 * Starting the single sign-on round trip.
 *
 * The provider is asked for an authorization URL and the browser is sent
 * there; everything after that is the library's callback route, and the person
 * comes back to `/sso`, which decides whether they belong to this workspace.
 *
 * A failure at the provider comes back to the sign-in page with a reason in the
 * address bar rather than an error page, because this is somebody trying to get
 * in and the next thing they need is the password form.
 */
export async function signInWithSsoAction(): Promise<void> {
  let url: string | null = null;
  try {
    const started = await auth.api.signInSocial({
      body: {
        provider: OIDC_PROVIDER_ID,
        callbackURL: '/sso',
        errorCallbackURL: '/login?sso=failed',
        disableRedirect: true,
      },
      headers: new Headers(await headers()),
    });
    url = started?.url ?? null;
  } catch (error) {
    console.error('[sso] the provider could not be reached', error);
  }
  redirect(url ?? '/login?sso=failed');
}
