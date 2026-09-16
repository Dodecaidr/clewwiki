'use server';

import { redirect } from 'next/navigation';
import { withAdvisoryLock } from '@clewwiki/db';
import { memberships, workspaces } from '@clewwiki/db';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import { recordAudit } from '@/lib/audit';
import { getDatabaseHandle } from '@/lib/db';
import { DEFAULT_WORKSPACE_SLUG, hasAnyUser } from '@/lib/workspace';

export interface SetupFormState {
  error?: 'generic' | 'alreadyDone' | 'validation';
  fieldErrors?: Record<string, string[]>;
}

const setupSchema = z.object({
  workspaceName: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(320),
  password: z.string().min(12).max(256),
});

/**
 * Advisory lock key for first-run setup. Any constant works as long as it is
 * stable across processes; this one is arbitrary and unique to this routine.
 */
const SETUP_LOCK_KEY = 0x63_6c_65_77;

/**
 * Creates the administrator account and the single workspace.
 *
 * The whole routine runs while holding a Postgres advisory lock, so two
 * simultaneous first visits cannot both pass the "no users yet" check: the
 * second one blocks, then sees the account the first one created and stops.
 * No account is ever seeded by a migration or fixture — this form is the only
 * way an account comes into existence on a fresh instance.
 */
export async function completeSetupAction(
  _prevState: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const parsed = setupSchema.safeParse({
    workspaceName: formData.get('workspaceName'),
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return { error: 'validation', fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  const { db, sql } = getDatabaseHandle();

  const outcome = await withAdvisoryLock(sql, SETUP_LOCK_KEY, async (): Promise<SetupFormState> => {
    if (await hasAnyUser()) {
      return { error: 'alreadyDone' };
    }

    const [workspace] = await db
      .insert(workspaces)
      .values({ name: parsed.data.workspaceName, slug: DEFAULT_WORKSPACE_SLUG })
      .onConflictDoUpdate({
        target: workspaces.slug,
        set: { name: parsed.data.workspaceName },
      })
      .returning();

    if (!workspace) {
      return { error: 'generic' };
    }

    const signUp = await auth.api.signUpEmail({
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name,
      },
    });

    if (!signUp?.user) {
      return { error: 'generic' };
    }

    await db.insert(memberships).values({
      workspaceId: workspace.id,
      userId: signUp.user.id,
      role: 'admin',
    });

    await recordAudit({
      workspaceId: workspace.id,
      actorType: 'user',
      actorId: signUp.user.id,
      action: 'workspace.initialized',
      target: workspace.id,
      metadata: { workspaceName: workspace.name },
    });

    return {};
  });

  if (outcome.error) {
    return outcome;
  }

  redirect('/login');
}
