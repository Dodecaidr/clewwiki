import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as AnchorsRoute from '@/app/api/v1/pages/[id]/anchors/route';
import type * as CheckRoute from '@/app/api/v1/pages/[id]/anchors/check/route';
import type * as AnchorRoute from '@/app/api/v1/anchors/[anchorId]/route';
import type * as ConfirmRoute from '@/app/api/v1/anchors/[anchorId]/confirm/route';
import type * as PageRoute from '@/app/api/v1/pages/[id]/route';
import type * as TreeRoute from '@/app/api/v1/pages/[id]/tree/route';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping anchors suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

const BASE = 'http://localhost:3000';

const SOURCE_FILE = 'Sources/Audio/Mixer.swift';

const REVISION_ONE = `import Foundation

/// Mixes the input channels.
struct Mixer {
    let channels: Int

    func blend(first: Double, second: Double) -> Double {
        let total = first + second
        return total / Double(channels)
    }
}
`;

/** Same tokens, different whitespace and comments. */
const REVISION_FORMATTED = `import Foundation

/// Mixes the input channels. This sentence is new and means nothing to a parser.
struct Mixer {
    let channels: Int

    func blend(
        first: Double,
        second: Double
    ) -> Double {
        // an added comment

        let total = first + second

        return total / Double(channels)
    }
}
`;

/** Same declaration, changed body. */
const REVISION_BODY_CHANGED = REVISION_ONE.replace(
  'return total / Double(channels)',
  'return total / Double(max(channels, 1))',
);

/** Same body, new name. */
const REVISION_RENAMED = REVISION_ONE.replace('func blend(', 'func combine(');

describe.skipIf(!probe.reachable)('anchors REST API', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;

  let pagesRoute: typeof PagesRoute;
  let anchorsRoute: typeof AnchorsRoute;
  let checkRoute: typeof CheckRoute;
  let anchorRoute: typeof AnchorRoute;
  let confirmRoute: typeof ConfirmRoute;
  let pageRoute: typeof PageRoute;
  let treeRoute: typeof TreeRoute;

  const suiteTag = `an-${randomUUID().slice(0, 8)}`;
  const workspaceIds: string[] = [];

  let workspaceId: string;
  let otherWorkspaceId: string;
  let readWrite = '';
  let readOnly = '';
  let noPageScope = '';
  let foreignToken = '';

  let scratch = '';
  let sourceRepo = '';
  let pageId = '';

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  /** Writes the file, commits it, and returns nothing — the ref does the rest. */
  function commitRevision(contents: string, message: string): void {
    const target = path.join(sourceRepo, SOURCE_FILE);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
    git(['add', '-A'], sourceRepo);
    git(
      [
        '-c',
        'user.email=tests@clewwiki.invalid',
        '-c',
        'user.name=clewwiki tests',
        'commit',
        '-q',
        '-m',
        message,
      ],
      sourceRepo,
    );
  }

  async function seedToken(options: {
    workspaceId: string;
    name: string;
    scopes: string[];
  }): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId: options.workspaceId,
      name: options.name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes: options.scopes,
    });
    return generated.token;
  }

  function request(token: string, target: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${target}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const anchorParams = (anchorId: string) => ({ params: Promise.resolve({ anchorId }) });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type JsonRecord = Record<string, any>;

  async function createAnchor(
    token: string,
    body: Record<string, unknown>,
    target = pageId,
  ): Promise<{ status: number; json: JsonRecord }> {
    const response = await anchorsRoute.POST(
      request(token, `/api/v1/pages/${target}/anchors`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      params(target),
    );
    return { status: response.status, json: await response.json() };
  }

  async function check(
    token: string,
    target = pageId,
    query = '',
  ): Promise<{ status: number; json: JsonRecord }> {
    const response = await checkRoute.POST(
      request(token, `/api/v1/pages/${target}/anchors/check${query}`, { method: 'POST' }),
      params(target),
    );
    return { status: response.status, json: await response.json() };
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();

    scratch = mkdtempSync(path.join(tmpdir(), 'clewwiki-anchors-'));
    sourceRepo = path.join(scratch, 'source');
    mkdirSync(sourceRepo, { recursive: true });
    // Every clone the server makes lands under this directory, so the suite
    // can delete the lot afterwards and leave nothing on the machine.
    process.env.REPOS_DIR = path.join(scratch, 'repos');

    git(['init', '-q', '-b', 'main', '.'], sourceRepo);
    commitRevision(REVISION_ONE, 'first revision');

    pagesRoute = await import('@/app/api/v1/pages/route');
    anchorsRoute = await import('@/app/api/v1/pages/[id]/anchors/route');
    checkRoute = await import('@/app/api/v1/pages/[id]/anchors/check/route');
    anchorRoute = await import('@/app/api/v1/anchors/[anchorId]/route');
    confirmRoute = await import('@/app/api/v1/anchors/[anchorId]/confirm/route');
    pageRoute = await import('@/app/api/v1/pages/[id]/route');
    treeRoute = await import('@/app/api/v1/pages/[id]/tree/route');

    const repository = {
      url: `file://${sourceRepo}`,
      default_ref: 'main',
    };

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Anchors ${suiteTag}`, slug: `${suiteTag}-a` })
      .returning({ id: schema.workspaces.id });
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `Other ${suiteTag}`, slug: `${suiteTag}-b` })
      .returning({ id: schema.workspaces.id });

    if (!workspace || !other) throw new Error('workspace seeding failed');
    workspaceId = workspace.id;
    otherWorkspaceId = other.id;
    workspaceIds.push(workspaceId, otherWorkspaceId);
    // The repository is a setting of the space the page lives in.
    await db.insert(schema.spaces).values([
      { workspaceId, key: 'MAIN', name: 'Main', settings: { repository } },
      { workspaceId: otherWorkspaceId, key: 'MAIN', name: 'Main', settings: { repository } },
    ]);

    readWrite = await seedToken({
      workspaceId,
      name: 'rw',
      scopes: ['pages:read', 'pages:write'],
    });
    readOnly = await seedToken({ workspaceId, name: 'ro', scopes: ['pages:read'] });
    noPageScope = await seedToken({ workspaceId, name: 'none', scopes: ['identity:read'] });
    foreignToken = await seedToken({
      workspaceId: otherWorkspaceId,
      name: 'foreign',
      scopes: ['pages:read', 'pages:write'],
    });

    const created = await pagesRoute.POST(
      request(readWrite, '/api/v1/pages', {
        method: 'POST',
        body: JSON.stringify({
          space: 'MAIN',
          title: 'Mixer',
          path: `/${suiteTag}-mixer`,
          kind: 'technical',
        }),
      }),
    );
    const page = await created.json();
    pageId = page.page_id as string;
  }, 60_000);

  afterAll(async () => {
    if (!probe.reachable) return;
    const { inArray } = await import('drizzle-orm');
    if (workspaceIds.length > 0) {
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, workspaceIds));
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    delete process.env.REPOS_DIR;
  });

  it('creates an anchor on a declaration that exists', async () => {
    const created = await createAnchor(readWrite, {
      file: SOURCE_FILE,
      qualified_name: 'Mixer.blend(first:second:)',
    });

    expect(created.status).toBe(201);
    expect(created.json.state).toBe('fresh');
    expect(created.json.kind).toBe('func');
    expect(created.json.language).toBe('swift');
    expect(created.json.fallback).toBe(false);
    expect(created.json.line_start).toBeGreaterThan(0);
  }, 60_000);

  it('refuses an anchor on a declaration that does not exist', async () => {
    const created = await createAnchor(readWrite, {
      file: SOURCE_FILE,
      qualified_name: 'Mixer.nothingLikeThis()',
    });
    expect(created.status).toBe(400);
    expect(created.json.error.code).toBe('validation');
  }, 60_000);

  it('audits the creation', async () => {
    const { and, eq } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.workspaceId, workspaceId),
          eq(schema.auditLog.action, 'anchor.created'),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.metadata?.file).toBe(SOURCE_FILE);
  });

  it('stays fresh through a formatting-only commit', async () => {
    commitRevision(REVISION_FORMATTED, 'reformat and re-comment');

    const result = await check(readWrite);
    expect(result.status).toBe(200);
    expect(result.json.ref).toBe('main');
    expect(result.json.commit).toMatch(/^[0-9a-f]{40}$/);

    const anchor = result.json.anchors.find(
      (entry: JsonRecord) => entry.qualified_name === 'Mixer.blend(first:second:)',
    );
    expect(anchor.state).toBe('fresh');
  }, 60_000);

  it('goes stale on a body change and names the file and lines', async () => {
    commitRevision(REVISION_BODY_CHANGED, 'change the body');

    const result = await check(readWrite);
    const anchor = result.json.anchors.find(
      (entry: JsonRecord) => entry.qualified_name === 'Mixer.blend(first:second:)',
    );

    expect(anchor.state).toBe('stale');
    expect(anchor.detail.reason).toBe('body_changed');
    expect(anchor.detail.file).toBe(SOURCE_FILE);
    expect(anchor.detail.line_start).toBeGreaterThan(0);
  }, 60_000);

  it('reports a rename as moved-renamed and names the new symbol', async () => {
    commitRevision(REVISION_RENAMED, 'rename the function');

    const result = await check(readWrite);
    const anchor = result.json.anchors.find(
      (entry: JsonRecord) => entry.qualified_name === 'Mixer.blend(first:second:)',
    );

    expect(anchor.state).toBe('moved-renamed');
    expect(anchor.detail.renamed_to).toBe('Mixer.combine(first:second:)');
  }, 60_000);

  it('re-baselines onto the new name when a reviewer confirms', async () => {
    const listed = await anchorsRoute.GET(
      request(readWrite, `/api/v1/pages/${pageId}/anchors`),
      params(pageId),
    );
    const before = await listed.json();
    const target = before.anchors.find(
      (entry: JsonRecord) => entry.qualified_name === 'Mixer.blend(first:second:)',
    );

    const response = await confirmRoute.POST(
      request(readWrite, `/api/v1/anchors/${target.anchor_id}/confirm`, {
        method: 'POST',
        body: '{}',
      }),
      anchorParams(target.anchor_id),
    );
    const confirmed = await response.json();

    expect(response.status).toBe(200);
    expect(confirmed.state).toBe('fresh');
    expect(confirmed.qualified_name).toBe('Mixer.combine(first:second:)');

    // And it stays fresh on the next check, which is the whole point of
    // re-baselining rather than merely clearing the badge.
    const after = await check(readWrite);
    const again = after.json.anchors.find(
      (entry: JsonRecord) => entry.qualified_name === 'Mixer.combine(first:second:)',
    );
    expect(again.state).toBe('fresh');

    const { and, eq } = await import('drizzle-orm');
    const audited = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.workspaceId, workspaceId),
          eq(schema.auditLog.action, 'anchor.confirmed'),
        ),
      );
    expect(audited.length).toBe(1);
    expect(audited[0]?.metadata?.previous_state).toBe('moved-renamed');
  }, 60_000);

  it('reports a move to another file as moved-renamed', async () => {
    const created = await createAnchor(readWrite, {
      file: SOURCE_FILE,
      qualified_name: 'Mixer',
      kind: 'struct',
    });
    expect(created.status).toBe(201);

    // Move the whole file. The declaration is unchanged; only its address is.
    const moved = 'Sources/Audio/Blending.swift';
    const from = path.join(sourceRepo, SOURCE_FILE);
    const to = path.join(sourceRepo, moved);
    mkdirSync(path.dirname(to), { recursive: true });
    git(['mv', SOURCE_FILE, moved], sourceRepo);
    git(
      [
        '-c',
        'user.email=tests@clewwiki.invalid',
        '-c',
        'user.name=clewwiki tests',
        'commit',
        '-q',
        '-m',
        'move the file',
      ],
      sourceRepo,
    );

    // With no read budget at all, the check must say it could not look rather
    // than report the anchors as lost, and must leave their stored state alone.
    const { checkPageAnchors, listAnchorsForPage } = await import('@/lib/anchors/service');
    const storedBefore = await listAnchorsForPage(workspaceId, pageId);
    const starved = await checkPageAnchors({
      workspaceId,
      pageId,
      actor: { type: 'agent', id: 'budget-test' },
      budget: { maxFiles: 0 },
    });
    expect(starved.complete).toBe(false);
    expect(starved.budget.limit).toBe('files');
    expect(starved.budget.filesRead).toBe(0);
    expect(starved.uncheckedAnchorIds.sort()).toEqual(storedBefore.map((entry) => entry.id).sort());
    const storedAfter = await listAnchorsForPage(workspaceId, pageId);
    expect(storedAfter.map((entry) => [entry.id, entry.state]).sort()).toEqual(
      storedBefore.map((entry) => [entry.id, entry.state]).sort(),
    );

    const result = await check(readWrite);
    expect(result.json.complete).toBe(true);
    expect(result.json.recomputed).toBe(true);
    const anchor = result.json.anchors.find(
      (entry: JsonRecord) => entry.qualified_name === 'Mixer' && entry.kind === 'struct',
    );
    expect(anchor.state).toBe('moved-renamed');
    expect(anchor.detail.moved_to).toBe(moved);

    // Put it back so the rest of the suite sees the file where it was.
    git(['mv', moved, SOURCE_FILE], sourceRepo);
    git(
      [
        '-c',
        'user.email=tests@clewwiki.invalid',
        '-c',
        'user.name=clewwiki tests',
        'commit',
        '-q',
        '-m',
        'move it back',
      ],
      sourceRepo,
    );
    expect(from).toContain(SOURCE_FILE);
  }, 120_000);

  it('anchors a line range and exposes the fallback share', async () => {
    const created = await createAnchor(readWrite, {
      file: SOURCE_FILE,
      line_start: 1,
      line_end: 2,
      section_id: 'Overview',
    });

    expect(created.status).toBe(201);
    expect(created.json.fallback).toBe(true);
    expect(created.json.section_id).toBe('Overview');

    const result = await check(readWrite);
    expect(result.json.fallback_share.total).toBeGreaterThan(0);
    expect(result.json.fallback_share.fallback).toBe(1);
    expect(result.json.fallback_share.share).toBeGreaterThan(0);

    const anchor = result.json.anchors.find((entry: JsonRecord) => entry.fallback === true);
    expect(anchor.state).toBe('fresh');
  }, 60_000);

  it('flags the line-range anchor when the lines change and loses it when they go', async () => {
    commitRevision(`import UIKit\n\n${REVISION_RENAMED.split('\n').slice(2).join('\n')}`, 'swap the import');

    const changed = await check(readWrite);
    const anchor = changed.json.anchors.find((entry: JsonRecord) => entry.fallback === true);
    expect(anchor.state).toBe('stale');
    expect(anchor.detail.reason).toBe('range_changed');

    // One line, no trailing newline: the anchored range 1–2 no longer exists.
    commitRevision('struct Mixer {}', 'shrink the file past the anchored range');
    const shrunk = await check(readWrite);
    const gone = shrunk.json.anchors.find((entry: JsonRecord) => entry.fallback === true);
    expect(gone.state).toBe('lost');

    // Restore the file for the remaining assertions.
    commitRevision(REVISION_RENAMED, 'restore');
  }, 120_000);

  it('carries anchors on the page resource and a stale count on tree nodes', async () => {
    // Put one anchor out of date on purpose: the badge is the thing under
    // test, and a tree of entirely fresh pages would assert nothing.
    commitRevision(
      REVISION_RENAMED.replace(
        'return total / Double(channels)',
        'return total / Double(max(channels, 1))',
      ),
      'change the renamed body',
    );
    await check(readWrite);

    const pageResponse = await pageRoute.GET(
      request(readWrite, `/api/v1/pages/${pageId}`),
      params(pageId),
    );
    const page = await pageResponse.json();
    expect(Array.isArray(page.anchors)).toBe(true);
    expect(page.anchors.length).toBeGreaterThan(0);

    const treeResponse = await treeRoute.GET(
      request(readWrite, `/api/v1/pages/${pageId}/tree`),
      params(pageId),
    );
    const tree = await treeResponse.json();
    const node = tree.nodes.find((entry: JsonRecord) => entry.page_id === pageId);
    expect(node.stale_anchor_count).toBeGreaterThan(0);
  }, 60_000);

  it('deletes an anchor', async () => {
    const listed = await anchorsRoute.GET(
      request(readWrite, `/api/v1/pages/${pageId}/anchors`),
      params(pageId),
    );
    const before = await listed.json();
    const victim = before.anchors.find((entry: JsonRecord) => entry.fallback === true);

    const response = await anchorRoute.DELETE(
      request(readWrite, `/api/v1/anchors/${victim.anchor_id}`, { method: 'DELETE' }),
      anchorParams(victim.anchor_id),
    );
    expect(response.status).toBe(200);

    const after = await anchorsRoute.GET(
      request(readWrite, `/api/v1/pages/${pageId}/anchors`),
      params(pageId),
    );
    const remaining = await after.json();
    expect(
      remaining.anchors.some((entry: JsonRecord) => entry.anchor_id === victim.anchor_id),
    ).toBe(false);
  }, 60_000);

  it('enforces scopes', async () => {
    const written = await createAnchor(readOnly, {
      file: SOURCE_FILE,
      qualified_name: 'Mixer',
      kind: 'struct',
    });
    expect(written.status).toBe(403);
    expect(written.json.error.code).toBe('insufficient_scope');

    // Recomputing stores new states, so it needs pages:write; a read scope gets
    // the states the last check stored, without touching the repository.
    const recompute = await check(readOnly);
    expect(recompute.status).toBe(403);
    expect(recompute.json.error.code).toBe('insufficient_scope');

    const auditRows = async () => {
      const { and, eq } = await import('drizzle-orm');
      return db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.workspaceId, workspaceId), eq(schema.auditLog.action, 'anchor.checked')));
    };
    const checksBefore = (await auditRows()).length;
    const stored = await checkRoute.GET(
      request(readOnly, `/api/v1/pages/${pageId}/anchors/check`),
      params(pageId),
    );
    expect(stored.status).toBe(200);
    const storedJson = await stored.json();
    expect(storedJson.recomputed).toBe(false);
    expect(storedJson.anchors.length).toBeGreaterThan(0);
    expect(typeof storedJson.checked_at).toBe('string');
    expect((await auditRows()).length).toBe(checksBefore);

    const refused = await check(noPageScope);
    expect(refused.status).toBe(403);
  }, 60_000);

  it('keeps anchors inside their workspace', async () => {
    const foreignRead = await anchorsRoute.GET(
      request(foreignToken, `/api/v1/pages/${pageId}/anchors`),
      params(pageId),
    );
    expect(foreignRead.status).toBe(404);

    const foreignCheck = await check(foreignToken);
    expect(foreignCheck.status).toBe(404);

    const listed = await anchorsRoute.GET(
      request(readWrite, `/api/v1/pages/${pageId}/anchors`),
      params(pageId),
    );
    const mine = await listed.json();
    const anchorId = mine.anchors[0].anchor_id as string;

    const foreignDelete = await anchorRoute.DELETE(
      request(foreignToken, `/api/v1/anchors/${anchorId}`, { method: 'DELETE' }),
      anchorParams(anchorId),
    );
    expect(foreignDelete.status).toBe(404);

    const foreignConfirm = await confirmRoute.POST(
      request(foreignToken, `/api/v1/anchors/${anchorId}/confirm`, {
        method: 'POST',
        body: '{}',
      }),
      anchorParams(anchorId),
    );
    expect(foreignConfirm.status).toBe(404);
  }, 60_000);

  it('answers not_found for a ref that does not exist', async () => {
    const result = await check(readWrite, pageId, '?ref=no-such-branch');
    expect(result.status).toBe(404);
    expect(result.json.error.code).toBe('not_found');
  }, 60_000);

  it('audits every check', async () => {
    const { and, eq } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.workspaceId, workspaceId),
          eq(schema.auditLog.action, 'anchor.checked'),
        ),
      );
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.metadata?.ref).toBe('main');
  });
  it('checks every anchor against the repository of its own space', async () => {
    // A second project, in a second space of the same workspace, with its own
    // repository — and a third space that has none linked yet.
    const otherRepo = path.join(scratch, 'router');
    mkdirSync(path.join(otherRepo, 'Sources'), { recursive: true });
    git(['init', '-q', '-b', 'main', '.'], otherRepo);
    writeFileSync(
      path.join(otherRepo, 'Sources/Router.swift'),
      'struct Router {\n    func route(path: String) -> String {\n        let trimmed = path\n        return trimmed\n    }\n}\n',
      'utf8',
    );
    git(['add', '-A'], otherRepo);
    git(
      ['-c', 'user.email=tests@clewwiki.invalid', '-c', 'user.name=clewwiki tests', 'commit', '-q', '-m', 'router'],
      otherRepo,
    );
    await db.insert(schema.spaces).values([
      {
        workspaceId,
        key: 'ROUTER',
        name: 'Router',
        settings: { repository: { url: `file://${otherRepo}`, default_ref: 'main' } },
      },
      { workspaceId, key: 'NOREPO', name: 'No repository' },
    ]);

    const createIn = async (space: string) => {
      const response = await pagesRoute.POST(
        request(readWrite, '/api/v1/pages', {
          method: 'POST',
          body: JSON.stringify({ space, title: 'Routing', path: `/${suiteTag}-routing` }),
        }),
      );
      expect(response.status).toBe(201);
      return ((await response.json()) as JsonRecord).page_id as string;
    };
    const routerPage = await createIn('ROUTER');
    const noRepoPage = await createIn('NOREPO');

    const inRouter = await anchorsRoute.POST(
      request(readWrite, `/api/v1/pages/${routerPage}/anchors`, {
        method: 'POST',
        body: JSON.stringify({ file: 'Sources/Router.swift', qualified_name: 'Router' }),
      }),
      params(routerPage),
    );
    expect(inRouter.status).toBe(201);

    // The same file does not exist in the MAIN space's repository.
    const inMain = await anchorsRoute.POST(
      request(readWrite, `/api/v1/pages/${pageId}/anchors`, {
        method: 'POST',
        body: JSON.stringify({ file: 'Sources/Router.swift', qualified_name: 'Router' }),
      }),
      params(pageId),
    );
    expect(inMain.status).toBe(400);
    expect(((await inMain.json()) as JsonRecord).error.message).toContain('File not found');

    const noRepo = await anchorsRoute.POST(
      request(readWrite, `/api/v1/pages/${noRepoPage}/anchors`, {
        method: 'POST',
        body: JSON.stringify({ file: 'Sources/Router.swift', qualified_name: 'Router' }),
      }),
      params(noRepoPage),
    );
    expect(noRepo.status).toBe(400);
    expect(((await noRepo.json()) as JsonRecord).error.message).toContain('This space has no source repository');

    const checked = await check(readWrite, routerPage);
    expect(checked.status).toBe(200);
    expect(checked.json.anchors).toHaveLength(1);
    expect(checked.json.anchors[0].state).toBe('fresh');
    // The share describes this space's anchors only.
    expect(checked.json.fallback_share.total).toBe(1);
  }, 120_000);
  it('anchors Kotlin declarations, overloads and extensions included', async () => {
    const kotlinRepo = path.join(scratch, 'android');
    const file = 'app/src/main/kotlin/shop/Checkout.kt';
    const source = [
      'package shop',
      '',
      'fun String.slug(): String = lowercase()',
      '',
      'class Checkout(private val gateway: Gateway) {',
      '    fun pay(items: List<Item>): Receipt {',
      '        val amount = items.sumOf { it.price }',
      '        return gateway.charge(amount)',
      '    }',
      '',
      '    fun pay(item: Item): Receipt = gateway.charge(item.price)',
      '}',
      '',
    ].join('\n');
    const commit = (text: string, message: string) => {
      mkdirSync(path.dirname(path.join(kotlinRepo, file)), { recursive: true });
      writeFileSync(path.join(kotlinRepo, file), text, 'utf8');
      git(['add', '-A'], kotlinRepo);
      git(['-c', 'user.email=tests@clewwiki.invalid', '-c', 'user.name=clewwiki tests', 'commit', '-q', '-m', message], kotlinRepo);
    };
    mkdirSync(kotlinRepo, { recursive: true });
    git(['init', '-q', '-b', 'main', '.'], kotlinRepo);
    commit(source, 'checkout');

    await db.insert(schema.spaces).values({
      workspaceId,
      key: 'ANDROID',
      name: 'Android',
      settings: { repository: { url: `file://${kotlinRepo}`, default_ref: 'main' } },
    });
    const made = await pagesRoute.POST(
      request(readWrite, '/api/v1/pages', {
        method: 'POST',
        body: JSON.stringify({ space: 'ANDROID', title: 'Checkout', path: `/${suiteTag}-checkout` }),
      }),
    );
    expect(made.status).toBe(201);
    const kotlinPage = ((await made.json()) as JsonRecord).page_id as string;

    const anchorOn = async (qualifiedName: string) => {
      const response = await anchorsRoute.POST(
        request(readWrite, `/api/v1/pages/${kotlinPage}/anchors`, {
          method: 'POST',
          body: JSON.stringify({ file, qualified_name: qualifiedName }),
        }),
        params(kotlinPage),
      );
      return { status: response.status, json: (await response.json()) as JsonRecord };
    };

    const overload = await anchorOn('Checkout.pay(items)');
    expect(overload.status, JSON.stringify(overload.json)).toBe(201);
    expect(overload.json.language).toBe('kotlin');
    expect(overload.json.kind).toBe('fun');
    expect((await anchorOn('Checkout.pay(item)')).status).toBe(201);
    expect((await anchorOn('String.slug()')).status).toBe(201);
    // Without its parameters an overloaded name says nothing about which one.
    expect((await anchorOn('Checkout.pay')).status).toBe(400);

    commit(source.replace('items.sumOf { it.price }', 'items.sumOf { it.price } + 1'), 'surcharge');
    const checked = await check(readWrite, kotlinPage);
    expect(checked.status).toBe(200);
    const states = Object.fromEntries(
      (checked.json.anchors as JsonRecord[]).map((anchor) => [anchor.qualified_name, anchor.state]),
    );
    expect(states).toEqual({
      'Checkout.pay(items)': 'stale',
      'Checkout.pay(item)': 'fresh',
      'String.slug()': 'fresh',
    });
  }, 120_000);
});
