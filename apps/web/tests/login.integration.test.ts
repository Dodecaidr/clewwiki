import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as Login from '@/lib/login';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping sign-in suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

describe.skipIf(!probe.reachable)('password sign-in and account creation', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let login: typeof Login;

  const suiteTag = `li-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let account: TestAccount;
  const userIds: string[] = [];

  function headersFrom(address: string | null, extra: Record<string, string> = {}): Headers {
    const headers = new Headers(extra);
    if (address !== null) headers.set('x-real-ip', address);
    return headers;
  }

  async function auditRows(action: string) {
    const { and, eq } = await import('drizzle-orm');
    return db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.workspaceId, workspaceId), eq(schema.auditLog.action, action)));
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();
    login = await import('@/lib/login');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Login ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning({ id: schema.workspaces.id });
    workspaceId = workspace!.id;

    account = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    userIds.push(account.userId);
  });

  beforeEach(() => {
    login.resetLoginLimits();
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { eq, inArray } = await import('drizzle-orm');
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('signs in with the right password and audits a wrong one', async () => {
    const wrong = await login.attemptLogin({
      email: account.email,
      password: 'not-the-password',
      headers: headersFrom('203.0.113.10'),
    });
    expect(wrong.ok).toBe(false);

    const failed = await auditRows('auth.login_failed');
    expect(failed.some((row) => row.actorId === account.userId)).toBe(true);
    expect(failed.at(-1)?.metadata).toMatchObject({ client: '203.0.113.10' });

    const right = await login.attemptLogin({
      email: account.email,
      password: account.password,
      headers: headersFrom('203.0.113.10'),
    });
    expect(right.ok).toBe(true);
  });

  it('locks one account after repeated failures, whichever addresses they come from', async () => {
    for (let attempt = 0; attempt < login.LOGIN_ATTEMPTS_PER_ACCOUNT; attempt += 1) {
      const result = await login.attemptLogin({
        email: account.email,
        password: `wrong-${attempt}`,
        headers: headersFrom(`198.51.100.${attempt + 1}`),
      });
      expect(result.ok).toBe(false);
    }

    // The right password, from an address never seen before, is still refused
    // — with exactly the answer a wrong password gets.
    const refused = await login.attemptLogin({
      email: account.email.toUpperCase(),
      password: account.password,
      headers: headersFrom('192.0.2.200'),
    });
    expect(refused).toEqual({ ok: false });

    const limited = await auditRows('auth.login_rate_limited');
    expect(limited.at(-1)?.metadata).toMatchObject({ limited_by: 'account' });
  });

  it('limits one client across many accounts', async () => {
    for (let attempt = 0; attempt < login.LOGIN_ATTEMPTS_PER_CLIENT; attempt += 1) {
      await login.attemptLogin({
        email: `nobody-${attempt}-${suiteTag}@example.test`,
        password: 'guess',
        headers: headersFrom('203.0.113.77'),
      });
    }

    const sameClient = await login.attemptLogin({
      email: account.email,
      password: account.password,
      headers: headersFrom('203.0.113.77'),
    });
    expect(sameClient.ok).toBe(false);

    const otherClient = await login.attemptLogin({
      email: account.email,
      password: account.password,
      headers: headersFrom('203.0.113.78'),
    });
    expect(otherClient.ok).toBe(true);
  }, 60_000);

  it('does not trust X-Forwarded-For: without the trusted header every client shares one bucket', async () => {
    for (let attempt = 0; attempt < login.LOGIN_ATTEMPTS_PER_CLIENT; attempt += 1) {
      await login.attemptLogin({
        email: `spoof-${attempt}-${suiteTag}@example.test`,
        password: 'guess',
        headers: headersFrom(null, { 'x-forwarded-for': `10.0.${attempt}.1` }),
      });
    }

    const rotated = await login.attemptLogin({
      email: account.email,
      password: account.password,
      headers: headersFrom(null, { 'x-forwarded-for': '10.99.99.99' }),
    });
    expect(rotated.ok).toBe(false);
  }, 60_000);

  it('keeps the public sign-up route closed while server-side account creation still works', async () => {
    const { POST } = await import('@/app/api/auth/[...all]/route');
    const email = `self-${suiteTag}@example.test`;

    const response = await POST(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email, password: 'a-long-enough-password', name: 'Self' }),
      }),
    );
    expect(response.status).toBe(404);

    const { eq } = await import('drizzle-orm');
    const created = await db.select().from(schema.users).where(eq(schema.users.email, email));
    expect(created).toHaveLength(0);

    // The sign-in route is still served: it answers, rather than 404.
    const signIn = await POST(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: account.email, password: 'not-the-password' }),
      }),
    );
    expect(signIn.status).not.toBe(404);

    const other = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });
    userIds.push(other.userId);
    expect(other.cookie).toContain('session_token');
  });
});
