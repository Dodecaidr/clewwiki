import 'server-only';

import { randomBytes } from 'node:crypto';

import { and, asc, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { invitations, memberships, users } from '@clewwiki/db';
import type { MembershipRole } from '@clewwiki/db';

import { hashTokenSecret, secureCompareHash } from '../agent-token-crypto';
import { recordAudit } from '../audit';
import { auth } from '../auth';
import { getDatabase } from '../db';

/**
 * The people of a workspace: who they are, how they join, how they leave.
 *
 * There is no self-registration and no mail transport, and both are deliberate
 * — so a person joins the way an agent does. An administrator makes an
 * invitation for one e-mail address and one role; what they get back is a link,
 * shown once, which they hand over by whatever channel they already trust. The
 * person who opens it chooses a name and a password, and the account is created
 * then, by the authentication library, server-side. Only the hash of the link's
 * secret is stored, it works once, and it stops working after a week.
 *
 * The rule that shapes the rest: **a workspace always has an administrator.**
 * The last one cannot be demoted or removed, by anybody, themselves included —
 * an instance with no administrator is recoverable only with SQL.
 *
 * Removing a member deletes their account, not only their membership. This is a
 * single-workspace product: an account with no membership can do nothing, would
 * keep its password and its e-mail address reserved forever, and could not be
 * invited again. What they wrote stays, under the name it was written under —
 * authorship is snapshotted on every revision, message and comment.
 */

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OPEN_INVITATIONS = 50;

const TOKEN_LABEL = 'cwi';
const TOKEN_PATTERN = /^cwi_([A-Za-z0-9_-]{6,32})\.([A-Za-z0-9_-]{16,128})$/;

export type MemberErrorCode =
  | 'forbidden'
  | 'email'
  | 'alreadyMember'
  | 'tooMany'
  | 'notFound'
  | 'lastAdmin'
  | 'self'
  | 'invalidInvitation'
  | 'emailTaken'
  | 'password'
  | 'name'
  | 'currentPassword'
  | 'rateLimited'
  | 'invalidReset'
  | 'generic';

export class MemberError extends Error {
  constructor(readonly code: MemberErrorCode) {
    super(code);
    this.name = 'MemberError';
  }
}

export interface MemberRecord {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
  joinedAt: Date;
}

export interface InvitationRecord {
  id: string;
  email: string;
  role: MembershipRole;
  createdAt: Date;
  expiresAt: Date;
  state: 'open' | 'expired';
}

export interface Admin {
  /** A workspace administrator's user id. Every mutation here is theirs alone. */
  id: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new MemberError('email');
  return email;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listMembers(workspaceId: string): Promise<MemberRecord[]> {
  return getDatabase()
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(asc(memberships.createdAt));
}

/** Invitations nobody has used or revoked, newest first. Expired ones are listed, so they can be cleared away. */
export async function listInvitations(workspaceId: string, now: Date = new Date()): Promise<InvitationRecord[]> {
  const rows = await getDatabase()
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(eq(invitations.workspaceId, workspaceId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)),
    )
    .orderBy(desc(invitations.createdAt));
  return rows.map((row) => ({ ...row, state: row.expiresAt > now ? 'open' : 'expired' }));
}

/* ------------------------------------------------------------------ */
/* Inviting                                                            */
/* ------------------------------------------------------------------ */

export interface CreateInvitationInput {
  workspaceId: string;
  admin: Admin;
  email: string;
  role: MembershipRole;
}

/** Makes an invitation and returns its token — the only time the token exists in readable form. */
export async function createInvitation(
  input: CreateInvitationInput,
  now: Date = new Date(),
): Promise<{ invitation: InvitationRecord; token: string }> {
  const email = normalizeEmail(input.email);
  const prefix = randomBytes(6).toString('base64url');
  const secret = randomBytes(32).toString('base64url');

  const invitation = await getDatabase().transaction(async (tx) => {
    const [member] = await tx
      .select({ id: users.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, input.workspaceId), eq(sql`lower(${users.email})`, email)))
      .limit(1);
    if (member) throw new MemberError('alreadyMember');

    // One live link per address: inviting somebody again replaces the link
    // that was sent before, rather than leaving two that work.
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invitations.workspaceId, input.workspaceId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );

    const [open] = await tx
      .select({ total: count() })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, input.workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now),
        ),
      );
    if ((open?.total ?? 0) >= MAX_OPEN_INVITATIONS) throw new MemberError('tooMany');

    const [created] = await tx
      .insert(invitations)
      .values({
        workspaceId: input.workspaceId,
        email,
        role: input.role,
        prefix,
        tokenHash: hashTokenSecret(secret),
        createdBy: input.admin.id,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      })
      .returning({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
      });
    if (!created) throw new MemberError('generic');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.admin.id,
        action: 'invitation.created',
        target: created.id,
        metadata: { email, role: input.role, expires_at: created.expiresAt.toISOString() },
      },
      tx,
    );
    return created;
  });

  return { invitation: { ...invitation, state: 'open' }, token: `${TOKEN_LABEL}_${prefix}.${secret}` };
}

export async function revokeInvitation(input: {
  workspaceId: string;
  admin: Admin;
  invitationId: string;
}): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const [revoked] = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.id, input.invitationId),
          eq(invitations.workspaceId, input.workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id, email: invitations.email });
    if (!revoked) throw new MemberError('notFound');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.admin.id,
        action: 'invitation.revoked',
        target: revoked.id,
        metadata: { email: revoked.email },
      },
      tx,
    );
  });
}

/* ------------------------------------------------------------------ */
/* Accepting                                                           */
/* ------------------------------------------------------------------ */

export interface OpenInvitation {
  id: string;
  workspaceId: string;
  email: string;
  role: MembershipRole;
  expiresAt: Date;
}

/**
 * The invitation a link belongs to, when the link still works. One answer for
 * every way it can fail — malformed, unknown, used, revoked, expired — so that
 * a link says nothing about what it once was.
 */
export async function findOpenInvitation(token: string, now: Date = new Date()): Promise<OpenInvitation | null> {
  const match = TOKEN_PATTERN.exec(token.trim());
  const prefix = match?.[1];
  const secret = match?.[2];
  if (!prefix || !secret) return null;

  const [row] = await getDatabase()
    .select({
      id: invitations.id,
      workspaceId: invitations.workspaceId,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      tokenHash: invitations.tokenHash,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
    })
    .from(invitations)
    .where(eq(invitations.prefix, prefix))
    .limit(1);

  // Hashed and compared even when there is no row, so that an unknown prefix
  // and a wrong secret take the same time.
  const matches = secureCompareHash(hashTokenSecret(secret), row?.tokenHash ?? hashTokenSecret(''));
  if (!row || !matches) return null;
  if (row.acceptedAt !== null || row.revokedAt !== null || row.expiresAt <= now) return null;
  return { id: row.id, workspaceId: row.workspaceId, email: row.email, role: row.role, expiresAt: row.expiresAt };
}

export interface AcceptInvitationInput {
  token: string;
  name: string;
  password: string;
}

/**
 * Creates the invited person's account and makes them a member.
 *
 * The invitation is claimed first, in its own statement, so that a link opened
 * twice at once makes one account: the second claim finds nothing to claim. The
 * account is created by the authentication library, which owns that write; if
 * the membership cannot be written after it, the account is deleted again and
 * the invitation is handed back, the same undo `/setup` performs.
 */
export async function acceptInvitation(input: AcceptInvitationInput): Promise<{ userId: string; workspaceId: string }> {
  const name = input.name.trim();
  if (name === '' || name.length > 100) throw new MemberError('generic');
  if (input.password.length < 12 || input.password.length > 256) throw new MemberError('password');

  const open = await findOpenInvitation(input.token);
  if (!open) throw new MemberError('invalidInvitation');

  const db = getDatabase();
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, open.email))
    .limit(1);
  if (taken) throw new MemberError('emailTaken');

  const [claimed] = await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(and(eq(invitations.id, open.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id });
  if (!claimed) throw new MemberError('invalidInvitation');

  const release = (): Promise<unknown> =>
    db.update(invitations).set({ acceptedAt: null }).where(eq(invitations.id, open.id));

  let userId: string;
  try {
    const signUp = await auth.api.signUpEmail({ body: { email: open.email, password: input.password, name } });
    if (!signUp?.user) throw new Error('sign-up returned no user');
    userId = signUp.user.id;
  } catch (error) {
    await release();
    console.error('[members] the account of an invited person could not be created', error);
    throw new MemberError('generic');
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ workspaceId: open.workspaceId, userId, role: open.role });
      await tx.update(invitations).set({ acceptedUserId: userId }).where(eq(invitations.id, open.id));
      await recordAudit(
        {
          workspaceId: open.workspaceId,
          actorType: 'user',
          actorId: userId,
          action: 'member.joined',
          target: userId,
          metadata: { invitation_id: open.id, role: open.role },
        },
        tx,
      );
    });
  } catch (error) {
    console.error('[members] joining failed after the account was created; removing it', error);
    await db.delete(users).where(eq(users.id, userId));
    await release();
    throw new MemberError('generic');
  }

  return { userId, workspaceId: open.workspaceId };
}

/* ------------------------------------------------------------------ */
/* Roles and removal                                                   */
/* ------------------------------------------------------------------ */

/**
 * Locks the workspace's memberships and says how many administrators there are,
 * so "is this the last one?" and the change that depends on it are one decision.
 */
async function lockAndCountAdmins(
  tx: Parameters<Parameters<ReturnType<typeof getDatabase>['transaction']>[0]>[0],
  workspaceId: string,
): Promise<number> {
  const rows = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(eq(memberships.workspaceId, workspaceId))
    .for('update');
  return rows.filter((row) => row.role === 'admin').length;
}

export async function changeMemberRole(input: {
  workspaceId: string;
  admin: Admin;
  userId: string;
  role: MembershipRole;
}): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const admins = await lockAndCountAdmins(tx, input.workspaceId);
    const [current] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)))
      .limit(1);
    if (!current) throw new MemberError('notFound');
    if (current.role === input.role) return;
    if (current.role === 'admin' && admins <= 1) throw new MemberError('lastAdmin');

    await tx
      .update(memberships)
      .set({ role: input.role })
      .where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)));
    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.admin.id,
        action: 'member.role_changed',
        target: input.userId,
        metadata: { from: current.role, to: input.role },
      },
      tx,
    );
  });
}

export async function removeMember(input: { workspaceId: string; admin: Admin; userId: string }): Promise<void> {
  // Leaving is not something an administrator does to themselves by a slip of
  // the mouse: another administrator removes them, or they are demoted first.
  if (input.userId === input.admin.id) throw new MemberError('self');

  await getDatabase().transaction(async (tx) => {
    const admins = await lockAndCountAdmins(tx, input.workspaceId);
    const [current] = await tx
      .select({ role: memberships.role, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)))
      .limit(1);
    if (!current) throw new MemberError('notFound');
    if (current.role === 'admin' && admins <= 1) throw new MemberError('lastAdmin');

    // The membership, the sessions, the credentials and the space memberships
    // all cascade from the account.
    await tx.delete(users).where(eq(users.id, input.userId));
    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.admin.id,
        action: 'member.removed',
        target: input.userId,
        metadata: { email: current.email, role: current.role },
      },
      tx,
    );
  });
}
