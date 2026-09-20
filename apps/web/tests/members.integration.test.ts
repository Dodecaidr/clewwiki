import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as MemberService from '@/lib/members/service';

/**
 * How people join and leave, against a real database: an invitation works once,
 * for one address, until it is revoked or a week has passed; the account it
 * makes can sign in; and a workspace never ends up without an administrator.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping members suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

describe.skipIf(!probe.reachable)('members and invitations', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let members: typeof MemberService;

  const suiteTag = `mb-${randomUUID().slice(0, 8)}`;
  const address = (name: string) => `${name}-${suiteTag}@example.test`;
  let workspaceId = '';
  let admin: TestAccount;
  const created: string[] = [];

  const code = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
      return 'ok';
    } catch (error) {
      return error instanceof members.MemberError ? error.code : `unexpected: ${String(error)}`;
    }
  };

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();
    members = await import('@/lib/members/service');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Members ${suiteTag}`, slug: `members-${suiteTag}` })
      .returning();
    workspaceId = workspace?.id ?? '';
    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    created.push(admin.userId);
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    if (workspaceId) await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    if (created.length > 0) await db.delete(schema.users).where(drizzle.inArray(schema.users.id, created));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  const invite = (email: string, role: 'admin' | 'editor' = 'editor') =>
    members.createInvitation({ workspaceId, admin: { id: admin.userId }, email, role });

  let adaId = '';

  it('stores the hash of an invitation, never the link', async () => {
    const { token, invitation } = await invite(`  ${address('Ada').toUpperCase()} `);
    expect(invitation.email).toBe(address('ada'));
    expect(token).toMatch(/^cwi_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const [row] = await db
      .select({ prefix: schema.invitations.prefix, tokenHash: schema.invitations.tokenHash })
      .from(schema.invitations)
      .where(drizzle.eq(schema.invitations.id, invitation.id));
    const secret = token.split('.')[1] ?? '';
    expect(row?.tokenHash).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(secret);

    expect(await members.findOpenInvitation(token)).toMatchObject({ email: address('ada'), role: 'editor' });
    expect(await members.findOpenInvitation(`${token}x`)).toBeNull();
    expect(await members.findOpenInvitation(token.replace(/\..*$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).toBeNull();
    expect(await members.findOpenInvitation('not a token')).toBeNull();

    // Accept it: an account, a membership, and a link that is now spent.
    expect(await code(members.acceptInvitation({ token, name: 'Ada', password: 'short' }))).toBe('password');
    const joined = await members.acceptInvitation({ token, name: '  Ada Lovelace ', password: 'a-long-enough-password' });
    adaId = joined.userId;
    created.push(adaId);

    const list = await members.listMembers(workspaceId);
    expect(list.map((member) => [member.name, member.email, member.role])).toContainEqual([
      'Ada Lovelace',
      address('ada'),
      'editor',
    ]);
    expect(await members.findOpenInvitation(token)).toBeNull();
    expect(await code(members.acceptInvitation({ token, name: 'Eve', password: 'another-long-password' }))).toBe(
      'invalidInvitation',
    );
  });

  it('lets the invited person sign in with the password they chose', async () => {
    const { auth } = await import('@/lib/auth');
    const signedIn = await auth.api.signInEmail({ body: { email: address('ada'), password: 'a-long-enough-password' } });
    expect(signedIn.user.id).toBe(adaId);
  });

  it('refuses to invite a member, and replaces an earlier link for the same address', async () => {
    expect(await code(invite(address('ada')))).toBe('alreadyMember');
    expect(await code(invite('not-an-address'))).toBe('email');

    const first = await invite(address('grace'));
    const second = await invite(address('grace'), 'admin');
    expect(await members.findOpenInvitation(first.token)).toBeNull();
    expect(await members.findOpenInvitation(second.token)).toMatchObject({ role: 'admin' });
    expect((await members.listInvitations(workspaceId)).map((item) => item.email)).toEqual([address('grace')]);

    await members.revokeInvitation({ workspaceId, admin: { id: admin.userId }, invitationId: second.invitation.id });
    expect(await members.findOpenInvitation(second.token)).toBeNull();
    expect(await members.listInvitations(workspaceId)).toEqual([]);
    expect(
      await code(members.revokeInvitation({ workspaceId, admin: { id: admin.userId }, invitationId: second.invitation.id })),
    ).toBe('notFound');
  });

  it('stops working after a week', async () => {
    const { token } = await invite(address('late'));
    const later = new Date(Date.now() + members.INVITATION_TTL_MS + 1000);
    expect(await members.findOpenInvitation(token, later)).toBeNull();
    expect((await members.listInvitations(workspaceId, later)).map((item) => item.state)).toEqual(['expired']);
  });

  it('makes one account when a link is opened twice at once', async () => {
    const { token } = await invite(address('twice'));
    const results = await Promise.all([
      code(members.acceptInvitation({ token, name: 'First', password: 'a-long-enough-password' })),
      code(members.acceptInvitation({ token, name: 'Second', password: 'a-long-enough-password' })),
    ]);
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(drizzle.eq(schema.users.email, address('twice')));
    expect(rows).toHaveLength(1);
    created.push(...rows.map((row) => row.id));
  });

  it('never leaves a workspace without an administrator', async () => {
    const me = { id: admin.userId };
    expect(await code(members.changeMemberRole({ workspaceId, admin: me, userId: admin.userId, role: 'editor' }))).toBe(
      'lastAdmin',
    );
    expect(await code(members.removeMember({ workspaceId, admin: me, userId: admin.userId }))).toBe('self');

    await members.changeMemberRole({ workspaceId, admin: me, userId: adaId, role: 'admin' });
    // Now there are two, and either may step down — but not both.
    await members.changeMemberRole({ workspaceId, admin: { id: adaId }, userId: admin.userId, role: 'editor' });
    expect(await code(members.changeMemberRole({ workspaceId, admin: { id: adaId }, userId: adaId, role: 'editor' }))).toBe(
      'lastAdmin',
    );
    await members.changeMemberRole({ workspaceId, admin: { id: adaId }, userId: admin.userId, role: 'admin' });
  });

  it('removes a member for good, and frees their address', async () => {
    await members.changeMemberRole({ workspaceId, admin: { id: admin.userId }, userId: adaId, role: 'editor' });
    await members.removeMember({ workspaceId, admin: { id: admin.userId }, userId: adaId });

    expect((await members.listMembers(workspaceId)).some((member) => member.userId === adaId)).toBe(false);
    const sessions = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(drizzle.eq(schema.sessions.userId, adaId));
    expect(sessions).toEqual([]);
    expect(await code(members.removeMember({ workspaceId, admin: { id: admin.userId }, userId: adaId }))).toBe('notFound');

    // The same person can be invited again.
    const again = await invite(address('ada'));
    const rejoined = await members.acceptInvitation({ token: again.token, name: 'Ada', password: 'a-long-enough-password' });
    created.push(rejoined.userId);
    expect(rejoined.userId).not.toBe(adaId);
  });

  it('writes down how every account came to be', async () => {
    const rows = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(drizzle.eq(schema.auditLog.workspaceId, workspaceId));
    const actions = new Set(rows.map((row) => row.action));
    for (const action of [
      'invitation.created',
      'invitation.revoked',
      'member.joined',
      'member.role_changed',
      'member.removed',
    ]) {
      expect(actions, action).toContain(action);
    }
  });
});
