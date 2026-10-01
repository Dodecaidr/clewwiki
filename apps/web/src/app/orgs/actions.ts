'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { rememberOrganization } from '@/lib/orgs/cookie';
import { OrgError, createOrganization } from '@/lib/orgs/service';
import type { OrgErrorCode } from '@/lib/orgs/service';
import { getSignedInUser } from '@/lib/session';
import { getMembership } from '@/lib/workspace';

export async function switchOrganizationAction(formData: FormData): Promise<void> {
  const user = await getSignedInUser();
  if (!user) redirect('/login');
  const workspaceId = z.uuid().safeParse(formData.get('workspaceId'));
  if (!workspaceId.success) return;
  // Only an organization the account is in can be switched to.
  if (!(await getMembership(user.id, workspaceId.data))) return;
  await rememberOrganization(workspaceId.data);
  redirect('/');
}

export interface CreateOrgState {
  error?: OrgErrorCode | 'generic';
}

export async function createOrganizationAction(
  _previous: CreateOrgState,
  formData: FormData,
): Promise<CreateOrgState> {
  const user = await getSignedInUser();
  if (!user) return { error: 'forbidden' };
  let created: { id: string };
  try {
    created = await createOrganization({
      creatorId: user.id,
      name: String(formData.get('name') ?? ''),
      slug: String(formData.get('slug') ?? ''),
    });
  } catch (error) {
    if (error instanceof OrgError) return { error: error.code };
    console.error('[orgs] an organization could not be created', error);
    return { error: 'generic' };
  }
  await rememberOrganization(created.id);
  revalidatePath('/', 'layout');
  redirect('/settings/members');
}
