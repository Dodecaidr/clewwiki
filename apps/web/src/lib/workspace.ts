import 'server-only';

import { and, asc, eq } from 'drizzle-orm';
import { instanceAdmins, memberships, users, workspaces } from '@clewwiki/db';
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

/**
 * The account's first membership — the organization it joined first. Used
 * where no organization was chosen; `getActiveMembership` is what a request
 * with a choice goes through.
 */
export async function getMembershipForUser(userId: string): Promise<MembershipRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(1);
  return row ?? null;
}

/** The cookie holding the id of the organization the reader switched to. */
export const ORG_COOKIE = 'clewwiki-org';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The organization a request works in: the one the reader chose, when they are
 * still a member of it, else the first they joined. The cookie only ever
 * selects among the account's own memberships — a forged or stale value falls
 * back, it never grants anything.
 */
export async function getActiveMembership(
  userId: string,
  chosenWorkspaceId: string | null | undefined,
): Promise<MembershipRecord | null> {
  if (chosenWorkspaceId && UUID.test(chosenWorkspaceId)) {
    const chosen = await getMembership(userId, chosenWorkspaceId);
    if (chosen) return chosen;
  }
  return getMembershipForUser(userId);
}

/** Reads `ORG_COOKIE` out of a raw `Cookie` header, for route handlers. */
export function chosenOrgFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== ORG_COOKIE) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

export interface OrganizationMembership {
  workspaceId: string;
  name: string;
  slug: string;
  role: MembershipRole;
}

/** Every organization the account belongs to, in the order it joined them. */
export async function listMembershipsForUser(userId: string): Promise<OrganizationMembership[]> {
  return getDatabase()
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

export async function isInstanceAdmin(userId: string): Promise<boolean> {
  const [row] = await getDatabase()
    .select({ userId: instanceAdmins.userId })
    .from(instanceAdmins)
    .where(eq(instanceAdmins.userId, userId))
    .limit(1);
  return row !== undefined;
}

export async function getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const [row] = await getDatabase().select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
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
