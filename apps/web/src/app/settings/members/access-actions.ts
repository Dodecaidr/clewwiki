'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { AccessError, decideAccessRequest, setRegistrationMode } from '@/lib/orgs/access';
import { getSessionContext } from '@/lib/session';

/** Re-checked here: the page hides these forms from non-administrators, this refuses them. */
async function requireAdmin() {
  const session = await getSessionContext();
  return session && session.role === 'admin' ? session : null;
}

export async function setRegistrationAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  if (!session) return;
  const mode = z.enum(['off', 'approval']).safeParse(formData.get('mode'));
  if (!mode.success) return;
  await setRegistrationMode({ workspaceId: session.workspace.id, adminId: session.userId, mode: mode.data });
  revalidatePath('/settings/members');
}

const decisionSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(['approve', 'reject']),
  role: z.enum(['admin', 'editor', 'viewer']).optional(),
});

export async function decideAccessAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  if (!session) return;
  const parsed = decisionSchema.safeParse({
    requestId: formData.get('requestId'),
    decision: formData.get('decision'),
    role: formData.get('role') ?? undefined,
  });
  if (!parsed.success) return;
  try {
    await decideAccessRequest({
      workspaceId: session.workspace.id,
      adminId: session.userId,
      requestId: parsed.data.requestId,
      decision:
        parsed.data.decision === 'approve'
          ? { approve: true, role: parsed.data.role ?? 'viewer' }
          : { approve: false },
    });
  } catch (error) {
    // Already decided by another administrator: the list below shows the result.
    if (!(error instanceof AccessError)) throw error;
  }
  revalidatePath('/settings/members');
}
