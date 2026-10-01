import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as AccessService from '@/lib/orgs/access';
import type * as MemberService from '@/lib/members/service';
import type * as OrgService from '@/lib/orgs/service';
import type * as Workspace from '@/lib/workspace';

/**
 * Organizations and asking to join one: only an instance administrator makes
 * an organization; the reader's choice of organization never reaches past
 * their own memberships; a request to join gives nothing until an
 * administrator of that organization approves it, and a refused stranger's
 * account is gone.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping organizations suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

describe.skipIf(!probe.reachable)('organizations and requests to join', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let orgs: typeof OrgService;
  let access: typeof AccessService;
  let members: typeof MemberService;
  let ws: typeof Workspace;

  const tag = `org-${randomUUID().slice(0, 8)}`;
  const address = (name: string) => `${name}-${tag}@example.test`;
  const workspaceIds: string[] = [];
  const created: string[] = [];
  let homeId = '';
  let root: TestAccount;
  let plain: TestAccount;

  const code = async (work: Promise<unknown>): Promise<string> => {
    try {
      await work;
      return 'ok';
    } catch (error) {
      if (error instanceof orgs.OrgError || error instanceof access.AccessError) return error.code;
      if (error instanceof members.MemberError) return error.code;
      return `unexpected: ${String(error)}`;
    }
  };

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();
    orgs = await import('@/lib/orgs/service');
    access = await import('@/lib/orgs/access');
    members = await import('@/lib/members/service');
    ws = await import('@/lib/workspace');

    const [home] = await db
      .insert(schema.workspaces)
      .values({ name: `Home ${tag}`, slug: `home-${tag}` })
      .returning();
    homeId = home?.id ?? '';
    workspaceIds.push(homeId);
    root = await createTestAccount({ db, schema, workspaceId: homeId, role: 'admin', tag: `${tag}-root` });
    plain = await createTestAccount({ db, schema, workspaceId: homeId, role: 'admin', tag: `${tag}-plain` });
    created.push(root.userId, plain.userId);
    await db.insert(schema.instanceAdmins).values({ userId: root.userId });
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    if (workspaceIds.length > 0) {
      await db.delete(schema.workspaces).where(drizzle.inArray(schema.workspaces.id, workspaceIds));
    }
    if (created.length > 0) await db.delete(schema.users).where(drizzle.inArray(schema.users.id, created));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  let otherId = '';

  it('lets only an instance administrator create an organization, at a free address', async () => {
    expect(await code(orgs.createOrganization({ creatorId: plain.userId, name: 'Nope', slug: `nope-${tag}` }))).toBe(
      'forbidden',
    );
    expect(await code(orgs.createOrganization({ creatorId: root.userId, name: 'Bad', slug: 'Bad Slug' }))).toBe('slug');
    expect(await code(orgs.createOrganization({ creatorId: root.userId, name: 'Bad', slug: 'register' }))).toBe('slug');

    const other = await orgs.createOrganization({ creatorId: root.userId, name: '  Other   Org ', slug: `other-${tag}` });
    otherId = other.id;
    workspaceIds.push(otherId);
    expect(await ws.getMembership(root.userId, otherId)).toMatchObject({ role: 'admin' });
    expect(await code(orgs.createOrganization({ creatorId: root.userId, name: 'Again', slug: `other-${tag}` }))).toBe(
      'slugTaken',
    );
    const all = await orgs.listAllOrganizations(root.userId);
    expect(all.find((org) => org.id === otherId)).toMatchObject({ name: 'Other Org', memberCount: 1 });
    expect(await code(orgs.listAllOrganizations(plain.userId))).toBe('forbidden');
  });

  it('switches only among the reader’s own organizations', async () => {
    expect((await ws.getActiveMembership(root.userId, otherId))?.workspaceId).toBe(otherId);
    // Not a member there: the choice falls back to the first organization joined.
    expect((await ws.getActiveMembership(plain.userId, otherId))?.workspaceId).toBe(homeId);
    expect((await ws.getActiveMembership(plain.userId, 'not-a-uuid'))?.workspaceId).toBe(homeId);
    expect((await ws.getActiveMembership(root.userId, null))?.workspaceId).toBe(homeId);
    expect(ws.chosenOrgFromCookieHeader(`a=1; ${ws.ORG_COOKIE}=${otherId}; b=2`)).toBe(otherId);
    expect(ws.chosenOrgFromCookieHeader(`${ws.ORG_COOKIE}=%E0%A4%A`)).toBeNull();
    expect((await ws.listMembershipsForUser(root.userId)).map((org) => org.workspaceId)).toEqual([homeId, otherId]);
  });

  it('takes requests only when the organization opened them, and grants nothing until approval', async () => {
    const [other] = await db.select().from(schema.workspaces).where(drizzle.eq(schema.workspaces.id, otherId));
    if (!other) throw new Error('missing organization');
    access.resetAccessRequestLimit();
    const stranger = {
      workspace: other,
      client: `client-${tag}`,
      message: 'from the QA team',
      name: 'Grace',
      email: address('grace'),
      password: 'a-long-enough-password',
    };
    expect(await code(access.requestAccess(stranger))).toBe('closed');

    await access.setRegistrationMode({ workspaceId: otherId, adminId: root.userId, mode: 'approval' });
    const [open] = await db.select().from(schema.workspaces).where(drizzle.eq(schema.workspaces.id, otherId));
    if (!open) throw new Error('missing organization');
    expect(access.readRegistrationMode(open)).toBe('approval');

    expect(await code(access.requestAccess({ ...stranger, workspace: open, password: 'short' }))).toBe('password');
    const { userId: graceId } = await access.requestAccess({ ...stranger, workspace: open });
    created.push(graceId);
    expect(await ws.getMembershipForUser(graceId)).toBeNull();
    expect(await code(access.requestAccess({ ...stranger, workspace: open }))).toBe('emailTaken');

    // An existing member of another organization asks with their own account.
    expect(
      await code(access.requestAccess({ workspace: open, client: `client-${tag}`, message: '', existingUserId: plain.userId })),
    ).toBe('ok');
    expect(
      await code(access.requestAccess({ workspace: open, client: `client-${tag}`, message: '', existingUserId: plain.userId })),
    ).toBe('alreadyRequested');
    // Five attempts an hour from one client, whatever became of them.
    expect(
      await code(access.requestAccess({ workspace: open, client: `client-${tag}`, message: '', existingUserId: plain.userId })),
    ).toBe('rateLimited');
    access.resetAccessRequestLimit();
    expect(
      await code(access.requestAccess({ workspace: open, client: `client-${tag}`, message: '', existingUserId: root.userId })),
    ).toBe('alreadyMember');

    const pending = await access.listPendingAccessRequests(otherId);
    expect(pending.map((request) => request.email).sort()).toEqual([address('grace'), plain.email].sort());
    expect(await access.countPendingAccessRequests(otherId)).toBe(2);
    expect(await access.listPendingAccessRequests(homeId)).toEqual([]);

    // Another organization's administrator cannot decide it.
    const graceRequest = pending.find((request) => request.userId === graceId);
    expect(
      await code(
        access.decideAccessRequest({
          workspaceId: homeId,
          adminId: plain.userId,
          requestId: graceRequest?.id ?? '',
          decision: { approve: true, role: 'admin' },
        }),
      ),
    ).toBe('notFound');

    await access.decideAccessRequest({
      workspaceId: otherId,
      adminId: root.userId,
      requestId: graceRequest?.id ?? '',
      decision: { approve: true, role: 'editor' },
    });
    expect(await ws.getMembership(graceId, otherId)).toMatchObject({ role: 'editor' });

    // Refusing an account that is a member elsewhere keeps the account.
    const plainRequest = pending.find((request) => request.userId === plain.userId);
    await access.decideAccessRequest({
      workspaceId: otherId,
      adminId: root.userId,
      requestId: plainRequest?.id ?? '',
      decision: { approve: false },
    });
    expect(await ws.getMembership(plain.userId, otherId)).toBeNull();
    expect(await ws.getMembership(plain.userId, homeId)).not.toBeNull();
  });

  it('deletes a stranger’s account when the only request it made is refused', async () => {
    const [open] = await db.select().from(schema.workspaces).where(drizzle.eq(schema.workspaces.id, otherId));
    if (!open) throw new Error('missing organization');
    access.resetAccessRequestLimit();
    const { userId } = await access.requestAccess({
      workspace: open,
      client: `client-${tag}`,
      message: '',
      name: 'Mallory',
      email: address('mallory'),
      password: 'a-long-enough-password',
    });
    created.push(userId);
    const [request] = await access.listPendingAccessRequests(otherId);
    await access.decideAccessRequest({
      workspaceId: otherId,
      adminId: root.userId,
      requestId: request?.id ?? '',
      decision: { approve: false },
    });
    const [row] = await db.select().from(schema.users).where(drizzle.eq(schema.users.id, userId));
    expect(row).toBeUndefined();
  });

  it('removes a member of two organizations from one, keeping the account', async () => {
    const graceRow = (await members.listMembers(otherId)).find((member) => member.email === address('grace'));
    await db.insert(schema.memberships).values({ workspaceId: homeId, userId: graceRow?.userId ?? '', role: 'viewer' });
    await members.removeMember({ workspaceId: otherId, admin: { id: root.userId }, userId: graceRow?.userId ?? '' });
    expect(await ws.getMembership(graceRow?.userId ?? '', otherId)).toBeNull();
    expect(await ws.getMembership(graceRow?.userId ?? '', homeId)).toMatchObject({ role: 'viewer' });
  });

  it('lets an existing account accept an invitation into another organization', async () => {
    const { token } = await members.createInvitation({
      workspaceId: otherId,
      admin: { id: root.userId },
      email: plain.email,
      role: 'viewer',
    });
    expect(
      await code(members.acceptInvitationAsMember({ token, userId: plain.userId, email: 'someone-else@example.test' })),
    ).toBe('invalidInvitation');
    expect(await members.acceptInvitationAsMember({ token, userId: plain.userId, email: plain.email })).toEqual({
      workspaceId: otherId,
    });
    expect(await ws.getMembership(plain.userId, otherId)).toMatchObject({ role: 'viewer' });
    expect(await code(members.acceptInvitationAsMember({ token, userId: plain.userId, email: plain.email }))).toBe(
      'invalidInvitation',
    );
  });
});
