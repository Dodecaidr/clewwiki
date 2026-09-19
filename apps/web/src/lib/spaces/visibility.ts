import 'server-only';

import { and, asc, eq, inArray } from 'drizzle-orm';
import { memberships, spaceMembers, spaces, users } from '@clewwiki/db';
import type { MembershipRole } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import type { DbExecutor } from '../db';
import { PageServiceError } from '../pages/errors';
import { getPageById } from '../pages/service';
import type { PageRecord } from '../pages/service';
import { getSpaceById, getSpaceByKey, listSpaces } from './service';
import type { SpaceRecord } from './service';

/**
 * Restricted spaces: who can see what.
 *
 * A space is open to its whole workspace unless it is *restricted*; then it is
 * visible to its members and to workspace administrators, and to everybody
 * else it does not exist — `404`, exactly as a space in another workspace is,
 * so that a refusal never confirms there was something to refuse.
 *
 * **One representation for people and tokens.** An agent token limited to some
 * spaces already carries an allowlist (`spaceIds`), and every REST handler
 * already checks a resource's space against it. A person's visibility is
 * computed into the same shape: `null` when nothing is hidden from them, the
 * list of spaces they can see otherwise. The handlers did not have to learn
 * about people; the identity did.
 *
 * **Visibility, not roles.** A member of a restricted space can do there what
 * their workspace role lets them do anywhere. Read-only membership would have
 * to be enforced on every write path in the product, one by one; visibility is
 * enforced where a space or a page is looked up, which is a place every path
 * already goes through.
 *
 * **Administrators see everything.** They issue tokens, and a token with no
 * space list reaches every space; hiding a space from the people who can mint a
 * key to it would be theatre. It also means a restricted space can never lose
 * its last person who is able to manage it.
 */

/** Anything that can be asked "may you see this space?": an API identity, or a signed-in person. */
export interface Viewer {
  workspaceId: string;
  /** The spaces this viewer can see, or `null` for every space of the workspace. */
  spaceIds: string[] | null;
}

export function canView(viewer: Viewer, spaceId: string): boolean {
  return viewer.spaceIds === null || viewer.spaceIds.includes(spaceId);
}

/**
 * The spaces of a workspace a person can see, as an allowlist — or `null` when
 * nothing is hidden from them, which is the common case and costs one query.
 */
export async function visibleSpaceIdsForUser(
  workspaceId: string,
  userId: string,
  role: MembershipRole,
  executor: DbExecutor = getDatabase(),
): Promise<string[] | null> {
  if (role === 'admin') return null;

  const restricted = await executor
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.restricted, true)));
  if (restricted.length === 0) return null;

  const member = await executor
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.workspaceId, workspaceId), eq(spaceMembers.userId, userId)));
  const memberOf = new Set(member.map((row) => row.spaceId));
  const hidden = restricted.filter((row) => !memberOf.has(row.id));
  if (hidden.length === 0) return null;

  const hiddenIds = new Set(hidden.map((row) => row.id));
  const all = await executor
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.workspaceId, workspaceId));
  return all.map((row) => row.id).filter((id) => !hiddenIds.has(id));
}

/* ------------------------------------------------------------------ */
/* Lookups for the interface                                           */
/* ------------------------------------------------------------------ */

/**
 * The lookups a page or a server action uses instead of the service's own. They
 * answer `null` for a space the viewer cannot see, and for a page in one, which
 * a caller already treats as "not found" — so a hidden space falls out of every
 * page and every action the same way a missing one does.
 *
 * `tests/space-visibility-guard.test.ts` fails if interface code calls the
 * unguarded lookups directly.
 */
export async function findSpaceByKey(viewer: Viewer, key: string): Promise<SpaceRecord | null> {
  const space = await getSpaceByKey(viewer.workspaceId, key);
  return space && canView(viewer, space.id) ? space : null;
}

export async function findSpaceById(viewer: Viewer, spaceId: string): Promise<SpaceRecord | null> {
  if (!canView(viewer, spaceId)) return null;
  return getSpaceById(viewer.workspaceId, spaceId);
}

export async function findPage(viewer: Viewer, pageId: string): Promise<PageRecord | null> {
  const page = await getPageById(viewer.workspaceId, pageId);
  return page && canView(viewer, page.spaceId) ? page : null;
}

/** The spaces a viewer can see, archived ones left out unless asked for. */
export async function findSpaces(
  viewer: Viewer,
  options: { includeArchived?: boolean } = {},
): Promise<SpaceRecord[]> {
  return listSpaces(viewer.workspaceId, {
    includeArchived: options.includeArchived,
    spaceIds: viewer.spaceIds,
  });
}

/**
 * Ends the live editing sessions of a space after who may see it has changed.
 *
 * Imported on demand: the session module sits above the page service, which
 * this module sits beside, and a static import would tie the two in a knot for
 * the sake of a call that happens when an administrator presses a button.
 */
export async function endLiveSessions(spaceId: string): Promise<void> {
  const { closeRoomsInSpace } = await import('../collab/rooms');
  await closeRoomsInSpace(spaceId);
}

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

export interface SpaceMember {
  userId: string;
  name: string;
  email: string;
  /** Their role in the workspace. Administrators see the space with or without a row. */
  workspaceRole: MembershipRole;
  addedAt: Date;
}

/** Everybody in the workspace, for the picker: members of the space first told apart by the caller. */
export async function listWorkspacePeople(
  workspaceId: string,
): Promise<Array<{ userId: string; name: string; email: string; workspaceRole: MembershipRole }>> {
  return getDatabase()
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      workspaceRole: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(users.name), asc(users.id));
}

export async function listSpaceMembers(workspaceId: string, spaceId: string): Promise<SpaceMember[]> {
  return getDatabase()
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      workspaceRole: memberships.role,
      addedAt: spaceMembers.createdAt,
    })
    .from(spaceMembers)
    .innerJoin(users, eq(users.id, spaceMembers.userId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, spaceMembers.userId), eq(memberships.workspaceId, workspaceId)),
    )
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.workspaceId, workspaceId)))
    .orderBy(asc(users.name), asc(users.id));
}

export interface SetSpaceMembersInput {
  workspaceId: string;
  spaceId: string;
  actor: { type: 'user'; id: string };
  /** The complete list. Given whole, so that the form and the row set cannot disagree. */
  userIds: string[];
}

/** Most members one space lists. A space for more people than this is an open space. */
export const MAX_SPACE_MEMBERS = 500;

/**
 * Replaces the members of a space. Only people of this workspace can be listed;
 * an id from anywhere else is refused rather than dropped, so a mistake in a
 * request is reported instead of silently hiding the space from somebody.
 */
export async function setSpaceMembers(input: SetSpaceMembersInput): Promise<SpaceMember[]> {
  const wanted = [...new Set(input.userIds)];
  if (wanted.length > MAX_SPACE_MEMBERS) {
    throw new PageServiceError('validation', `A space lists at most ${MAX_SPACE_MEMBERS} members`, {
      max_members: MAX_SPACE_MEMBERS,
    });
  }

  await getDatabase().transaction(async (tx) => {
    const [space] = await tx
      .select({ id: spaces.id, key: spaces.key })
      .from(spaces)
      .where(and(eq(spaces.id, input.spaceId), eq(spaces.workspaceId, input.workspaceId)))
      .limit(1)
      .for('update');
    if (!space) throw new PageServiceError('not_found', 'Space not found');

    if (wanted.length > 0) {
      const known = await tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, input.workspaceId), inArray(memberships.userId, wanted)));
      const knownIds = new Set(known.map((row) => row.userId));
      const unknown = wanted.filter((id) => !knownIds.has(id));
      if (unknown.length > 0) {
        throw new PageServiceError('validation', 'Only people of this workspace can be members of a space', {
          unknown_user_ids: unknown,
        });
      }
    }

    const current = await tx
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(eq(spaceMembers.spaceId, space.id));
    const currentIds = new Set(current.map((row) => row.userId));
    const added = wanted.filter((id) => !currentIds.has(id));
    const removed = [...currentIds].filter((id) => !wanted.includes(id));
    if (added.length === 0 && removed.length === 0) return;

    if (removed.length > 0) {
      await tx
        .delete(spaceMembers)
        .where(and(eq(spaceMembers.spaceId, space.id), inArray(spaceMembers.userId, removed)));
    }
    if (added.length > 0) {
      await tx.insert(spaceMembers).values(
        added.map((userId) => ({
          spaceId: space.id,
          userId,
          workspaceId: input.workspaceId,
          addedBy: input.actor.id,
        })),
      );
    }

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.actor.id,
        action: 'space.members_changed',
        target: space.id,
        metadata: { key: space.key, added, removed },
      },
      tx,
    );
  });

  await endLiveSessions(input.spaceId);
  return listSpaceMembers(input.workspaceId, input.spaceId);
}
