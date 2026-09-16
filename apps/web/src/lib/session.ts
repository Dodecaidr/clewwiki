import 'server-only';

import { headers } from 'next/headers';
import type { MembershipRole, Workspace } from '@clewwiki/db';

import { auth } from './auth';
import { getMembershipForUser, getWorkspaceById } from './workspace';

export interface SessionContext {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
  workspace: Workspace;
}

/**
 * Session plus workspace membership, resolved from the request cookies.
 *
 * Every page that renders workspace data calls this rather than reading the
 * session alone: a signed-in account with no membership has no workspace to
 * show, and that distinction has to be visible to the caller.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  const membership = await getMembershipForUser(session.user.id);
  if (!membership) return null;

  const workspace = await getWorkspaceById(membership.workspaceId);
  if (!workspace) return null;

  return {
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: membership.role,
    workspace,
  };
}
