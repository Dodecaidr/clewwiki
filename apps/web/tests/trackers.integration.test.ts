import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as Admin from '@/lib/trackers/admin';
import type * as Api from '@/lib/trackers/api';

/**
 * Tracker settings as stored: added and removed under a row lock, a project
 * key owned by one tracker at a time, and an agent's "mine" meaning the queue
 * of the person who issued its token.
 */

const probe = await prepareTestDatabase();
if (!probe.reachable) console.warn(`[integration] skipping trackers suite: ${probe.reason}`);

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

describe.skipIf(!probe.reachable)('tracker settings in the database', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let admin: typeof Admin;
  let api: typeof Api;
  const tag = `tr-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let owner: TestAccount;

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();
    admin = await import('@/lib/trackers/admin');
    api = await import('@/lib/trackers/api');
    const [workspace] = await db.insert(schema.workspaces).values({ name: `Trackers ${tag}`, slug: `trackers-${tag}` }).returning();
    workspaceId = workspace?.id ?? '';
    owner = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag });
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    if (workspaceId) await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(drizzle.eq(schema.users.id, owner.userId));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  const stored = async () => {
    const [row] = await db.select().from(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    return row?.settings.trackers ?? [];
  };

  it('adds trackers, hands a project key to the newer one, and removes them', async () => {
    const first = await admin.addTracker(workspaceId, owner.userId, {
      kind: 'youtrack',
      name: 'Old',
      baseUrl: 'https://old.example.com',
      projects: 'MAC, WEB',
    });
    const second = await admin.addTracker(workspaceId, owner.userId, {
      kind: 'jira',
      name: 'New',
      baseUrl: 'https://new.example.com',
      projects: 'WEB',
      tokenEnv: 'CLEWWIKI_TRACKER_TOKEN_NEW',
    });
    expect((await stored()).map((tracker) => [tracker.name, tracker.projects])).toEqual([
      ['Old', ['MAC']],
      ['New', ['WEB']],
    ]);
    // Taking a tracker's last key away removes the tracker.
    await admin.addTracker(workspaceId, owner.userId, { kind: 'other', name: 'GL', baseUrl: 'https://gl.example.com', projects: 'MAC', urlTemplate: 'https://gl.example.com/{key}' });
    expect((await stored()).map((tracker) => tracker.name)).toEqual(['New', 'GL']);
    await admin.removeTracker(workspaceId, owner.userId, second.id);
    expect((await stored()).map((tracker) => tracker.name)).toEqual(['GL']);
    expect(first.id).toMatch(/^[0-9a-f]{12}$/);
    const audit = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(drizzle.eq(schema.auditLog.workspaceId, workspaceId));
    expect(audit.filter((row) => row.action.startsWith('trackers.')).length).toBe(4);
  });

  it('takes an agent’s tasks to be those of the person who issued its token', async () => {
    const [token] = await db
      .insert(schema.agentTokens)
      .values({
        workspaceId,
        name: 'mac-agent',
        prefix: `tr${randomUUID().slice(0, 8)}`,
        tokenHash: 'x',
        scopes: ['pages:read'],
        createdBy: owner.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: schema.agentTokens.id });
    const [workspace] = await db.select().from(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    if (!workspace || !token) throw new Error('setup failed');
    expect(
      await api.emailOf({ type: 'agent', tokenId: token.id, name: 'mac-agent', scopes: ['pages:read'], workspaceId, workspace, spaceIds: null }),
    ).toBe(owner.email);
  });
});
