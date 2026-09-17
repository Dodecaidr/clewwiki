'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { completeSetup } from '@/lib/setup';

export interface SetupFormState {
  error?: 'generic' | 'alreadyDone' | 'validation' | 'setupToken';
  fieldErrors?: Record<string, string[]>;
}

const setupSchema = z.object({
  setupToken: z.string().trim().min(1).max(512),
  workspaceName: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(320),
  password: z.string().min(12).max(256),
});

/** First-run setup. The rules live in `lib/setup.ts`; this is the form's edge. */
export async function completeSetupAction(
  _prevState: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const parsed = setupSchema.safeParse({
    setupToken: formData.get('setupToken') ?? '',
    workspaceName: formData.get('workspaceName'),
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    if (fieldErrors.setupToken) return { error: 'setupToken' };
    return { error: 'validation', fieldErrors };
  }

  const outcome = await completeSetup(parsed.data);
  if (!outcome.ok) {
    return { error: outcome.error };
  }

  redirect('/login');
}
