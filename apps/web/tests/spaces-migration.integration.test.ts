import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlClient } from '@clewwiki/db';

import { databaseUrl, prepareTestDatabase } from './helpers/database';

/**
 * Migration `0004_spaces` run against a database that already holds data from
 * before spaces existed: pages in a tree, a soft-deleted page, a revision, a
 * live claim with a note, an anchor, a technical/human pair, an agent token and
 * a workspace-level repository setting.
 *
 * The suite needs to create a database of its own, because the schema it starts
 * from is the one before the migration. It skips, with a message, when the
 * test role may not create databases.
 */

const probe = await prepareTestDatabase();

interface Scratch {
  url: string;
  name: string;
}

async function createScratchDatabase(): Promise<Scratch | { error: string }> {
  if (!databaseUrl) return { error: 'TEST_DATABASE_URL is not set' };
  const name = `clewwiki_migration_${randomBytes(4).toString('hex')}`;
  const { createDatabase } = await import('@clewwiki/db');
  const admin = createDatabase(databaseUrl, { max: 1 }).sql;
  try {
    await admin.unsafe(`create database ${name}`);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return { url: url.toString(), name };
}

const scratch = probe.reachable ? await createScratchDatabase() : { error: 'no test database' };
const canRun = probe.reachable && 'url' in scratch;
if (!canRun) {
  console.warn(`[integration] skipping spaces migration suite: ${'error' in scratch ? scratch.error : ''}`);
}

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!canRun)('migration 0004_spaces on an existing database', () => {
  const { url, name } = scratch as Scratch;
  let sql: SqlClient;
  let before = '';

  const ids = {
    withPages: '00000000-0000-4000-8000-00000000a001',
    empty: '00000000-0000-4000-8000-00000000a002',
    repoOnly: '00000000-0000-4000-8000-00000000a003',
    backend: '00000000-0000-4000-8000-00000000b001',
    auth: '00000000-0000-4000-8000-00000000b002',
    human: '00000000-0000-4000-8000-00000000b003',
    deleted: '00000000-0000-4000-8000-00000000b004',
    claim: '00000000-0000-4000-8000-00000000c001',
    anchor: '00000000-0000-4000-8000-00000000d001',
    token: '00000000-0000-4000-8000-00000000e001',
  };
  const repository = { url: 'https://git.example.com/org/app.git', default_ref: 'main', auth_token_env: 'CLEWWIKI_GIT_TOKEN' };

  beforeAll(async () => {
    const { createDatabase, runMigrations } = await import('@clewwiki/db');

    // The migrations folder as it stood before spaces: 0000–0003 only.
    before = mkdtempSync(path.join(tmpdir(), 'clewwiki-migrations-before-'));
    cpSync(MIGRATIONS, before, { recursive: true });
    rmSync(path.join(before, '0004_spaces.sql'));
    rmSync(path.join(before, 'meta', '0004_snapshot.json'));
    const journalPath = path.join(before, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 3);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));

    await runMigrations(url, before);

    sql = createDatabase(url, { max: 1 }).sql;
    const hash = 'a'.repeat(64);

    await sql`
      insert into workspaces (id, name, slug, settings) values
        (${ids.withPages}, 'Acme engineering', 'default', ${JSON.stringify({ claim_ttl_seconds: 300, repository })}::jsonb),
        (${ids.empty}, 'Empty', 'empty', '{}'::jsonb),
        (${ids.repoOnly}, 'Repo only', 'repo-only', ${JSON.stringify({ repository })}::jsonb)
    `;
    await sql`
      insert into pages (id, workspace_id, parent_id, path, title, kind, body, content_hash,
                         created_by_type, created_by_id, updated_by_type, updated_by_id, deleted_at)
      values
        (${ids.backend}, ${ids.withPages}, null, '/backend', 'Backend', 'technical', 'b', ${hash}, 'user', 'u1', 'user', 'u1', null),
        (${ids.auth}, ${ids.withPages}, ${ids.backend}, '/backend/auth', 'Auth', 'technical', 'a', ${hash}, 'agent', 't1', 'agent', 't1', null),
        (${ids.human}, ${ids.withPages}, null, '/auth-explained', 'Auth explained', 'human', 'h', ${hash}, 'user', 'u1', 'user', 'u1', null),
        (${ids.deleted}, ${ids.withPages}, null, '/old', 'Old', 'technical', 'o', ${hash}, 'user', 'u1', 'user', 'u1', now())
    `;
    await sql`update pages set linked_page_id = ${ids.human} where id = ${ids.auth}`;
    await sql`update pages set linked_page_id = ${ids.auth} where id = ${ids.human}`;
    await sql`
      insert into page_revisions (page_id, version, title, body, content_hash, author_type, author_id)
      values (${ids.auth}, 1, 'Auth', 'a', ${hash}, 'agent', 't1')
    `;
    await sql`
      insert into claims (id, workspace_id, page_id, holder_type, holder_id, holder_label, base_content_hash, expires_at)
      values (${ids.claim}, ${ids.withPages}, ${ids.auth}, 'agent', 't1', 'writer', ${hash}, now() + interval '1 hour')
    `;
    await sql`
      insert into claim_notes (claim_id, workspace_id, text, author_type, author_id, author_label, expires_at)
      values (${ids.claim}, ${ids.withPages}, 'rewriting', 'agent', 't1', 'writer', now() + interval '1 hour')
    `;
    await sql`
      insert into anchors (id, workspace_id, page_id, language, kind, qualified_name, file_hint, token_hash, created_by_type, created_by_id)
      values (${ids.anchor}, ${ids.withPages}, ${ids.auth}, 'swift', 'func', 'Auth.login()', 'Sources/Auth.swift', ${hash}, 'user', 'u1')
    `;
    await sql`
      insert into agent_tokens (id, workspace_id, name, prefix, token_hash, scopes)
      values (${ids.token}, ${ids.withPages}, 'ci', ${`p${randomBytes(4).toString('hex')}`}, ${hash}, ${JSON.stringify(['pages:read'])}::jsonb)
    `;

    // Now the real folder: only 0004 is pending.
    await runMigrations(url);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (before) rmSync(before, { recursive: true, force: true });
    const { createDatabase } = await import('@clewwiki/db');
    const admin = createDatabase(databaseUrl, { max: 1 }).sql;
    try {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it('creates a MAIN space for each workspace with pages or a repository, named after it', async () => {
    const rows = await sql<Array<{ workspace_id: string; key: string; name: string; settings: Record<string, unknown> }>>`
      select workspace_id, key, name, settings from spaces order by name
    `;
    expect(rows.map((row) => [row.workspace_id, row.key, row.name])).toEqual([
      [ids.withPages, 'MAIN', 'Acme engineering'],
      [ids.repoOnly, 'MAIN', 'Repo only'],
    ]);
  });

  it('copies the repository onto the space and removes it from the workspace, keeping other settings', async () => {
    const [space] = await sql<Array<{ settings: Record<string, unknown> }>>`
      select settings from spaces where workspace_id = ${ids.withPages}
    `;
    expect(space?.settings).toEqual({ repository });

    const workspaces = await sql<Array<{ id: string; settings: Record<string, unknown> }>>`
      select id, settings from workspaces order by slug
    `;
    const byId = new Map(workspaces.map((row) => [row.id, row.settings]));
    expect(byId.get(ids.withPages)).toEqual({ claim_ttl_seconds: 300 });
    expect(byId.get(ids.repoOnly)).toEqual({});
    expect(byId.get(ids.empty)).toEqual({});
  });

  it('assigns every page, deleted ones included, to the space', async () => {
    const rows = await sql<Array<{ id: string; key: string }>>`
      select p.id, s.key from pages p join spaces s on s.id = p.space_id and s.workspace_id = p.workspace_id
      order by p.id
    `;
    expect(rows).toEqual(
      [ids.backend, ids.auth, ids.human, ids.deleted].sort().map((id) => ({ id, key: 'MAIN' })),
    );
    const [nullCount] = await sql<Array<{ count: number }>>`select count(*)::int as count from pages where space_id is null`;
    expect(nullCount?.count).toBe(0);
  });

  it('keeps the tree, the pair, revisions, the claim, its note and the anchor intact', async () => {
    const [auth] = await sql<Array<{ parent_id: string; linked_page_id: string; path: string }>>`
      select parent_id, linked_page_id, path from pages where id = ${ids.auth}
    `;
    expect(auth).toEqual({ parent_id: ids.backend, linked_page_id: ids.human, path: '/backend/auth' });

    const [counts] = await sql<Array<{ revisions: number; claims: number; notes: number; anchors: number }>>`
      select (select count(*)::int from page_revisions where page_id = ${ids.auth}) as revisions,
             (select count(*)::int from claims where page_id = ${ids.auth} and released_at is null) as claims,
             (select count(*)::int from claim_notes where claim_id = ${ids.claim}) as notes,
             (select count(*)::int from anchors where page_id = ${ids.auth}) as anchors
    `;
    expect(counts).toEqual({ revisions: 1, claims: 1, notes: 1, anchors: 1 });
  });

  it('leaves existing tokens reaching every space', async () => {
    const [token] = await sql<Array<{ space_ids: unknown }>>`select space_ids from agent_tokens where id = ${ids.token}`;
    expect(token?.space_ids).toBeNull();
  });

  it('makes paths unique per space instead of per workspace', async () => {
    const indexes = await sql<Array<{ indexname: string }>>`
      select indexname from pg_indexes where tablename = 'pages' order by indexname
    `;
    const names = indexes.map((row) => row.indexname);
    expect(names).toContain('pages_space_path_key');
    expect(names).not.toContain('pages_workspace_path_key');

    const [second] = await sql<Array<{ id: string }>>`
      insert into spaces (workspace_id, key, name) values (${ids.withPages}, 'SECOND', 'Second') returning id
    `;
    const hash = 'b'.repeat(64);
    // The same path in another space of the same workspace is fine…
    await sql`
      insert into pages (workspace_id, space_id, path, title, content_hash, created_by_type, created_by_id, updated_by_type, updated_by_id)
      values (${ids.withPages}, ${second!.id}, '/backend', 'Backend two', ${hash}, 'user', 'u1', 'user', 'u1')
    `;
    // …and a second live page at it in the same space is not.
    const [main] = await sql<Array<{ id: string }>>`select id from spaces where workspace_id = ${ids.withPages} and key = 'MAIN'`;
    await expect(
      sql`
        insert into pages (workspace_id, space_id, path, title, content_hash, created_by_type, created_by_id, updated_by_type, updated_by_id)
        values (${ids.withPages}, ${main!.id}, '/backend', 'Duplicate', ${hash}, 'user', 'u1', 'user', 'u1')
      `,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('holds a new space key to the format', async () => {
    await expect(
      sql`insert into spaces (workspace_id, key, name) values (${ids.empty}, 'lower', 'Bad key')`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
