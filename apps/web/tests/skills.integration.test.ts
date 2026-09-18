import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ClewwikiDb from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';
import { createTestAccount } from './helpers/session';
import type { TestAccount } from './helpers/session';

import type * as SpaceRoute from '@/app/api/v1/spaces/[key]/route';
import type * as RulesRoute from '@/app/api/v1/spaces/[key]/rules/route';
import type * as SkillsRoute from '@/app/api/v1/spaces/[key]/skills/route';
import type * as SkillRoute from '@/app/api/v1/spaces/[key]/skills/[slug]/route';
import type * as PagesRoute from '@/app/api/v1/pages/route';
import type * as AuditRoute from '@/app/api/v1/audit/route';

const probe = await prepareTestDatabase();

if (!probe.reachable) {
  console.warn(`[integration] skipping skills suite: ${probe.reason}`);
}

process.env.DATABASE_URL = databaseUrl;
process.env.BETTER_AUTH_SECRET ??= 'integration-test-secret-value-not-used-in-production';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.AGENT_TOKEN_RATE_LIMIT_MAX ??= '1000';

const session = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('@/lib/session', () => ({ getSessionContext: async () => session.current }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const BASE = 'http://localhost:3000';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonRecord = Record<string, any>;

describe.skipIf(!probe.reachable)('rules and skills', () => {
  let db: Database;
  let schema: typeof ClewwikiDb;

  let spaceRoute: typeof SpaceRoute;
  let rulesRoute: typeof RulesRoute;
  let skillsRoute: typeof SkillsRoute;
  let skillRoute: typeof SkillRoute;
  let pagesRoute: typeof PagesRoute;
  let auditRoute: typeof AuditRoute;

  const suiteTag = `sk-${randomUUID().slice(0, 8)}`;
  let workspaceId = '';
  let admin: TestAccount;
  const userIds: string[] = [];

  /** A token for every space, and one limited to SKA. */
  let everywhere = '';
  let onlyA = '';
  let readOnly = '';
  let writeOnly = '';
  let skaId = '';
  let skbId = '';

  async function seedToken(name: string, scopes: string[], spaceIds: string[] | null): Promise<string> {
    const { generateAgentToken } = await import('@/lib/agent-token-crypto');
    const generated = generateAgentToken();
    await db.insert(schema.agentTokens).values({
      workspaceId,
      name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes,
      spaceIds,
    });
    return generated.token;
  }

  function bearer(token: string, target: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${target}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  function cookie(account: TestAccount, target: string, init: RequestInit = {}): Request {
    return new Request(`${BASE}${target}`, {
      ...init,
      headers: {
        cookie: account.cookie,
        origin: BASE,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });
  const slugParams = (key: string, slug: string) => ({ params: Promise.resolve({ key, slug }) });

  async function json(response: Response): Promise<{ status: number; body: JsonRecord }> {
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as JsonRecord) };
  }

  async function createSkill(
    token: string,
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: JsonRecord }> {
    return json(
      await skillsRoute.POST(
        bearer(token, `/api/v1/spaces/${key}/skills`, { method: 'POST', body: JSON.stringify(body) }),
        keyParams(key),
      ),
    );
  }

  beforeAll(async () => {
    schema = await import('@clewwiki/db');
    db = schema.getDatabase();

    spaceRoute = await import('@/app/api/v1/spaces/[key]/route');
    rulesRoute = await import('@/app/api/v1/spaces/[key]/rules/route');
    skillsRoute = await import('@/app/api/v1/spaces/[key]/skills/route');
    skillRoute = await import('@/app/api/v1/spaces/[key]/skills/[slug]/route');
    pagesRoute = await import('@/app/api/v1/pages/route');
    auditRoute = await import('@/app/api/v1/audit/route');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `Skills ${suiteTag}`, slug: `${suiteTag}-ws` })
      .returning();
    workspaceId = workspace!.id;

    admin = await createTestAccount({ db, schema, workspaceId, role: 'admin', tag: suiteTag });
    userIds.push(admin.userId);

    const [ska] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: 'SKA', name: 'Alpha' })
      .returning();
    const [skb] = await db
      .insert(schema.spaces)
      .values({ workspaceId, key: 'SKB', name: 'Beta' })
      .returning();
    skaId = ska!.id;
    skbId = skb!.id;

    everywhere = await seedToken('everywhere', ['pages:read', 'pages:write', 'pages:delete'], null);
    onlyA = await seedToken('only-a', ['pages:read', 'pages:write', 'pages:delete'], [skaId]);
    readOnly = await seedToken('read-only', ['pages:read'], null);
    writeOnly = await seedToken('write-no-delete', ['pages:read', 'pages:write'], null);
  });

  afterAll(async () => {
    if (!probe.reachable) return;
    await db.delete(schema.workspaces).where(
      (await import('drizzle-orm')).eq(schema.workspaces.id, workspaceId),
    );
    const { inArray } = await import('drizzle-orm');
    if (userIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
  });

  /* ---------------- rules ---------------- */

  describe('GET /api/v1/spaces/{key}/rules', () => {
    it('answers 404 until a page is designated, then the page itself', async () => {
      const before = await json(
        await rulesRoute.GET(bearer(readOnly, '/api/v1/spaces/SKA/rules'), keyParams('SKA')),
      );
      expect(before.status).toBe(404);
      expect(before.body.error.code).toBe('not_found');

      const page = await json(
        await pagesRoute.POST(
          bearer(everywhere, '/api/v1/pages', {
            method: 'POST',
            body: JSON.stringify({
              space: 'SKA',
              title: 'Project rules',
              kind: 'technical',
              slug: 'rules',
              body: '# Project rules\n\nUse pnpm.\n',
            }),
          }),
        ),
      );
      expect(page.status).toBe(201);

      const designated = await json(
        await spaceRoute.PATCH(
          cookie(admin, '/api/v1/spaces/SKA', {
            method: 'PATCH',
            body: JSON.stringify({ rules_page_id: page.body.page_id }),
          }),
          keyParams('SKA'),
        ),
      );
      expect(designated.status).toBe(200);
      expect(designated.body.rules_page_id).toBe(page.body.page_id);

      const after = await json(
        await rulesRoute.GET(bearer(readOnly, '/api/v1/spaces/SKA/rules'), keyParams('SKA')),
      );
      expect(after.status).toBe(200);
      expect(after.body).toMatchObject({
        page_id: page.body.page_id,
        path: '/rules',
        title: 'Project rules',
        space: { key: 'SKA' },
      });
      expect(after.body.body).toContain('Use pnpm');
      expect(after.body.content_hash).toBe(page.body.content_hash);
    });

    it('refuses a page from another space as the rules page', async () => {
      const elsewhere = await json(
        await pagesRoute.POST(
          bearer(everywhere, '/api/v1/pages', {
            method: 'POST',
            body: JSON.stringify({ space: 'SKB', title: 'Elsewhere', kind: 'technical' }),
          }),
        ),
      );
      const refused = await json(
        await spaceRoute.PATCH(
          cookie(admin, '/api/v1/spaces/SKA', {
            method: 'PATCH',
            body: JSON.stringify({ rules_page_id: elsewhere.body.page_id }),
          }),
          keyParams('SKA'),
        ),
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error.message).toContain('rules page');
    });

    it('hides a space the token may not see, rules and all', async () => {
      const hidden = await json(
        await rulesRoute.GET(bearer(onlyA, '/api/v1/spaces/SKB/rules'), keyParams('SKB')),
      );
      expect(hidden.status).toBe(404);
    });
  });

  /* ---------------- skills ---------------- */

  describe('the skills registry', () => {
    it('creates a skill, generating the slug from the name, and lists it without the body', async () => {
      const created = await createSkill(everywhere, 'SKA', {
        name: 'Release checks',
        description: 'Use before tagging a release.',
        version: '1.2.0',
        tags: ['release', 'CI'],
        body: '# Release checks\n\nRun the suite, then tag.\n',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        slug: 'release-checks',
        name: 'Release checks',
        version: '1.2.0',
        // Tags are lowercased and de-duplicated on the way in.
        tags: ['release', 'ci'],
        space: { key: 'SKA' },
      });
      expect(created.body.skill_md).toContain('name: Release checks');
      expect(created.body.skill_md).toContain('Run the suite, then tag.');
      expect(created.body.install.command).toContain('skills install --space SKA --only release-checks');
      expect(created.body.install.path).toBe('~/.claude/skills/release-checks/SKILL.md');

      const listed = await json(
        await skillsRoute.GET(bearer(readOnly, '/api/v1/spaces/SKA/skills'), keyParams('SKA')),
      );
      expect(listed.status).toBe(200);
      expect(listed.body.skills).toEqual([
        expect.objectContaining({
          slug: 'release-checks',
          name: 'Release checks',
          description: 'Use before tagging a release.',
          version: '1.2.0',
          tags: ['release', 'ci'],
        }),
      ]);
      expect(listed.body.skills[0].body).toBeUndefined();
    });

    it('takes a whole SKILL.md and stores its fields as columns and its body without front matter', async () => {
      const created = await createSkill(everywhere, 'SKA', {
        body: [
          '---',
          'name: Database migrations',
          'description: Use when adding a column.',
          'version: 0.1',
          'tags: [db, sql]',
          '---',
          '',
          '# Migrations',
          '',
          'Generate, then review the SQL.',
          '',
        ].join('\n'),
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        slug: 'database-migrations',
        name: 'Database migrations',
        description: 'Use when adding a column.',
        version: '0.1',
        tags: ['db', 'sql'],
      });
      expect(created.body.body.startsWith('# Migrations')).toBe(true);
      expect(created.body.body).not.toContain('---');
    });

    it('names the field and the line when the front matter does not parse', async () => {
      const missing = await createSkill(everywhere, 'SKA', {
        body: '---\nname: x\n---\nBody\n',
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe('validation');
      expect(missing.body.error.message).toContain('description');
      expect(missing.body.error.details).toMatchObject({ front_matter: true, line: 1 });
      expect(missing.body.error.details.errors[0].path).toBe('description');

      const unknown = await createSkill(everywhere, 'SKA', {
        body: '---\nname: x\ndescription: y\nlicense: MIT\n---\nBody\n',
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.details.errors[0]).toMatchObject({ path: 'license' });

      const unterminated = await createSkill(everywhere, 'SKA', {
        body: '---\nname: x\ndescription: y\nBody\n',
      });
      expect(unterminated.status).toBe(400);
      expect(unterminated.body.error.message).toContain('never closes');
    });

    it('refuses a skill with no name or no description, and a slug that is not a directory name', async () => {
      const noName = await createSkill(everywhere, 'SKA', { description: 'x', body: 'Body' });
      expect(noName.status).toBe(400);
      expect(noName.body.error.message).toContain('name');

      const noDescription = await createSkill(everywhere, 'SKA', { name: 'x', body: 'Body' });
      expect(noDescription.status).toBe(400);
      expect(noDescription.body.error.message).toContain('description');

      for (const slug of ['../escape', 'has space', 'trailing-', 'a/b', '.hidden']) {
        const refused = await createSkill(everywhere, 'SKA', {
          name: 'x',
          description: 'y',
          slug,
        });
        expect(refused.status, slug).toBe(400);
      }

      // A slug typed in capitals is normalised rather than refused, the way a
      // space key is: the rule is about what a directory may be called, and
      // `Upper` names the same directory as `upper` on a case-insensitive
      // file system.
      const normalized = await createSkill(everywhere, 'SKA', {
        name: 'Capitals',
        description: 'Typed with capitals.',
        slug: ' Upper-Case ',
      });
      expect(normalized.status).toBe(201);
      expect(normalized.body.slug).toBe('upper-case');
    });

    it('refuses a body over the size limit', async () => {
      const tooBig = await createSkill(everywhere, 'SKA', {
        name: 'Huge',
        description: 'Too much.',
        body: 'x'.repeat(262_145),
      });
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.error.details.limit_bytes).toBe(262_144);
    });

    it('numbers a generated slug that is taken, and refuses an explicit one that is', async () => {
      const second = await createSkill(everywhere, 'SKA', {
        name: 'Release checks',
        description: 'A second one with the same name.',
      });
      expect(second.status).toBe(201);
      expect(second.body.slug).toBe('release-checks-2');

      const clash = await createSkill(everywhere, 'SKA', {
        name: 'Third',
        description: 'Explicitly asking for a taken slug.',
        slug: 'release-checks',
      });
      expect(clash.status).toBe(409);
      expect(clash.body.error.details.slug).toBe('release-checks');
    });

    it('filters a listing by tag', async () => {
      const tagged = await json(
        await skillsRoute.GET(bearer(readOnly, '/api/v1/spaces/SKA/skills?tag=db'), keyParams('SKA')),
      );
      expect(tagged.body.skills.map((skill: JsonRecord) => skill.slug)).toEqual(['database-migrations']);

      const none = await json(
        await skillsRoute.GET(bearer(readOnly, '/api/v1/spaces/SKA/skills?tag=nope'), keyParams('SKA')),
      );
      expect(none.body.skills).toEqual([]);
    });

    it("keeps each space's skills to itself", async () => {
      await createSkill(everywhere, 'SKB', { name: 'Beta only', description: 'Only in SKB.' });

      const inB = await json(
        await skillsRoute.GET(bearer(readOnly, '/api/v1/spaces/SKB/skills'), keyParams('SKB')),
      );
      expect(inB.body.skills.map((skill: JsonRecord) => skill.slug)).toEqual(['beta-only']);

      const crossRead = await json(
        await skillRoute.GET(
          bearer(readOnly, '/api/v1/spaces/SKA/skills/beta-only'),
          slugParams('SKA', 'beta-only'),
        ),
      );
      expect(crossRead.status).toBe(404);
    });

    it('answers 404 for a space a restricted token cannot see, for reads and writes alike', async () => {
      const listed = await json(
        await skillsRoute.GET(bearer(onlyA, '/api/v1/spaces/SKB/skills'), keyParams('SKB')),
      );
      expect(listed.status).toBe(404);

      const written = await createSkill(onlyA, 'SKB', { name: 'x', description: 'y' });
      expect(written.status).toBe(404);
    });

    it('updates a skill, and renaming its slug frees the old one', async () => {
      const updated = await json(
        await skillRoute.PATCH(
          bearer(everywhere, '/api/v1/spaces/SKA/skills/release-checks-2', {
            method: 'PATCH',
            body: JSON.stringify({ name: 'Renamed', slug: 'renamed', tags: ['release'] }),
          }),
          slugParams('SKA', 'release-checks-2'),
        ),
      );
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ slug: 'renamed', name: 'Renamed', tags: ['release'] });

      const gone = await json(
        await skillRoute.GET(
          bearer(readOnly, '/api/v1/spaces/SKA/skills/release-checks-2'),
          slugParams('SKA', 'release-checks-2'),
        ),
      );
      expect(gone.status).toBe(404);
    });

    it('needs pages:write to create and pages:delete to remove', async () => {
      const refusedWrite = await createSkill(readOnly, 'SKA', { name: 'x', description: 'y' });
      expect(refusedWrite.status).toBe(403);
      expect(refusedWrite.body.error.code).toBe('insufficient_scope');

      const refusedDelete = await json(
        await skillRoute.DELETE(
          bearer(writeOnly, '/api/v1/spaces/SKA/skills/renamed', { method: 'DELETE' }),
          slugParams('SKA', 'renamed'),
        ),
      );
      expect(refusedDelete.status).toBe(403);

      const deleted = await json(
        await skillRoute.DELETE(
          bearer(everywhere, '/api/v1/spaces/SKA/skills/renamed', { method: 'DELETE' }),
          slugParams('SKA', 'renamed'),
        ),
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body).toMatchObject({ slug: 'renamed', deleted: true });

      // A deleted slug is free again, the way a deleted page's path is.
      const reused = await createSkill(everywhere, 'SKA', {
        name: 'Renamed again',
        description: 'Taking the freed slug.',
        slug: 'renamed',
      });
      expect(reused.status).toBe(201);
    });

    it('audits every write under its own action', async () => {
      const log = await json(
        await auditRoute.GET(cookie(admin, '/api/v1/audit?limit=200')),
      );
      expect(log.status).toBe(200);
      const actions = (log.body.entries as JsonRecord[]).map((entry) => entry.action);
      expect(actions).toContain('skill.created');
      expect(actions).toContain('skill.updated');
      expect(actions).toContain('skill.deleted');
      expect(actions).toContain('space.updated');
    });

    it('refuses new skills in an archived space', async () => {
      await db
        .update(schema.spaces)
        .set({ archivedAt: new Date() })
        .where((await import('drizzle-orm')).eq(schema.spaces.id, skbId));

      const refused = await createSkill(everywhere, 'SKB', { name: 'x', description: 'y' });
      expect(refused.status).toBe(409);

      // Reading what is already there still works: archiving hides, it does
      // not take away.
      const listed = await json(
        await skillsRoute.GET(bearer(readOnly, '/api/v1/spaces/SKB/skills'), keyParams('SKB')),
      );
      expect(listed.status).toBe(200);
      expect(listed.body.skills.length).toBe(1);
    });
  });
});
