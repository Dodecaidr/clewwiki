import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

import type * as RepositoryActions from '@/app/spaces/actions';

const probe = await prepareTestDatabase();
if (!probe.reachable) {
  console.warn(`[integration] skipping repository settings actions suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

// The actions read the signed-in administrator from the request; here the
// session is whatever this suite says it is.
const session = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('@/lib/session', () => ({ getSessionContext: async () => session.current }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

describe.skipIf(!probe.reachable)('space repository settings actions', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let actions: typeof RepositoryActions;

  const suiteTag = `ra-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let scratch = '';

  function form(values: Record<string, string>): FormData {
    const data = new FormData();
    data.set('spaceKey', 'REPO');
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
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
    actions = await import('@/app/spaces/actions');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Repo ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning();
    workspaceId = workspace!.id;
    await db.insert(schema.spaces).values({ workspaceId, key: 'REPO', name: 'Repository test' });
    session.current = { userId: 'admin-user', name: 'Admin', email: 'a@example.test', role: 'admin', workspace };

    scratch = mkdtempSync(path.join(tmpdir(), 'clewwiki-repo-actions-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8' });
    git(['init', '-q', '-b', 'main', '.']);
    writeFileSync(path.join(scratch, 'README.md'), 'hello\n');
    git(['add', '-A']);
    git(['-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  });

  afterAll(async () => {
    if (!probe.reachable || !schema) return;
    const { eq } = await import('drizzle-orm');
    if (workspaceId) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('audits Test connection with the URL and the variable name', async () => {
    const result = await actions.testRepositoryAction(
      {},
      form({ url: `file://${scratch}`, default_ref: 'main', auth_token_env: 'CLEWWIKI_GIT_TOKEN' }),
    );
    expect(result.probe?.ok).toBe(true);

    const rows = await auditRows('space.repository_tested');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      url: `file://${scratch}`,
      auth_token_env: 'CLEWWIKI_GIT_TOKEN',
      ok: true,
    });
  });

  it('refuses a variable outside the repository-token namespace before reaching out', async () => {
    const before = (await auditRows('space.repository_tested')).length;
    for (const name of ['BETTER_AUTH_SECRET', 'DATABASE_URL', 'POSTGRES_PASSWORD']) {
      const tested = await actions.testRepositoryAction(
        {},
        form({ url: 'https://git.example.com/org/repo.git', default_ref: 'main', auth_token_env: name }),
      );
      expect(tested.error).toBe('validation');
      expect(tested.probe).toBeUndefined();

      const saved = await actions.saveRepositoryAction(
        {},
        form({ url: 'https://git.example.com/org/repo.git', default_ref: 'main', auth_token_env: name }),
      );
      expect(saved.error).toBe('validation');
    }
    expect((await auditRows('space.repository_tested')).length).toBe(before);
  });

  it('refuses a URL with a credential in it', async () => {
    const saved = await actions.saveRepositoryAction(
      {},
      form({ url: 'https://x-access-token:secret@git.example.com/org/repo.git', default_ref: 'main' }),
    );
    expect(saved.error).toBe('validation');
  });
  it('stores the repository on the space, not on the workspace, and audits it', async () => {
    const { and, eq } = await import('drizzle-orm');
    const saved = await actions.saveRepositoryAction(
      {},
      form({ url: `file://${scratch}`, default_ref: 'main', auth_token_env: 'CLEWWIKI_GIT_TOKEN_REPO' }),
    );
    expect(saved).toEqual({ saved: true });

    const [space] = await db
      .select()
      .from(schema.spaces)
      .where(and(eq(schema.spaces.workspaceId, workspaceId), eq(schema.spaces.key, 'REPO')));
    expect(space?.settings.repository).toEqual({
      url: `file://${scratch}`,
      default_ref: 'main',
      auth_token_env: 'CLEWWIKI_GIT_TOKEN_REPO',
    });
    const [workspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    expect(workspace?.settings).not.toHaveProperty('repository');

    const rows = await auditRows('space.repository_set');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(space?.id);
    expect(rows[0]?.metadata).toMatchObject({ key: 'REPO', auth_token_env: 'CLEWWIKI_GIT_TOKEN_REPO' });
  });

  it('refuses an editor', async () => {
    const previous = session.current;
    session.current = { ...previous, role: 'editor' };
    try {
      const saved = await actions.saveRepositoryAction(
        {},
        form({ url: `file://${scratch}`, default_ref: 'main' }),
      );
      expect(saved.error).toBe('forbidden');
    } finally {
      session.current = previous;
    }
  });
});
