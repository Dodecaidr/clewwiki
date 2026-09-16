import 'server-only';

import { and, eq } from 'drizzle-orm';
import { memberships, users, workspaces } from '@clewwiki/db';
import type { MembershipRole, Workspace } from '@clewwiki/db';

import { getDatabase } from './db';

/** Slug of the single workspace v1 seeds during first-run setup. */
export const DEFAULT_WORKSPACE_SLUG = 'default';

export class WorkspaceScopeError extends Error {
  constructor(message = 'Resource does not belong to the caller workspace') {
    super(message);
    this.name = 'WorkspaceScopeError';
  }
}

export async function getWorkspaceById(workspaceId: string): Promise<Workspace | null> {
  const db = getDatabase();
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row ?? null;
}

export async function getDefaultWorkspace(): Promise<Workspace | null> {
  const db = getDatabase();
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, DEFAULT_WORKSPACE_SLUG))
    .limit(1);
  return row ?? null;
}

export interface MembershipRecord {
  workspaceId: string;
  role: MembershipRole;
}

export async function getMembershipForUser(userId: string): Promise<MembershipRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function getMembership(
  userId: string,
  workspaceId: string,
): Promise<MembershipRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** True when at least one human account exists. Drives the first-run flow. */
export async function hasAnyUser(): Promise<boolean> {
  const db = getDatabase();
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  return row !== undefined;
}

/**
 * The single explicit workspace-scoping check every handler must go through.
 *
 * It is written as a function call rather than an assumption about there being
 * one workspace, so that reading a resource from another workspace fails the
 * same way today as it will once more than one workspace exists.
 */
export function assertSameWorkspace(callerWorkspaceId: string, resourceWorkspaceId: string): void {
  if (callerWorkspaceId !== resourceWorkspaceId) {
    throw new WorkspaceScopeError();
  }
}

export function isSameWorkspace(callerWorkspaceId: string, resourceWorkspaceId: string): boolean {
  return callerWorkspaceId === resourceWorkspaceId;
}
