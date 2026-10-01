import 'server-only';

import { and, asc, count, eq, sql } from 'drizzle-orm';
import { accessRequests, memberships, users, workspaces } from '@clewwiki/db';
import type { MembershipRole, Workspace } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { auth } from '../auth';
import { getDatabase } from '../db';
import { normalizeEmail } from '../members/service';
import { TokenBucketRateLimiter } from '../rate-limit';

/**
 * Asking to join an organization, and an administrator's answer.
 *
 * Off by default: an organization opens the form in its member settings, and
 * even then nobody gets in on their own — every request waits for an
 * administrator, who picks the role. The account is created when the person
 * asks, holding the password they chose, so approval needs nothing more from
 * them; until then it signs in to a page that says it is waiting.
 *
 * The address is NOT marked verified (unlike an invitation, where an
 * administrator typed it): nobody vouched for it, and a verified address is
 * what lets single sign-on link a provider identity into an existing account.
 */

export type RegistrationMode = 'off' | 'approval';

export function readRegistrationMode(workspace: Pick<Workspace, 'settings'>): RegistrationMode {
  return workspace.settings.registration === 'approval' ? 'approval' : 'off';
}

export type AccessErrorCode =
  | 'closed'
  | 'email'
  | 'emailTaken'
  | 'password'
  | 'name'
  | 'alreadyMember'
  | 'alreadyRequested'
  | 'notFound'
  | 'rateLimited'
  | 'generic';

export class AccessError extends Error {
  constructor(readonly code: AccessErrorCode) {
    super(code);
    this.name = 'AccessError';
  }
}

declare global {
  var __clewwikiAccessRequests: TokenBucketRateLimiter | undefined;
}

/** Five requests an hour per client address: enough for a person, not for a script. */
function limiter(): TokenBucketRateLimiter {
  globalThis.__clewwikiAccessRequests ??= new TokenBucketRateLimiter(5, 60 * 60);
  return globalThis.__clewwikiAccessRequests;
}

/** Tests only. */
export function resetAccessRequestLimit(): void {
  globalThis.__clewwikiAccessRequests = undefined;
}

export async function setRegistrationMode(input: {
  workspaceId: string;
  adminId: string;
  mode: RegistrationMode;
}): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({ settings: sql`${workspaces.settings} || ${JSON.stringify({ registration: input.mode })}::jsonb` })
      .where(eq(workspaces.id, input.workspaceId));
    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.adminId,
        action: 'workspace.registration_changed',
        target: input.workspaceId,
        metadata: { mode: input.mode },
      },
      tx,
    );
  });
}

export type RequestAccessInput =
  | {
      workspace: Workspace;
      client: string;
      message: string;
      /** A signed-in account asking to join one more organization. */
      existingUserId: string;
    }
  | {
      workspace: Workspace;
      client: string;
      message: string;
      existingUserId?: undefined;
      name: string;
      email: string;
      password: string;
    };

function cleanMessage(raw: string): string {
  return raw.trim().slice(0, 1000);
}

export async function requestAccess(input: RequestAccessInput): Promise<{ userId: string }> {
  if (readRegistrationMode(input.workspace) !== 'approval') throw new AccessError('closed');
  if (!limiter().consume(input.client).allowed) throw new AccessError('rateLimited');
  const db = getDatabase();
  const message = cleanMessage(input.message);

  if (input.existingUserId !== undefined) {
    const userId = input.existingUserId;
    const [member] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, input.workspace.id), eq(memberships.userId, userId)))
      .limit(1);
    if (member) throw new AccessError('alreadyMember');
    await insertRequest(input.workspace.id, userId, message);
    return { userId };
  }

  const name = input.name.trim();
  if (name === '' || name.length > 100) throw new AccessError('name');
  if (input.password.length < 12 || input.password.length > 256) throw new AccessError('password');
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch {
    throw new AccessError('email');
  }
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  // An existing account signs in and asks from there, so the password it has
  // stays the only one; the form says so.
  if (taken) throw new AccessError('emailTaken');

  let userId: string;
  try {
    const signUp = await auth.api.signUpEmail({ body: { email, password: input.password, name } });
    if (!signUp?.user) throw new Error('sign-up returned no user');
    userId = signUp.user.id;
  } catch (error) {
    console.error('[access] the account of a person asking to join could not be created', error);
    throw new AccessError('generic');
  }
  try {
    await insertRequest(input.workspace.id, userId, message);
  } catch (error) {
    await db.delete(users).where(eq(users.id, userId));
    throw error;
  }
  return { userId };
}

async function insertRequest(workspaceId: string, userId: string, message: string): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const [row] = await tx
      .insert(accessRequests)
      .values({ workspaceId, userId, message })
      .onConflictDoNothing()
      .returning({ id: accessRequests.id });
    if (!row) throw new AccessError('alreadyRequested');
    await recordAudit(
      {
        workspaceId,
        actorType: 'user',
        actorId: userId,
        action: 'access.requested',
        target: row.id,
        metadata: {},
      },
      tx,
    );
  });
}

export interface AccessRequestRecord {
  id: string;
  userId: string;
  name: string;
  email: string;
  message: string;
  createdAt: Date;
}

export async function listPendingAccessRequests(workspaceId: string): Promise<AccessRequestRecord[]> {
  return getDatabase()
    .select({
      id: accessRequests.id,
      userId: accessRequests.userId,
      name: users.name,
      email: users.email,
      message: accessRequests.message,
      createdAt: accessRequests.createdAt,
    })
    .from(accessRequests)
    .innerJoin(users, eq(users.id, accessRequests.userId))
    .where(and(eq(accessRequests.workspaceId, workspaceId), eq(accessRequests.status, 'pending')))
    .orderBy(asc(accessRequests.createdAt));
}

export async function countPendingAccessRequests(workspaceId: string): Promise<number> {
  const [row] = await getDatabase()
    .select({ n: count() })
    .from(accessRequests)
    .where(and(eq(accessRequests.workspaceId, workspaceId), eq(accessRequests.status, 'pending')));
  return Number(row?.n ?? 0);
}

/** What a signed-in account without a membership is waiting for. */
export async function listOwnPendingRequests(userId: string): Promise<Array<{ name: string; createdAt: Date }>> {
  return getDatabase()
    .select({ name: workspaces.name, createdAt: accessRequests.createdAt })
    .from(accessRequests)
    .innerJoin(workspaces, eq(workspaces.id, accessRequests.workspaceId))
    .where(and(eq(accessRequests.userId, userId), eq(accessRequests.status, 'pending')))
    .orderBy(asc(accessRequests.createdAt));
}

export async function decideAccessRequest(input: {
  workspaceId: string;
  adminId: string;
  requestId: string;
  decision: { approve: true; role: MembershipRole } | { approve: false };
}): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const [request] = await tx
      .select({ id: accessRequests.id, userId: accessRequests.userId })
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.id, input.requestId),
          eq(accessRequests.workspaceId, input.workspaceId),
          eq(accessRequests.status, 'pending'),
        ),
      )
      .for('update')
      .limit(1);
    if (!request) throw new AccessError('notFound');

    const now = new Date();
    if (input.decision.approve) {
      await tx
        .insert(memberships)
        .values({ workspaceId: input.workspaceId, userId: request.userId, role: input.decision.role })
        .onConflictDoNothing();
    }
    await tx
      .update(accessRequests)
      .set({
        status: input.decision.approve ? 'approved' : 'rejected',
        role: input.decision.approve ? input.decision.role : null,
        decidedAt: now,
        decidedBy: input.adminId,
      })
      .where(eq(accessRequests.id, request.id));
    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.adminId,
        action: input.decision.approve ? 'access.approved' : 'access.rejected',
        target: request.userId,
        metadata: input.decision.approve ? { role: input.decision.role } : {},
      },
      tx,
    );

    if (!input.decision.approve) {
      // An account made only to ask, and refused everywhere it asked, is
      // deleted: it would otherwise hold its address and password forever.
      const [membership] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.userId, request.userId))
        .limit(1);
      const [stillPending] = await tx
        .select({ id: accessRequests.id })
        .from(accessRequests)
        .where(and(eq(accessRequests.userId, request.userId), eq(accessRequests.status, 'pending')))
        .limit(1);
      if (!membership && !stillPending) {
        await tx.delete(users).where(eq(users.id, request.userId));
      }
    }
  });
}
