'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { getAuthBaseUrl } from '@/lib/env';
import { createPasswordReset } from '@/lib/members/account';
import { MemberError, changeMemberRole, createInvitation, removeMember, revokeInvitation } from '@/lib/members/service';
import type { MemberErrorCode } from '@/lib/members/service';
import { getSessionContext } from '@/lib/session';

export interface MembersFormState {
  error?: MemberErrorCode;
  /** Present exactly once, right after an invitation is made. */
  inviteLink?: string;
  invitedEmail?: string;
  /** Present exactly once, right after a reset link is made. */
  resetLink?: string;
}

const inviteSchema = z.object({ email: z.string().trim().min(3).max(254), role: z.enum(['admin', 'editor', 'viewer']) });
const roleSchema = z.object({ userId: z.string().min(1).max(200), role: z.enum(['admin', 'editor', 'viewer']) });

/**
 * Authorisation is re-checked in every action. The page hides these forms from
 * anybody who is not an administrator; that is an affordance, and this is the
 * control.
 */
async function requireAdmin() {
  const session = await getSessionContext();
  return session && session.role === 'admin' ? session : null;
}

function failure(error: unknown): MembersFormState {
  if (error instanceof MemberError) return { error: error.code };
  console.error('[members] action failed', error);
  return { error: 'generic' };
}

export async function inviteMemberAction(_previous: MembersFormState, formData: FormData): Promise<MembersFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const parsed = inviteSchema.safeParse({ email: formData.get('email'), role: formData.get('role') });
  if (!parsed.success) return { error: 'email' };

  try {
    const { invitation, token } = await createInvitation({
      workspaceId: session.workspace.id,
      admin: { id: session.userId },
      email: parsed.data.email,
      role: parsed.data.role,
    });
    revalidatePath('/settings/members');
    return { inviteLink: `${getAuthBaseUrl().replace(/\/+$/, '')}/join/${token}`, invitedEmail: invitation.email };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeInvitationAction(_previous: MembersFormState, formData: FormData): Promise<MembersFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const invitationId = z.uuid().safeParse(formData.get('invitationId'));
  if (!invitationId.success) return { error: 'notFound' };
  try {
    await revokeInvitation({
      workspaceId: session.workspace.id,
      admin: { id: session.userId },
      invitationId: invitationId.data,
    });
    revalidatePath('/settings/members');
    return {};
  } catch (error) {
    return failure(error);
  }
}

export async function changeRoleAction(_previous: MembersFormState, formData: FormData): Promise<MembersFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const parsed = roleSchema.safeParse({ userId: formData.get('userId'), role: formData.get('role') });
  if (!parsed.success) return { error: 'notFound' };
  try {
    await changeMemberRole({ workspaceId: session.workspace.id, admin: { id: session.userId }, ...parsed.data });
    revalidatePath('/', 'layout');
    return {};
  } catch (error) {
    return failure(error);
  }
}

export async function removeMemberAction(_previous: MembersFormState, formData: FormData): Promise<MembersFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const userId = z.string().min(1).max(200).safeParse(formData.get('userId'));
  if (!userId.success) return { error: 'notFound' };
  try {
    await removeMember({ workspaceId: session.workspace.id, admin: { id: session.userId }, userId: userId.data });
    revalidatePath('/', 'layout');
    return {};
  } catch (error) {
    return failure(error);
  }
}

export async function createResetLinkAction(_previous: MembersFormState, formData: FormData): Promise<MembersFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const userId = z.string().min(1).max(200).safeParse(formData.get('userId'));
  if (!userId.success) return { error: 'notFound' };
  try {
    const { token } = await createPasswordReset({
      workspaceId: session.workspace.id,
      admin: { id: session.userId },
      userId: userId.data,
    });
    return { resetLink: `${getAuthBaseUrl().replace(/\/+$/, '')}/reset/${token}` };
  } catch (error) {
    return failure(error);
  }
}
