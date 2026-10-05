import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as Development from '@/lib/development/service';
import type * as Discussions from '@/lib/discussions/service';

/**
 * Development against a real repository: branches become streams, a merge is
 * seen as one, branches merged long ago are history, a release refuses to ship
 * while one of its streams is not merged, and a stream's problem is decided
 * into the stream's documentation.
 */

const probe = await prepareTestDatabase();
if (!probe.reachable) console.warn(`[integration] skipping development suite: ${probe.reason}`);

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.ALLOW_FILE_REPOSITORIES = 'true';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const scratch = mkdtempSync(path.join(tmpdir(), 'clewwiki-dev-'));
const origin = path.join(scratch, 'origin');
process.env.REPOS_DIR = path.join(scratch, 'mirrors');

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd: origin,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.test',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...env,
    },
  });
}

function commit(file: string, message: string, env: Record<string, string> = {}): void {
  writeFileSync(path.join(origin, file), `${message}\n`);
  git(['add', file]);
  git(['commit', '-q', '-m', message], env);
}

describe.skipIf(!probe.reachable)('development streams and releases', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;
  let dev: typeof Development;
  let discussions: typeof Discussions;
  const tag = `dv-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let spaceId = '';
  let person: TestAccount;
  const actor = () => ({ type: 'user' as const, id: person.userId });

  beforeAll(async () => {
    execFileSync('mkdir', ['-p', origin]);
    git(['init', '-q', '-b', 'main']);
    commit('readme.md', 'start');
    // Merged a year ago: history, not work.
    const old = { GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z' };
    git(['checkout', '-q', '-b', 'old-fix']);
    commit('old.md', 'old fix', old);
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--ff-only', 'old-fix']);
    // Merged recently, never announced.
    git(['checkout', '-q', '-b', 'hotfix/APP-7']);
    commit('hot.md', 'hotfix');
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--ff-only', 'hotfix/APP-7']);
    // In progress.
    git(['checkout', '-q', '-b', 'feature/APP-42-login']);
    commit('login.md', 'login one');
    commit('login2.md', 'login two');
    git(['checkout', '-q', 'main']);

    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();
    dev = await import('@/lib/development/service');
    discussions = await import('@/lib/discussions/service');
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        name: `Dev ${tag}`,
        slug: `dev-${tag}`,
        settings: { trackers: [{ id: 'aaaaaaaaaaaa', kind: 'other', name: 'T', base_url: 'https://t.example', projects: ['APP'], url_template: 'https://t.example/{key}' }] },
      })
      .returning();
    workspaceId = workspace?.id ?? '';
    person = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag });
    const [space] = await db
      .insert(schema.spaces)
      .values({
        workspaceId,
        key: `DV${tag.slice(3, 7).toUpperCase()}`,
        name: 'Dev',
        settings: { repository: { url: `file://${origin}`, default_ref: 'main' } },
      })
      .returning({ id: schema.spaces.id });
    spaceId = space?.id ?? '';
  });

  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    if (!probe.reachable) return;
    if (workspaceId) await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(drizzle.eq(schema.users.id, person.userId));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('turns branches into streams, leaving long-merged ones out as history', async () => {
    const result = await dev.syncStreams(workspaceId, spaceId, actor());
    expect(result.defaultBranch).toBe('main');
    expect(result.created.sort()).toEqual(['feature/APP-42-login', 'hotfix/APP-7']);
    expect(result.skippedHistory).toBe(1);

    const streams = await dev.listStreams(workspaceId, spaceId);
    const feature = streams.find((stream) => stream.ref === 'feature/APP-42-login');
    const hotfix = streams.find((stream) => stream.ref === 'hotfix/APP-7');
    expect(feature).toMatchObject({ state: 'active', branch: expect.objectContaining({ ahead: 2, behind: 0, merged: false, present: true }) });
    expect(hotfix).toMatchObject({ state: 'merged' });
    const [workspace] = await db.select().from(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    expect(feature && workspace ? dev.streamIssueKeys(feature, workspace) : []).toEqual(['APP-42']);

    // The thing nobody announced: merged, no release.
    const overview = dev.buildOverview(streams, []);
    expect(overview.mergedUnreleased.map((stream) => stream.ref)).toEqual(['hotfix/APP-7']);
    expect(overview.unplanned.map((stream) => stream.ref)).toEqual(['feature/APP-42-login']);
  });

  it('refuses to ship a release while a stream of it is not merged, and sees the merge on the next sync', async () => {
    const release = await dev.createRelease(workspaceId, spaceId, actor(), { name: '2.4.0', dueOn: '2026-11-01' });
    await expect(dev.createRelease(workspaceId, spaceId, actor(), { name: '2.4.0 ' })).rejects.toMatchObject({ code: 'conflict' });
    const streams = await dev.listStreams(workspaceId, spaceId);
    for (const stream of streams) await dev.updateStream(workspaceId, stream.id, actor(), { releaseId: release.id });

    await expect(dev.shipRelease(workspaceId, release.id, actor(), false)).rejects.toMatchObject({
      code: 'conflict',
      details: { missing: ['feature/APP-42-login'] },
    });

    git(['merge', '-q', '--no-ff', '-m', 'merge login', 'feature/APP-42-login']);
    git(['branch', '-q', '-D', 'hotfix/APP-7']);
    const second = await dev.syncStreams(workspaceId, spaceId, actor());
    expect(second.merged).toEqual(['feature/APP-42-login']);
    expect(second.gone).toEqual(['hotfix/APP-7']);

    const shipped = await dev.shipRelease(workspaceId, release.id, actor(), false);
    expect(shipped.release.state).toBe('shipped');
    expect(shipped.missing).toEqual([]);
  });

  it('writes the decision of a stream’s problem into the stream’s documentation', async () => {
    const stream = await dev.createStream(workspaceId, spaceId, actor(), { title: 'Payments', goal: 'Card payments via APP-99' });
    const docsId = await dev.ensureDocsPage(workspaceId, stream.id, actor(), {
      rootTitle: 'Development',
      rootBody: 'root',
      pageTitle: (name) => `Branch ${name}`,
      pageBody: (goal) => goal,
    });
    const opened = await discussions.openDiscussion({
      workspaceId,
      spaceId,
      actor: { ...actor(), label: 'Ada' },
      title: 'Which PSP?',
      body: 'Stripe or Adyen?',
      streamId: stream.id,
    });
    expect(opened.discussion.streamId).toBe(stream.id);
    const resolved = await discussions.resolveDiscussion({
      workspaceId,
      discussionId: opened.discussion.id,
      actor: { ...actor(), label: 'Ada' },
      decision: 'Stripe.',
    });
    expect(resolved.page.parentId).toBe(docsId);
    const problems = await dev.listStreamProblems(workspaceId, stream.id);
    expect(problems).toEqual([expect.objectContaining({ title: 'Which PSP?', status: 'resolved', decisionPageId: resolved.page.id })]);

    // A stream of another space cannot be attached.
    await expect(
      discussions.openDiscussion({ workspaceId, spaceId, actor: { ...actor(), label: 'Ada' }, title: 'x', body: 'y', streamId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('validates what a stream may hold', async () => {
    await expect(dev.createStream(workspaceId, spaceId, actor(), { title: 'x', ref: '--upload-pack=evil' })).rejects.toMatchObject({ code: 'validation' });
    await expect(dev.createStream(workspaceId, spaceId, actor(), { title: 'x', issueKeys: ['not a key'] })).rejects.toMatchObject({ code: 'validation' });
    await expect(dev.createStream(workspaceId, spaceId, actor(), { title: 'dup', ref: 'feature/APP-42-login' })).rejects.toMatchObject({ code: 'conflict' });
  });
});
