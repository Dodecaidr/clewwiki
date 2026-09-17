import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

import type * as Setup from '@/lib/setup';
import type * as SetupToken from '@/lib/setup-token';

const probe = await prepareTestDatabase();

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
delete process.env.CLEWWIKI_SETUP_TOKEN;

/** First-run setup only means something on a database with no accounts. */
async function databaseHasUsers(): Promise<boolean> {
  if (!probe.reachable) return false;
  const { createDatabase, users } = await import('@clewwiki/db');
  const handle = createDatabase(databaseUrl, { max: 1 });
  try {
    const rows = await handle.db.select({ id: users.id }).from(users).limit(1);
    return rows.length > 0;
  } finally {
    await handle.sql.end({ timeout: 5 });
  }
}

const occupied = await databaseHasUsers();
const skipReason = !probe.reachable
  ? probe.reason
  : occupied
    ? 'the test database already has accounts, so first-run setup cannot be exercised'
    : undefined;
if (skipReason) console.warn(`[integration] skipping first-run setup suite: ${skipReason}`);

describe.skipIf(skipReason !== undefined)('first-run setup', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let setup: typeof Setup;
  let setupToken: typeof SetupToken;

  const input = () => ({
    workspaceName: 'Setup suite',
    name: 'First Admin',
    email: `setup-${randomBytes(3).toString('hex')}@example.test`,
    password: randomBytes(18).toString('base64url'),
  });

  async function cleanUp(): Promise<void> {
    const { eq, like } = await import('drizzle-orm');
    // Only what this suite created: every address it uses matches this pattern.
    await db.delete(schema.users).where(like(schema.users.email, 'setup-%@example.test'));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.name, 'Setup suite'));
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();
    setup = await import('@/lib/setup');
    setupToken = await import('@/lib/setup-token');
  });

  afterAll(async () => {
    if (!schema) return;
    await cleanUp();
    delete process.env.CLEWWIKI_SETUP_TOKEN;
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('refuses without the generated token and creates nothing', async () => {
    const lines: string[] = [];
    const token = setupToken.ensureSetupToken((line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('setup token');
    expect(lines[0]).toContain(token);

    for (const wrong of [undefined, '', 'guessed', `${token}x`]) {
      const outcome = await setup.completeSetup({ ...input(), setupToken: wrong });
      expect(outcome).toEqual({ ok: false, error: 'setupToken' });
    }
    expect(await db.select().from(schema.users)).toHaveLength(0);
  });

  it('creates the administrator, the workspace and the membership with the token', async () => {
    const token = setupToken.ensureSetupToken(() => undefined);
    const outcome = await setup.completeSetup({ ...input(), setupToken: token });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { eq } = await import('drizzle-orm');
    const [membership] = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, outcome.userId));
    expect(membership?.role).toBe('admin');

    // The token is spent: the same value cannot be used again.
    const again = await setup.completeSetup({ ...input(), setupToken: token });
    expect(again.ok).toBe(false);
    await cleanUp();
  });

  it('uses CLEWWIKI_SETUP_TOKEN instead of a generated token when it is set', async () => {
    const generated = setupToken.ensureSetupToken(() => undefined);
    process.env.CLEWWIKI_SETUP_TOKEN = 'operator-chosen-setup-token-value';
    try {
      const withGenerated = await setup.completeSetup({ ...input(), setupToken: generated });
      expect(withGenerated).toEqual({ ok: false, error: 'setupToken' });

      const withConfigured = await setup.completeSetup({
        ...input(),
        setupToken: 'operator-chosen-setup-token-value',
      });
      expect(withConfigured.ok).toBe(true);
    } finally {
      delete process.env.CLEWWIKI_SETUP_TOKEN;
      await cleanUp();
    }
  });
});
