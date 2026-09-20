import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as AccountService from '@/lib/members/account';
import type * as MemberService from '@/lib/members/service';

/**
 * A member's own account, and a lost one, against a real database: the current
 * password is what changes a password, a reset link is good once and for one
 * account, and either way every other session of that account ends.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping account suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

describe.skipIf(!probe.reachable)('own account and password resets', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let account: typeof AccountService;
  let members: typeof MemberService;

  const suiteTag = `ac-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let otherWorkspaceId = '';
  let admin: TestAccount;
  let editor: TestAccount;
  let outsider: TestAccount;

  const code = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
      return 'ok';
    } catch (error) {
      return error instanceof members.MemberError ? error.code : `unexpected: ${String(error)}`;
    }
  };
  const own = (who: TestAccount) => ({ workspaceId, userId: who.userId, headers: new Headers({ cookie: who.cookie }) });
  const sessionsOf = async (userId: string) =>
    (await db.select({ id: schema.sessions.id }).from(schema.sessions).where(drizzle.eq(schema.sessions.userId, userId)))
      .length;
  const canSignIn = async (email: string, password: string): Promise<boolean> => {
    const { auth } = await import('@/lib/auth');
    try {
      const result = await auth.api.signInEmail({ body: { email, password } });
      return Boolean(result.user);
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();
    account = await import('@/lib/members/account');
    members = await import('@/lib/members/service');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Account ${suiteTag}`, slug: `account-${suiteTag}` })
      .returning();
    workspaceId = workspace?.id ?? '';
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `account-other-${suiteTag}` })
      .returning();
    otherWorkspaceId = other?.id ?? '';

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    outsider = await createTestAccount({ db, schema, workspaceId: otherWorkspaceId, role: 'admin', tag: `${suiteTag}-o` });
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, id));
    }
    const ids = [admin?.userId, editor?.userId, outsider?.userId].filter((id): id is string => typeof id === 'string');
    if (ids.length > 0) await db.delete(schema.users).where(drizzle.inArray(schema.users.id, ids));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('renames the person who asks, and nobody else', async () => {
    expect(await account.changeOwnName(own(editor), '  Grace   Hopper ')).toBe('Grace Hopper');
    const [row] = await db.select({ name: schema.users.name }).from(schema.users).where(drizzle.eq(schema.users.id, editor.userId));
    expect(row?.name).toBe('Grace Hopper');
    expect(await code(account.changeOwnName(own(editor), '   '))).toBe('name');
    expect(await code(account.changeOwnName(own(editor), 'x'.repeat(101)))).toBe('name');
  });

  it('changes a password only for whoever knows the current one', async () => {
    account.resetPasswordChangeBudget();
    expect(
      await code(account.changeOwnPassword(own(editor), { currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' })),
    ).toBe('currentPassword');
    expect(
      await code(account.changeOwnPassword(own(editor), { currentPassword: editor.password, newPassword: 'short' })),
    ).toBe('password');
    expect(await canSignIn(editor.email, editor.password)).toBe(true);
  });

  it('signs every other session out when the password changes', async () => {
    account.resetPasswordChangeBudget();
    // `canSignIn` above opened a second session.
    expect(await sessionsOf(editor.userId)).toBeGreaterThan(1);
    await account.changeOwnPassword(own(editor), { currentPassword: editor.password, newPassword: 'a-brand-new-password' });
    expect(await sessionsOf(editor.userId)).toBe(1);
    expect(await canSignIn(editor.email, editor.password)).toBe(false);
    expect(await canSignIn(editor.email, 'a-brand-new-password')).toBe(true);
  });

  it('stops somebody guessing the current password through a session', async () => {
    account.resetPasswordChangeBudget();
    const attempts: string[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      attempts.push(
        await code(account.changeOwnPassword(own(admin), { currentPassword: `guess-number-${attempt}`, newPassword: 'a-brand-new-password' })),
      );
    }
    expect(attempts.slice(0, 5)).toEqual(Array(5).fill('currentPassword'));
    expect(attempts.slice(5)).toEqual(['rateLimited', 'rateLimited']);
    account.resetPasswordChangeBudget();
  });

  it('makes a reset link that is stored as a hash and works once', async () => {
    const { token } = await account.createPasswordReset({ workspaceId, admin: { id: admin.userId }, userId: editor.userId });
    expect(token).toMatch(/^cwr_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const rows = await db.select().from(schema.passwordResets).where(drizzle.eq(schema.passwordResets.userId, editor.userId));
    expect(JSON.stringify(rows)).not.toContain(token.split('.')[1] ?? 'x');

    expect(await account.findOpenPasswordReset(token)).toMatchObject({ userId: editor.userId, email: editor.email });
    expect(await account.findOpenPasswordReset(`${token}x`)).toBeNull();
    expect(await code(account.completePasswordReset({ token, password: 'short' }))).toBe('password');

    await account.completePasswordReset({ token, password: 'chosen-after-the-reset' });
    expect(await sessionsOf(editor.userId)).toBe(0);
    expect(await canSignIn(editor.email, 'a-brand-new-password')).toBe(false);
    expect(await canSignIn(editor.email, 'chosen-after-the-reset')).toBe(true);

    expect(await account.findOpenPasswordReset(token)).toBeNull();
    expect(await code(account.completePasswordReset({ token, password: 'a-second-password-attempt' }))).toBe('invalidReset');
    expect(await canSignIn(editor.email, 'chosen-after-the-reset')).toBe(true);
  });

  it('keeps one live link per account, for a day, inside the workspace', async () => {
    const first = await account.createPasswordReset({ workspaceId, admin: { id: admin.userId }, userId: editor.userId });
    const second = await account.createPasswordReset({ workspaceId, admin: { id: admin.userId }, userId: editor.userId });
    expect(await account.findOpenPasswordReset(first.token)).toBeNull();
    expect(await account.findOpenPasswordReset(second.token)).not.toBeNull();

    const tomorrow = new Date(Date.now() + account.PASSWORD_RESET_TTL_MS + 1000);
    expect(await account.findOpenPasswordReset(second.token, tomorrow)).toBeNull();

    expect(
      await code(account.createPasswordReset({ workspaceId, admin: { id: admin.userId }, userId: outsider.userId })),
    ).toBe('notFound');
  });

  it('sets one password when a link is submitted twice at once', async () => {
    const { token } = await account.createPasswordReset({ workspaceId, admin: { id: admin.userId }, userId: editor.userId });
    const results = await Promise.all([
      code(account.completePasswordReset({ token, password: 'first-of-two-passwords' })),
      code(account.completePasswordReset({ token, password: 'second-of-two-passwords' })),
    ]);
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
    const works = [await canSignIn(editor.email, 'first-of-two-passwords'), await canSignIn(editor.email, 'second-of-two-passwords')];
    expect(works.filter(Boolean)).toHaveLength(1);
  });

  it('writes down who reset whom, never the password', async () => {
    const rows = await db
      .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(drizzle.eq(schema.auditLog.workspaceId, workspaceId));
    const actions = new Set(rows.map((row) => row.action));
    for (const action of ['account.renamed', 'account.password_changed', 'password_reset.created', 'password_reset.completed']) {
      expect(actions, action).toContain(action);
    }
    expect(JSON.stringify(rows)).not.toContain('chosen-after-the-reset');
  });
});
