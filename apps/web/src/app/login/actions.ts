'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { attemptLogin } from '@/lib/login';

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
