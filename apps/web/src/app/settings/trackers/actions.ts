'use server';

import { revalidatePath } from 'next/cache';

import { getSessionContext } from '@/lib/session';
import { addTracker, removeTracker } from '@/lib/trackers/admin';
import { TrackerSettingsError } from '@/lib/trackers/settings';

export interface TrackerFormState {
  error?: string;
  ok?: boolean;
}

/** Re-checked in every action; the page hides the forms from anybody else. */
async function requireAdmin() {
  const session = await getSessionContext();
  return session && session.role === 'admin' ? session : null;
}

export async function addTrackerAction(_previous: TrackerFormState, formData: FormData): Promise<TrackerFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };
  try {
    await addTracker(session.workspace.id, session.userId, {
      kind: String(formData.get('kind') ?? ''),
      name: String(formData.get('name') ?? ''),
      baseUrl: String(formData.get('baseUrl') ?? ''),
      projects: String(formData.get('projects') ?? ''),
      urlTemplate: String(formData.get('urlTemplate') ?? ''),
      tokenEnv: String(formData.get('tokenEnv') ?? ''),
    });
  } catch (error) {
    if (error instanceof TrackerSettingsError) return { error: error.field };
    console.error('[trackers] adding a tracker failed', error);
    return { error: 'generic' };
  }
  revalidatePath('/settings/trackers');
  return { ok: true };
}

export async function removeTrackerAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  if (!session) return;
  const id = String(formData.get('trackerId') ?? '');
  if (!/^[0-9a-f]{12}$/.test(id)) return;
  await removeTracker(session.workspace.id, session.userId, id);
  revalidatePath('/settings/trackers');
}
