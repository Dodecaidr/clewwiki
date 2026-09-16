'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { auth } from '@/lib/auth';

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

  // A malformed address and a wrong password get the same answer: the form
  // must not let a caller distinguish "no such account" from "wrong password".
  if (!parsed.success) {
    return { error: 'invalid' };
  }

  try {
    const result = await auth.api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password },
    });
    if (!result?.user) {
      return { error: 'invalid' };
    }
  } catch {
    return { error: 'invalid' };
  }

  redirect('/');
}
