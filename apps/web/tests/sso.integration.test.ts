import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';

import type * as SsoService from '@/lib/members/sso';

/**
 * What a provider's word is worth here.
 *
 * Signing in at an identity provider says who somebody is; it does not say they
 * belong to this workspace. These cases are the seam between the two, and the
 * one that matters most is the last: an account that never came from the
 * provider must not be handed a membership because provisioning is on.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping single sign-on suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

describe.skipIf(!probe.reachable)('single sign-on membership', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let sso: typeof SsoService;

  const suiteTag = `sso-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let createdDefaultWorkspace = false;
  const created: string[] = [];

  /** An account with no membership, as an OpenID Connect sign-in would leave it. */
  async function accountWithoutMembership(options: { linked: boolean }): Promise<string> {
    const account = await createTestAccount({ db, schema, workspaceId, role: 'viewer', tag: suiteTag });
    created.push(account.userId);
    await db.delete(schema.memberships).where(drizzle.eq(schema.memberships.userId, account.userId));
    if (options.linked) {
      await db.insert(schema.accounts).values({
        id: `acc-${randomUUID()}`,
        accountId: `provider-subject-${randomUUID().slice(0, 8)}`,
        providerId: 'oidc',
        userId: account.userId,
      });
    }
    return account.userId;
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();
    sso = await import('@/lib/members/sso');

    // Provisioning lands in the workspace `/setup` makes, so the suite needs
    // that one rather than a workspace of its own.
    const [existing] = await db
      .select()
      .from(schema.workspaces)
      .where(drizzle.eq(schema.workspaces.slug, 'default'))
      .limit(1);
    if (existing) {
      workspaceId = existing.id;
    } else {
      const [made] = await db
        .insert(schema.workspaces)
        .values({ name: `SSO ${suiteTag}`, slug: 'default' })
        .returning();
      workspaceId = made?.id ?? '';
      createdDefaultWorkspace = true;
    }
  });

  afterEach(() => {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_SIGN_UP;
    delete process.env.OIDC_SIGN_UP_ROLE;
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    if (created.length > 0) await db.delete(schema.users).where(drizzle.inArray(schema.users.id, created));
    if (createdDefaultWorkspace && workspaceId) {
      await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    }
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  function configure(signUp: boolean, role = 'viewer'): void {
    process.env.OIDC_ISSUER = 'https://id.example.com';
    process.env.OIDC_CLIENT_ID = 'clewwiki';
    process.env.OIDC_CLIENT_SECRET = 'secret';
    process.env.OIDC_SIGN_UP = signUp ? 'true' : 'false';
    process.env.OIDC_SIGN_UP_ROLE = role;
  }

  it('leaves a member alone, whatever the provider said', async () => {
    const member = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    created.push(member.userId);
    configure(true, 'admin');

    expect(await sso.ensureOidcMembership(member.userId)).toBe('member');
    const [membership] = await db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(drizzle.eq(schema.memberships.userId, member.userId));
    // Provisioning is not a way to be promoted.
    expect(membership?.role).toBe('editor');
  });

  it('refuses somebody the provider vouches for while provisioning is off', async () => {
    const userId = await accountWithoutMembership({ linked: true });
    configure(false);

    expect(await sso.ensureOidcMembership(userId)).toBe('refused');
    const rows = await db
      .select()
      .from(schema.memberships)
      .where(drizzle.eq(schema.memberships.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('gives a first-time arrival the configured role, and writes it down', async () => {
    const userId = await accountWithoutMembership({ linked: true });
    configure(true, 'editor');

    expect(await sso.ensureOidcMembership(userId)).toBe('provisioned');
    const [membership] = await db
      .select({ role: schema.memberships.role, workspaceId: schema.memberships.workspaceId })
      .from(schema.memberships)
      .where(drizzle.eq(schema.memberships.userId, userId));
    expect(membership).toMatchObject({ role: 'editor', workspaceId });

    const audit = await db
      .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
      .from(schema.auditLog)
      .where(drizzle.eq(schema.auditLog.target, userId));
    expect(audit.some((row) => row.action === 'member.joined')).toBe(true);
    expect(JSON.stringify(audit)).toContain('oidc');
  });

  it('refuses an account that never came from the provider', async () => {
    // A password account that an administrator removed from the workspace. It
    // has a session and no membership, which is exactly the shape a provisioned
    // arrival has — the account row is what tells them apart.
    const userId = await accountWithoutMembership({ linked: false });
    configure(true);

    expect(await sso.ensureOidcMembership(userId)).toBe('refused');
    const rows = await db
      .select()
      .from(schema.memberships)
      .where(drizzle.eq(schema.memberships.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it('refuses when no provider is configured at all', async () => {
    const userId = await accountWithoutMembership({ linked: true });
    expect(await sso.ensureOidcMembership(userId)).toBe('refused');
  });
});
