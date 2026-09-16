'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { workspaces } from '@clewwiki/db';

import { recordAudit } from '@/lib/audit';
import { getDatabase } from '@/lib/db';
import { probeRepository } from '@/lib/repository/git';
import { repositorySettingsSchema } from '@/lib/repository/settings';
import { getSessionContext } from '@/lib/session';

/**
 * The workspace's repository setting, edited by an administrator.
 *
 * Linking a repository decides what every anchor in the workspace is checked
 * against, so it is a human role check rather than a scope: an agent token
 * carries scopes but no role, and no scope set makes it an administrator.
 */

export interface RepositoryFormState {
  saved?: boolean;
  error?: string;
  message?: string;
  probe?: { ok: boolean; refs?: number; commit?: string; error?: string };
}

function readForm(formData: FormData) {
  return {
    url: String(formData.get('url') ?? ''),
    default_ref: String(formData.get('default_ref') ?? ''),
    auth_token_env: String(formData.get('auth_token_env') ?? '').trim() || undefined,
  };
}

export async function saveRepositoryAction(
  _previous: RepositoryFormState,
  formData: FormData,
): Promise<RepositoryFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };
  if (session.role !== 'admin') return { error: 'forbidden' };

  const parsed = repositorySettingsSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  const db = getDatabase();
  await db
    .update(workspaces)
    .set({ settings: { ...session.workspace.settings, repository: parsed.data } })
    .where(eq(workspaces.id, session.workspace.id));

  await recordAudit({
    workspaceId: session.workspace.id,
    actorType: 'user',
    actorId: session.userId,
    action: 'workspace.repository_set',
    target: session.workspace.id,
    // The URL and the *name* of the token variable; never a credential.
    metadata: {
      url: parsed.data.url,
      default_ref: parsed.data.default_ref,
      auth_token_env: parsed.data.auth_token_env ?? null,
    },
  });

  revalidatePath('/settings/repository');
  revalidatePath('/pages');
  return { saved: true };
}

/**
 * Checks the URL, the ref and the token without cloning anything.
 *
 * `ls-remote` needs no disk, so an administrator finds out that a token is
 * missing here rather than from a failed check on somebody else's page.
 */
export async function testRepositoryAction(
  _previous: RepositoryFormState,
  formData: FormData,
): Promise<RepositoryFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };
  if (session.role !== 'admin') return { error: 'forbidden' };

  const parsed = repositorySettingsSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  const probe = await probeRepository(parsed.data);
  return { probe };
}
