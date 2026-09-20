import 'server-only';

import { randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { memberships, passwordResets, users } from '@clewwiki/db';

import { hashTokenSecret, secureCompareHash } from '../agent-token-crypto';
import { recordAudit } from '../audit';
import { auth } from '../auth';
import { getDatabase } from '../db';
import { TokenBucketRateLimiter } from '../rate-limit';
import { MemberError } from './service';
import type { Admin } from './service';

/**
 * What a member can do about their own account, and what an administrator can
 * do when somebody has lost theirs.
 *
 * A person changes their own name, and their own password by giving the current
 * one. Changing the password signs every other session out: whoever changes a
 * password because they think somebody else has it means exactly that.
 *
 * A *forgotten* password cannot be self-service here. Every "forgot password"
 * flow proves who is asking by sending something somewhere, and this product
 * sends nothing. So the proof is an administrator: they make a reset link for
 * a member and hand it over, as they do an invitation. It is built the same way
 * — shown once, stored as a hash, good once — and lives for a day. Using it
 * sets the password and signs every session of that account out; it does not
 * sign the visitor in, so the new password is proven by using it.
 *
 * The one account nobody can help is the last administrator's. That is what the
 * operator's access to the database is for, and `docs/deploy.md` says how.
 */

export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;

const TOKEN_LABEL = 'cwr';
const TOKEN_PATTERN = /^cwr_([A-Za-z0-9_-]{6,32})\.([A-Za-z0-9_-]{16,128})$/;

declare global {
  var __clewwikiPasswordChangeLimiter: TokenBucketRateLimiter | undefined;
}

/** Five tries a quarter of an hour: a stolen session does not get to guess the password behind it. */
function passwordChangeLimiter(): TokenBucketRateLimiter {
  globalThis.__clewwikiPasswordChangeLimiter ??= new TokenBucketRateLimiter(5, 15 * 60);
  return globalThis.__clewwikiPasswordChangeLimiter;
}

export function resetPasswordChangeBudget(): void {
  globalThis.__clewwikiPasswordChangeLimiter?.reset();
}

function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) throw new MemberError('password');
}

/* ------------------------------------------------------------------ */
/* One's own account                                                   */
/* ------------------------------------------------------------------ */

export interface OwnAccount {
  workspaceId: string;
  userId: string;
  /** The request's headers: the authentication library reads the session from them. */
  headers: Headers;
}

export async function changeOwnName(account: OwnAccount, rawName: string): Promise<string> {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (name === '' || name.length > 100) throw new MemberError('name');

  await auth.api.updateUser({ body: { name }, headers: account.headers });
  await recordAudit({
    workspaceId: account.workspaceId,
    actorType: 'user',
    actorId: account.userId,
    action: 'account.renamed',
    target: account.userId,
    metadata: {},
  });
  return name;
}

export async function changeOwnPassword(
  account: OwnAccount,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  assertPassword(input.newPassword);
  if (!passwordChangeLimiter().consume(account.userId).allowed) throw new MemberError('rateLimited');

  try {
    await auth.api.changePassword({
      body: { currentPassword: input.currentPassword, newPassword: input.newPassword, revokeOtherSessions: true },
      headers: account.headers,
    });
  } catch {
    // The library's error is not passed on: it is the same answer whatever was wrong.
    throw new MemberError('currentPassword');
  }

  await recordAudit({
    workspaceId: account.workspaceId,
    actorType: 'user',
    actorId: account.userId,
    action: 'account.password_changed',
    target: account.userId,
    metadata: { other_sessions_revoked: true },
  });
}

/* ------------------------------------------------------------------ */
/* A reset link, made by an administrator                              */
/* ------------------------------------------------------------------ */

/** Makes a reset link for a member and returns its token — the only time it is readable. */
export async function createPasswordReset(
  input: { workspaceId: string; admin: Admin; userId: string },
  now: Date = new Date(),
): Promise<{ token: string; name: string; expiresAt: Date }> {
  const prefix = randomBytes(6).toString('base64url');
  const secret = randomBytes(32).toString('base64url');

  return getDatabase().transaction(async (tx) => {
    const [member] = await tx
      .select({ name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, input.workspaceId), eq(memberships.userId, input.userId)))
      .limit(1);
    if (!member) throw new MemberError('notFound');

    // One live link per account.
    await tx
      .update(passwordResets)
      .set({ revokedAt: now })
      .where(and(eq(passwordResets.userId, input.userId), isNull(passwordResets.usedAt), isNull(passwordResets.revokedAt)));

    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
    const [created] = await tx
      .insert(passwordResets)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        prefix,
        tokenHash: hashTokenSecret(secret),
        createdBy: input.admin.id,
        expiresAt,
      })
      .returning({ id: passwordResets.id });
    if (!created) throw new MemberError('generic');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: 'user',
        actorId: input.admin.id,
        action: 'password_reset.created',
        target: input.userId,
        metadata: { reset_id: created.id, expires_at: expiresAt.toISOString() },
      },
      tx,
    );
    return { token: `${TOKEN_LABEL}_${prefix}.${secret}`, name: member.name, expiresAt };
  });
}

export interface OpenPasswordReset {
  id: string;
  workspaceId: string;
  userId: string;
  email: string;
}

/** The reset a link belongs to, when the link still works — one answer for every way it can fail. */
export async function findOpenPasswordReset(token: string, now: Date = new Date()): Promise<OpenPasswordReset | null> {
  const match = TOKEN_PATTERN.exec(token.trim());
  const prefix = match?.[1];
  const secret = match?.[2];
  if (!prefix || !secret) return null;

  const [row] = await getDatabase()
    .select({
      id: passwordResets.id,
      workspaceId: passwordResets.workspaceId,
      userId: passwordResets.userId,
      email: users.email,
      tokenHash: passwordResets.tokenHash,
      expiresAt: passwordResets.expiresAt,
      usedAt: passwordResets.usedAt,
      revokedAt: passwordResets.revokedAt,
    })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(eq(passwordResets.prefix, prefix))
    .limit(1);

  const matches = secureCompareHash(hashTokenSecret(secret), row?.tokenHash ?? hashTokenSecret(''));
  if (!row || !matches) return null;
  if (row.usedAt !== null || row.revokedAt !== null || row.expiresAt <= now) return null;
  return { id: row.id, workspaceId: row.workspaceId, userId: row.userId, email: row.email };
}

/**
 * Sets the password a reset link was made for, and signs that account out
 * everywhere. The link is claimed first, so it sets one password however many
 * times it is submitted.
 */
export async function completePasswordReset(input: { token: string; password: string }): Promise<void> {
  assertPassword(input.password);
  const open = await findOpenPasswordReset(input.token);
  if (!open) throw new MemberError('invalidReset');

  const db = getDatabase();
  const [claimed] = await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResets.id, open.id), isNull(passwordResets.usedAt), isNull(passwordResets.revokedAt)))
    .returning({ id: passwordResets.id });
  if (!claimed) throw new MemberError('invalidReset');

  try {
    const context = await auth.$context;
    await context.internalAdapter.updatePassword(open.userId, await context.password.hash(input.password));
    await context.internalAdapter.deleteUserSessions(open.userId);
  } catch (error) {
    await db.update(passwordResets).set({ usedAt: null }).where(eq(passwordResets.id, open.id));
    console.error('[account] a password reset could not be completed', error);
    throw new MemberError('generic');
  }

  await recordAudit({
    workspaceId: open.workspaceId,
    actorType: 'user',
    actorId: open.userId,
    action: 'password_reset.completed',
    target: open.userId,
    metadata: { reset_id: open.id, sessions_revoked: true },
  });
}
