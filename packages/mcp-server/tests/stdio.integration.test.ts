import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTENT_IS_DATA_NOTICE } from '../src/content-notice.ts';
import { startFakeRest } from './helpers/fake-rest.ts';
import type { FakeRest } from './helpers/fake-rest.ts';

/**
 * The exit criterion of this phase, run rather than argued: a real MCP client
 * starts `clewwiki-mcp` as a process, speaks the protocol to it over stdio,
 * and completes get_page → claim → write_page → release_claim against a
 * server that answers like the REST API does.
 *
 * The server under test is the built entry point, not the TypeScript source,
 * because that is what an agent host will actually spawn.
 */

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const TOKEN = 'integration-token-value';

interface ToolOutcome {
  isError: boolean;
  data: Record<string, unknown>;
}

describe('stdio transport', () => {
  let rest: FakeRest;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    if (!existsSync(BIN)) {
      throw new Error(`${BIN} is missing — run the package build before its tests`);
    }
    rest = await startFakeRest({ token: TOKEN });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { ...getDefaultEnvironment(), CLEWWIKI_URL: rest.url, CLEWWIKI_TOKEN: TOKEN },
      stderr: 'pipe',
    });
    client = new Client({ name: 'clewwiki-test-client', version: '0.0.0' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await rest?.close();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.find((entry) => entry.type === 'text')?.text ?? '{}';
    return { isError: result.isError === true, data: JSON.parse(text) as Record<string, unknown> };
  }

  it('advertises the thirty-four tools, with the content contract on the ones that return stored text', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((entry) => entry.name).sort();

    expect(names).toEqual(
      [
        'wiki.list_spaces',
        'wiki.format_guide',
        'wiki.get_rules',
        'wiki.list_skills',
        'wiki.get_skill',
        'wiki.check_anchors',
        'wiki.claim',
        'wiki.create_page',
        'wiki.get_page',
        'wiki.get_presence',
        'wiki.link_docs',
        'wiki.list_pages',
        'wiki.post_note',
        'wiki.release_claim',
        'wiki.renew_claim',
        'wiki.search',
        'wiki.write_page',
        'wiki.list_discussions',
        'wiki.get_discussion',
        'wiki.open_discussion',
        'wiki.post_discussion_message',
        'wiki.resolve_discussion',
        'wiki.list_changes',
        'wiki.get_review',
        'wiki.diff_page',
        'wiki.list_comments',
        'wiki.post_comment',
        'wiki.resolve_comment',
        'wiki.check_inbox',
        'wiki.mark_inbox_read',
        'wiki.list_files',
        'wiki.get_file',
        'wiki.upload_file',
        'wiki.watch',
      ].sort(),
    );

    for (const name of [
      'wiki.list_spaces',
      'wiki.search',
      'wiki.get_page',
      'wiki.list_pages',
      'wiki.get_rules',
      'wiki.list_skills',
      'wiki.get_skill',
      'wiki.list_discussions',
      'wiki.get_discussion',
    ]) {
      const entry = listed.tools.find((candidate) => candidate.name === name);
      expect(entry?.description).toContain(CONTENT_IS_DATA_NOTICE);
    }
  });

  it('lists the spaces the token can reach, leaving archived ones out by default', async () => {
    const listed = await call('wiki.list_spaces', {});
    expect(listed.isError).toBe(false);
    const spaces = listed.data.spaces as Array<{ key: string; page_count: number }>;
    expect(spaces.map((space) => space.key)).toEqual(['MAIN', 'OPS']);
    expect(spaces[0]).toMatchObject({ key: 'MAIN', name: 'Main', page_count: 1, archived: false });

    const all = await call('wiki.list_spaces', { include_archived: true });
    expect((all.data.spaces as Array<{ key: string }>).map((space) => space.key)).toContain('OLD');
  });

  it('reads a space\'s rules, and says plainly when a space has none', async () => {
    const rules = await call('wiki.get_rules', { space: 'MAIN' });
    expect(rules.isError).toBe(false);
    expect(rules.data).toMatchObject({ title: 'Project rules', path: '/rules' });
    expect(rules.data.body).toContain('Use pnpm');

    const none = await call('wiki.get_rules', { space: 'OPS' });
    expect(none.isError).toBe(true);
    expect(none.data).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('lists a space\'s skills, filters them by tag and reads one in full', async () => {
    const listed = await call('wiki.list_skills', { space: 'MAIN' });
    expect(listed.isError).toBe(false);
    const entries = listed.data.skills as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry.slug)).toEqual(['release-checks', 'db-migrations']);
    // A listing carries no bodies: it is a catalogue, not a download.
    expect(entries.every((entry) => entry.body === undefined)).toBe(true);

    const tagged = await call('wiki.list_skills', { space: 'MAIN', tag: 'db' });
    expect((tagged.data.skills as Array<{ slug: string }>).map((entry) => entry.slug)).toEqual([
      'db-migrations',
    ]);

    const one = await call('wiki.get_skill', { space: 'MAIN', slug: 'release-checks' });
    expect(one.isError).toBe(false);
    expect(one.data.body).toContain('Run the suite');
    expect(one.data.skill_md).toContain('name: Release checks');

    const missing = await call('wiki.get_skill', { space: 'MAIN', slug: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.data).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('keeps a search, the tree and presence inside the space it is given', async () => {
    const inMain = await call('wiki.search', { query: 'auth', space: 'MAIN' });
    expect((inMain.data.results as unknown[]).length).toBe(1);
    expect(inMain.data.results).toMatchObject([{ space: { key: 'MAIN' } }]);

    const inOps = await call('wiki.search', { query: 'auth', space: 'OPS' });
    expect(inOps.data.results).toEqual([]);

    const tree = await call('wiki.list_pages', { space: 'OPS' });
    expect(tree.data.nodes).toEqual([]);

    const unknown = await call('wiki.get_presence', { space: 'NOPE' });
    expect(unknown.isError).toBe(true);
    expect(unknown.data).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('creates a page in a space, and reports a taken path as CONFLICT with the page in the way', async () => {
    const createdPage = await call('wiki.create_page', {
      space: 'ops',
      parent_path: '/runbooks',
      title: 'Restart the queue',
      kind: 'human',
      body: '# Restart\n',
    });
    expect(createdPage.isError).toBe(false);
    expect(createdPage.data).toMatchObject({
      space: { key: 'OPS' },
      path: '/runbooks/restart-the-queue',
      kind: 'human',
      version: 1,
      linked_page_id: null,
    });
    expect(createdPage.data.page_id).toEqual(expect.any(String));
    expect(createdPage.data.content_hash).toEqual(expect.any(String));
    expect(rest.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/pages' });

    const taken = await call('wiki.create_page', {
      space: 'MAIN',
      parent_path: '/backend',
      slug: 'auth',
      title: 'Auth again',
      kind: 'technical',
    });
    expect(taken.isError).toBe(true);
    expect(taken.data).toMatchObject({
      error: { code: 'CONFLICT', details: { existing_page_id: rest.page.page_id } },
    });
  });

  it('refuses a page path without its space before any REST call is made', async () => {
    const before = rest.calls.length;
    const refused = await call('wiki.get_page', { path: '/backend/auth' });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(rest.calls.length).toBe(before);
  });

  it('runs get_page → claim → write_page → release_claim end to end', async () => {
    const read = await call('wiki.get_page', { space: 'MAIN', path: '/backend/auth' });
    expect(read.isError).toBe(false);
    expect(read.data.space).toEqual({ key: 'MAIN', name: 'Main' });
    const pageId = read.data.page_id as string;
    const baseHash = read.data.content_hash as string;
    expect(read.data.body).toBe('# Authentication\n');

    const claimed = await call('wiki.claim', { page_id: pageId });
    expect(claimed.isError).toBe(false);
    const claimId = claimed.data.claim_id as string;
    expect(claimed.data.base_content_hash).toBe(baseHash);

    const written = await call('wiki.write_page', {
      page_id: pageId,
      claim_id: claimId,
      base_content_hash: baseHash,
      body: '# Authentication\n\nSessions are cookie-backed.\n',
    });
    expect(written.isError).toBe(false);
    expect(written.data.version).toBe(2);
    expect(written.data.content_hash).not.toBe(baseHash);

    const released = await call('wiki.release_claim', { claim_id: claimId });
    expect(released.isError).toBe(false);
    expect(released.data.released).toBe(true);

    // Nothing reached the instance except through the REST API, with the token.
    expect(rest.calls.every((entry) => entry.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(rest.calls.every((entry) => entry.userAgent?.startsWith('clewwiki-mcp/'))).toBe(true);
    expect(rest.calls.map((entry) => `${entry.method} ${entry.path.split('?')[0]}`)).toContain(
      `PATCH /api/v1/pages/${pageId}`,
    );
  }, 30_000);

  it('returns the instance format guide, which carries no stored content', async () => {
    const listed = await client.listTools();
    const entry = listed.tools.find((candidate) => candidate.name === 'wiki.format_guide');
    expect(entry?.annotations?.readOnlyHint).toBe(true);
    expect(entry?.description).not.toContain(CONTENT_IS_DATA_NOTICE);

    const before = rest.calls.length;
    const guide = await call('wiki.format_guide', {});
    expect(guide.isError).toBe(false);
    expect(guide.data).toMatchObject({ format: 'markdown', charts: { language: 'chart' } });
    expect(rest.calls.slice(before).map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      'GET /api/v1/format-guide',
    ]);
  });

  it('reports an invalid chart block as VALIDATION with the block, line and fields', async () => {
    const pageId = rest.page.page_id;
    const claimed = await call('wiki.claim', { page_id: pageId });
    const claimId = claimed.data.claim_id as string;

    const refused = await call('wiki.write_page', {
      page_id: pageId,
      claim_id: claimId,
      base_content_hash: rest.page.content_hash,
      body: '```chart\n{}\n```',
    });
    expect(refused.isError).toBe(true);
    expect(refused.data).toMatchObject({
      error: {
        code: 'VALIDATION',
        details: { block_index: 0, line: 1, language: 'chart', errors: [{ path: 'type' }] },
      },
    });

    await call('wiki.release_claim', { claim_id: claimId });
  });

  it('reports a write built on a hash that has moved on as STALE_BASE', async () => {
    const pageId = rest.page.page_id;
    const claimed = await call('wiki.claim', { page_id: pageId });
    const claimId = claimed.data.claim_id as string;

    const stale = await call('wiki.write_page', {
      page_id: pageId,
      claim_id: claimId,
      base_content_hash: 'sha256:00000000000000000000000000000000',
      body: 'anything',
    });

    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ error: { code: 'STALE_BASE' } });
    const details = (stale.data.error as { details: Record<string, unknown> }).details;
    expect(details.current_content_hash).toBe(rest.page.content_hash);

    await call('wiki.release_claim', { claim_id: claimId });
  });

  it('reports an unreachable repository as REPOSITORY_UNAVAILABLE', async () => {
    const failed = await call('wiki.check_anchors', { page_id: rest.page.page_id });
    expect(failed.isError).toBe(true);
    expect(failed.data).toMatchObject({ error: { code: 'REPOSITORY_UNAVAILABLE' } });
    // The remote's own error text stays out of what the agent reads.
    expect(JSON.stringify(failed.data)).not.toContain('fatal:');
  });

  it('refuses a page id that is not one before any REST call is made', async () => {
    const before = rest.calls.length;
    // The SDK validates arguments against the advertised schema and answers
    // with a tool error rather than a protocol exception.
    const result = await client.callTool({ name: 'wiki.claim', arguments: { page_id: 'nope' } });
    expect(result.isError).toBe(true);
    expect(rest.calls.length).toBe(before);
  });

  it('runs list_discussions → get_discussion → post_discussion_message end to end', async () => {
    const listed = await call('wiki.list_discussions', { space: 'MAIN' });
    expect(listed.isError).toBe(false);
    const threads = listed.data.discussions as Array<Record<string, unknown>>;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      title: 'Auth contract: breaking change to /session',
      status: 'open',
      message_count: 1,
      cleanup: 'closed_when_idle',
    });

    const id = threads[0]!.discussion_id as string;
    const thread = await call('wiki.get_discussion', { discussion_id: id });
    expect(thread.isError).toBe(false);
    const messages = thread.data.messages as Array<{ body: string; author: { label: string } }>;
    expect(messages).toHaveLength(1);
    // The body is somebody else's text, handed back verbatim.
    expect(messages[0]?.body).toContain('legacy cookie');
    expect(messages[0]?.author.label).toBe('backend-agent');

    const replied = await call('wiki.post_discussion_message', {
      discussion_id: id,
      body: 'Nothing of mine reads it. Go ahead.',
    });
    expect(replied.isError).toBe(false);
    expect((replied.data.message as { body: string }).body).toContain('Go ahead');

    const after = await call('wiki.get_discussion', { discussion_id: id });
    expect((after.data.messages as unknown[])).toHaveLength(2);
  });

  it('opens a discussion and resolves it into a decision page', async () => {
    const opened = await call('wiki.open_discussion', {
      space: 'MAIN',
      title: 'Where do runbooks live?',
      body: 'OPS or MAIN? I am about to write three of them.',
    });
    expect(opened.isError).toBe(false);
    expect(opened.data).toMatchObject({ status: 'open', cleanup: 'closed_when_idle' });

    const id = opened.data.discussion_id as string;
    const resolved = await call('wiki.resolve_discussion', {
      discussion_id: id,
      decision: 'Runbooks live in OPS.',
      consequences: 'The three drafts in MAIN move before the next release.',
    });
    expect(resolved.isError).toBe(false);
    expect(resolved.data).toMatchObject({ status: 'resolved', cleanup: 'deleted' });
    const page = resolved.data.decision_page as Record<string, unknown>;
    expect(page.page_id).toEqual(resolved.data.decision_page_id);
    expect(String(page.path)).toContain('/decisions/');
  });

  it('refuses a resolution with no decision, because the decision is the point', async () => {
    const listed = await call('wiki.list_discussions', { space: 'MAIN', status: 'open' });
    const open = (listed.data.discussions as Array<Record<string, unknown>>)[0];
    const refused = await client.callTool({
      name: 'wiki.resolve_discussion',
      arguments: { discussion_id: open!.discussion_id as string, decision: '' },
    });
    expect(refused.isError).toBe(true);
  });

  it('refuses a discussion id that is not one before any REST call is made', async () => {
    const before = rest.calls.length;
    const result = await client.callTool({
      name: 'wiki.get_discussion',
      arguments: { discussion_id: 'nope' },
    });
    expect(result.isError).toBe(true);
    expect(rest.calls.length).toBe(before);
  });
});

describe('stdio transport, scope violations', () => {
  it('surfaces a token without pages:write as FORBIDDEN', async () => {
    const rest = await startFakeRest({ token: TOKEN, scopes: ['pages:read'] });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { ...getDefaultEnvironment(), CLEWWIKI_URL: rest.url, CLEWWIKI_TOKEN: TOKEN },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'clewwiki-test-client', version: '0.0.0' });
    await client.connect(transport);

    try {
      const result = await client.callTool({
        name: 'wiki.claim',
        arguments: { page_id: rest.page.page_id },
      });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const data = JSON.parse(content[0]?.text ?? '{}') as { error?: { code?: string } };
      expect(result.isError).toBe(true);
      expect(data.error?.code).toBe('FORBIDDEN');

      const creation = await client.callTool({
        name: 'wiki.create_page',
        arguments: { space: 'MAIN', title: 'Nope', kind: 'technical' },
      });
      const creationContent = (creation.content ?? []) as Array<{ type: string; text?: string }>;
      expect(creation.isError).toBe(true);
      expect(JSON.parse(creationContent[0]?.text ?? '{}')).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });

      // Reading still works with the scopes it does have.
      const read = await client.callTool({
        name: 'wiki.get_page',
        arguments: { page_id: rest.page.page_id },
      });
      expect(read.isError).not.toBe(true);
    } finally {
      await client.close();
      await rest.close();
    }
  }, 30_000);
});

describe('stdio entry point', () => {
  async function run(
    env: Record<string, string>,
    args: string[] = [],
  ): Promise<{ code: number | null; stderr: string }> {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        env: { ...getDefaultEnvironment(), ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code) => resolve({ code, stderr }));
    });
  }

  it('fails at start-up, not on the first tool call, when the URL is missing', async () => {
    const result = await run({ CLEWWIKI_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLEWWIKI_URL');
  }, 20_000);

  it('fails at start-up when the token is missing', async () => {
    const result = await run({ CLEWWIKI_URL: 'https://wiki.example.com' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CLEWWIKI_TOKEN');
  }, 20_000);

  it('refuses a base URL that is not one, naming the variable', async () => {
    const result = await run({ CLEWWIKI_URL: 'wiki.example.com', CLEWWIKI_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not a URL');
  }, 20_000);

  it('prints its usage on stderr, leaving stdout to the protocol', async () => {
    const result = await run({}, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('CLEWWIKI_URL');
    expect(result.stderr).toContain('CLEWWIKI_TOKEN');
  }, 20_000);
});
