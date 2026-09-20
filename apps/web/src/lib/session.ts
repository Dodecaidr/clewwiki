import { canWrite } from './roles';
import 'server-only';

import { headers } from 'next/headers';
import type { MembershipRole, Workspace } from '@clewwiki/db';

import { auth } from './auth';
import { getMembershipForUser, getWorkspaceById } from './workspace';
import { visibleSpaceIdsForUser } from './spaces/visibility';

export interface SessionContext {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
  workspace: Workspace;
  /** The workspace's id again, so that a session is a `Viewer` as it stands. */
  workspaceId: string;
  /**
   * The spaces this person can see, or `null` for all of them. Pages and server
   * actions look spaces and pages up through `lib/spaces/visibility` with the
   * session as the viewer, which is what makes a restricted space not exist for
   * somebody who is not in it.
   */
  spaceIds: string[] | null;
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
    workspaceId: workspace.id,
    spaceIds: await visibleSpaceIdsForUser(workspace.id, session.user.id, membership.role),
  };
}

/**
 * The session, when it belongs to somebody who may write: `null` for a viewer
 * as for nobody. Server actions that change content ask for this instead of
 * `getSessionContext`, so a viewer's request fails exactly the way an
 * unauthenticated one does — there is no third branch to forget.
 */
export async function getWriterSession(): Promise<SessionContext | null> {
  const session = await getSessionContext();
  return session && canWrite(session.role) ? session : null;
}
