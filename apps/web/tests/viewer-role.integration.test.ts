import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

/**
 * The viewer role over REST, against a real database. Every route that writes
 * is found on disk and called as a viewer, so a route added next year is swept
 * without anybody remembering to add it here: a viewer gets `403` from all of
 * them, and the same request from an editor is *not* refused for its role.
 */

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping viewer role suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';
const apiRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'api', 'v1');
const METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

interface WriteRoute {
  /** `pages/[id]/claims` */
  pattern: string;
  methods: Array<(typeof METHODS)[number]>;
}

const writeRoutes: WriteRoute[] = routeFiles(apiRoot)
  .map((file) => {
    const source = readFileSync(file, 'utf8');
    return {
      pattern: path.relative(apiRoot, path.dirname(file)),
      methods: METHODS.filter((method) => new RegExp(`export async function ${method}\\b`).test(source)),
    };
  })
  .filter((route) => route.methods.length > 0)
  .sort((a, b) => a.pattern.localeCompare(b.pattern));

/** The one write a viewer is meant to make: their own read mark. */
const OPEN_TO_VIEWERS = new Set(['inbox/read']);

describe.skipIf(!probe.reachable)('the viewer role over REST', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;
  let drizzle: typeof DrizzleOrm;

  const suiteTag = `vr-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let viewer: TestAccount;
  let editor: TestAccount;
  let spaceKey = '';
  let pageId = '';

  function request(account: TestAccount, pattern: string, method: string): { request: Request; params: Record<string, string> } {
    const params: Record<string, string> = {};
    const url = pattern.replace(/\[(\w+)\]/g, (_match, name: string) => {
      const value = name === 'key' ? spaceKey : name === 'slug' ? 'a-skill' : name === 'id' && pattern.startsWith('pages/') ? pageId : randomUUID();
      params[name] = value;
      return value;
    });
    const image = pattern.endsWith('/images');
    const body = image ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : '{}';
    return {
      params,
      request: new Request(`${BASE}/api/v1/${url}`, {
        method,
        body,
        headers: {
          cookie: account.cookie,
          origin: BASE,
          'content-type': image ? 'image/png' : 'application/json',
          'content-length': String(image ? 8 : 2),
        },
      }),
    };
  }

  async function call(account: TestAccount, route: WriteRoute, method: string): Promise<{ status: number; code: string }> {
    const module_ = (await import(`@/app/api/v1/${route.pattern}/route`)) as Record<
      string,
      (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>
    >;
    const built = request(account, route.pattern, method);
    const response = await module_[method]!(built.request, { params: Promise.resolve(built.params) });
    const text = await response.text();
    let code = '';
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? '';
    } catch {
      code = '';
    }
    return { status: response.status, code };
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    drizzle = await import('drizzle-orm');
    db = schema.getDatabase();

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Viewer ${suiteTag}`, slug: `viewer-${suiteTag}` })
      .returning();
    workspaceId = workspace?.id ?? '';
    viewer = await createTestAccount({ db, schema, workspaceId, role: 'viewer', tag: suiteTag });
    editor = await createTestAccount({ db, schema, workspaceId, role: 'editor', tag: suiteTag });

    spaceKey = `VR${suiteTag.slice(3, 7).toUpperCase()}`;
    const [space] = await db.insert(schema.spaces).values({ workspaceId, key: spaceKey, name: 'Read me' }).returning();
    const pages = await import('@/lib/pages/service');
    const page = await pages.createPage({
      workspaceId,
      spaceId: space?.id ?? '',
      actor: { type: 'user', id: editor.userId },
      title: 'A page to read',
      body: 'Readable by everybody in the workspace.',
      kind: 'human',
    });
    pageId = page.id;
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    if (workspaceId) await db.delete(schema.workspaces).where(drizzle.eq(schema.workspaces.id, workspaceId));
    const ids = [viewer?.userId, editor?.userId].filter((id): id is string => typeof id === 'string');
    if (ids.length > 0) await db.delete(schema.users).where(drizzle.inArray(schema.users.id, ids));
    await schema.getDatabaseHandle().sql.end({ timeout: 5 });
  });

  it('finds the routes that write', () => {
    expect(writeRoutes.length).toBeGreaterThanOrEqual(35);
  });

  it('refuses a viewer at every route that writes', async () => {
    const let_through: string[] = [];
    for (const route of writeRoutes) {
      if (OPEN_TO_VIEWERS.has(route.pattern)) continue;
      for (const method of route.methods) {
        const answer = await call(viewer, route, method);
        if (answer.status !== 403) let_through.push(`${method} ${route.pattern} → ${answer.status} ${answer.code}`);
      }
    }
    expect(let_through).toEqual([]);
  });

  it('lets a viewer read, and keep their own inbox', async () => {
    const pageRoute = await import('@/app/api/v1/pages/[id]/route');
    const read = await pageRoute.GET(new Request(`${BASE}/api/v1/pages/${pageId}`, { headers: { cookie: viewer.cookie } }), {
      params: Promise.resolve({ id: pageId }),
    });
    expect(read.status).toBe(200);

    const inboxRead = await import('@/app/api/v1/inbox/read/route');
    const marked = await inboxRead.POST(
      new Request(`${BASE}/api/v1/inbox/read`, {
        method: 'POST',
        body: '{}',
        headers: { cookie: viewer.cookie, origin: BASE, 'content-type': 'application/json' },
      }),
    );
    expect(marked.status).toBe(200);

    const me = await import('@/app/api/v1/me/route');
    const identity = await me.GET(new Request(`${BASE}/api/v1/me`, { headers: { cookie: viewer.cookie } }));
    expect(identity.status).toBe(200);
  });

  // Last: an editor's DELETE is real, and takes the page with it.
  it('does not refuse an editor for their role at the routes content is written through', async () => {
    const refused: string[] = [];
    for (const route of writeRoutes) {
      // Administrator-only routes refuse an editor too, which is a different rule.
      if (/^(spaces\/\[key\]\/(archive|unarchive|members)|spaces\/\[key\]$|spaces$|pages\/\[id\]\/restore)/.test(route.pattern)) continue;
      for (const method of route.methods) {
        const answer = await call(editor, route, method);
        if (answer.status === 403 && answer.code === 'forbidden') refused.push(`${method} ${route.pattern}`);
      }
    }
    expect(refused).toEqual([]);
  });
});
