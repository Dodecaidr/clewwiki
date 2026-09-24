import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { importFromConfluence } from '../src/confluence/index';
import { ConfluenceClient, safeDownloadPath } from '../src/confluence/client';
import { DEFAULT_IMPORT_LIMITS } from '../src/limits';
import type { FileSink, ImportFileVersion } from '../src/types';

/**
 * Attachments carried across as files, with their history.
 *
 * The fake Data Center answers in the shapes cwiki.apache.org answered on
 * 2026-09-24: an attachment listing under `child/attachment` with `version` and
 * `extensions` expanded, a version list under `/rest/experimental`, and each
 * earlier version's own entry — with its size — under `status=historical`. It
 * also does what that site does with a download of an old version: some
 * answer every `?version=` with the latest bytes, which is why a download is
 * held to the size the site records for the version.
 *
 * Nothing here reaches a network.
 */

const PUBLIC = '104.192.136.1';
const publicLookup = async () => [PUBLIC];
const BASE = 'https://wiki.example.com/confluence';
const TOKEN = 'secret-pat';

const text = (value: string) => new TextEncoder().encode(value);

interface FakeVersion {
  number: number;
  /** The bytes the site serves for `?version=number`. */
  served: string;
  /** The size the site records for the version; defaults to what it serves. */
  recorded?: number;
  when?: string;
  by?: string;
  comment?: string;
}

interface FakeAttachment {
  id: string;
  title: string;
  mediaType: string;
  versions: FakeVersion[];
  /** Replaces the download link the listing gives. */
  link?: string;
  /** The download answers with a redirect here. */
  redirectTo?: string;
}

function fakeSite(attachments: FakeAttachment[], options: { history?: 'ok' | 'missing' } = {}) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const pageStorage =
    '<p>See the diagram.</p><ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>';

  const entry = (attachment: FakeAttachment, version: FakeVersion) => ({
    id: attachment.id,
    type: 'attachment',
    status: version.number === attachment.versions.at(-1)!.number ? 'current' : 'historical',
    title: attachment.title,
    version: { number: version.number, when: version.when ?? '2013-04-23T22:00:24.000Z', by: { displayName: version.by ?? 'Sriram' } },
    extensions: {
      mediaType: attachment.mediaType,
      fileSize: version.recorded ?? text(version.served).byteLength,
      comment: version.comment ?? '',
    },
    _links: {
      download:
        attachment.link ??
        `/download/attachments/1001/${encodeURIComponent(attachment.title)}?version=${version.number}&modificationDate=1&api=v2`,
    },
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), authorization: new Headers(init?.headers).get('authorization') });

    if (url.hostname === 'media.example.net') return new Response(text('from the media host'));
    if (url.pathname.endsWith('/rest/api/space/ENG')) return Response.json({ key: 'ENG', name: 'Engineering' });
    if (url.pathname.endsWith('/rest/api/content') && url.searchParams.get('type') === 'page') {
      return Response.json({
        results: [
          {
            id: '1001',
            type: 'page',
            status: 'current',
            title: 'Release 1.0',
            version: { when: '2013-04-23T22:00:24.000Z', number: 1 },
            ancestors: [],
            body: { storage: { value: pageStorage } },
            extensions: { position: 'none' },
            _links: { webui: '/pages/1001' },
          },
        ],
        start: 0,
        limit: 50,
        size: 1,
      });
    }
    if (url.pathname.endsWith('/rest/api/content/1001/child/attachment')) {
      return Response.json({
        results: attachments.map((attachment) => entry(attachment, attachment.versions.at(-1)!)),
        start: 0,
        limit: 50,
        size: attachments.length,
      });
    }
    const history = /\/rest\/experimental\/content\/([^/]+)\/version$/.exec(url.pathname);
    if (history) {
      if (options.history === 'missing') return new Response('', { status: 404 });
      const attachment = attachments.find((candidate) => candidate.id === history[1])!;
      return Response.json({
        results: [...attachment.versions].reverse().map((version) => ({
          number: version.number,
          when: version.when ?? '2013-04-23T22:00:24.000Z',
          by: { displayName: version.by ?? 'Sriram' },
          message: '',
        })),
      });
    }
    const single = /\/rest\/api\/content\/([^/]+)$/.exec(url.pathname);
    if (single && url.searchParams.get('status') === 'historical') {
      const attachment = attachments.find((candidate) => candidate.id === single[1])!;
      const version = attachment.versions.find((candidate) => String(candidate.number) === url.searchParams.get('version'))!;
      return Response.json(entry(attachment, version));
    }
    const download = /\/download\/attachments\/1001\/([^/]+)$/.exec(url.pathname);
    if (download) {
      const attachment = attachments.find((candidate) => candidate.title === decodeURIComponent(download[1]!));
      if (!attachment) return new Response('', { status: 404 });
      if (attachment.redirectTo) return new Response(null, { status: 302, headers: { location: attachment.redirectTo } });
      const asked = Number(url.searchParams.get('version') ?? attachment.versions.at(-1)!.number);
      const version = attachment.versions.find((candidate) => candidate.number === asked) ?? attachment.versions.at(-1)!;
      return new Response(text(version.served));
    }
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function collectingSink(maxFileBytes = 1024 * 1024): FileSink & { kept: Array<ImportFileVersion & { body: string }> } {
  const kept: Array<ImportFileVersion & { body: string }> = [];
  return {
    kept,
    maxFileBytes,
    async store(version, body) {
      const read = await new Response(body).text();
      const sha256 = createHash('sha256').update(read).digest('hex');
      if (version.expectedBytes !== null && text(read).byteLength !== version.expectedBytes) {
        return { refused: `version ${version.sourceVersion} was not served as the source records it` };
      }
      if (version.rejectSha256 && version.rejectSha256 === sha256) {
        return { refused: `version ${version.sourceVersion} was served as the current bytes` };
      }
      kept.push({ ...version, body: read });
      return { kept: true, sha256 };
    },
  };
}

async function run(attachments: FakeAttachment[], options: { history?: 'ok' | 'missing'; sink?: ReturnType<typeof collectingSink> } = {}) {
  const site = fakeSite(attachments, options);
  const sink = options.sink ?? collectingSink();
  const result = await importFromConfluence({
    credentials: { baseUrl: BASE, email: '', apiToken: TOKEN, deployment: 'datacenter' },
    spaceKey: 'ENG',
    limits: DEFAULT_IMPORT_LIMITS,
    client: { fetchImpl: site.fetchImpl, lookup: publicLookup, sleep: async () => undefined },
    files: sink,
  });
  return { result, sink, calls: site.calls };
}

describe('Confluence attachments as files', () => {
  it('carries an attachment with its history, oldest first, as the site recorded it', async () => {
    const { result, sink } = await run([
      {
        id: 'att1',
        title: 'spec.pdf',
        mediaType: 'application/pdf',
        versions: [
          { number: 1, served: 'first draft', when: '2013-04-23T22:00:24.000Z', by: 'Ada', comment: 'Draft' },
          { number: 2, served: 'second draft', when: '2013-04-26T18:46:03.000Z', by: 'Grace' },
          { number: 3, served: 'final', when: '2013-04-26T18:46:52.000Z', by: 'Ada', comment: 'Signed off' },
        ],
      },
    ]);

    const inOrder = [...sink.kept].sort((a, b) => a.position - b.position);
    expect(inOrder.map((version) => [version.name, version.sourceVersion, version.body, version.author, version.note])).toEqual([
      ['spec.pdf', 1, 'first draft', 'Ada', 'Draft'],
      ['spec.pdf', 2, 'second draft', 'Grace', null],
      ['spec.pdf', 3, 'final', 'Ada', 'Signed off'],
    ]);
    // The current version is read first; its place in the history is kept.
    expect(sink.kept.map((version) => [version.sourceVersion, version.position])).toEqual([[3, 2], [1, 0], [2, 1]]);
    expect(inOrder[0]!.sourceId).toBe('1001');
    expect(inOrder[2]!.createdAt?.toISOString()).toBe('2013-04-26T18:46:52.000Z');
    expect(result.params).toMatchObject({ file_count: 1, file_version_count: 3 });
    expect(result.nodes[0]!.warnings.filter((warning) => warning.code.startsWith('file-'))).toEqual([]);
  });

  it('refuses a version the site serves as something else, and says so', async () => {
    // What cwiki.apache.org does: every `?version=` answers with the latest.
    const { sink, result } = await run([
      {
        id: 'att2',
        title: 'MigrationTool.jpg',
        mediaType: 'image/jpeg',
        versions: [
          { number: 1, served: 'latest bytes!', recorded: 34093 },
          { number: 2, served: 'latest bytes!', recorded: 34830 },
          // The current version's own record disagrees too, as it did there;
          // it is kept anyway, because it is what the site serves as the file.
          { number: 3, served: 'latest bytes!', recorded: 36273 },
        ],
      },
    ]);
    expect(sink.kept.map((version) => [version.sourceVersion, version.expectedBytes])).toEqual([[3, null]]);
    expect(result.nodes[0]!.warnings).toContainEqual({
      code: 'file-history-partial',
      detail: 'MigrationTool.jpg: 2 earlier version(s) were not served as recorded',
    });
  });

  it('keeps the current version when the history cannot be read', async () => {
    const { sink, result } = await run(
      [{ id: 'att3', title: 'notes.txt', mediaType: 'text/plain', versions: [{ number: 1, served: 'a' }, { number: 2, served: 'bb' }] }],
      { history: 'missing' },
    );
    expect(sink.kept.map((version) => [version.sourceVersion, version.body])).toEqual([[2, 'bb']]);
    expect(result.nodes[0]!.warnings).toContainEqual({
      code: 'file-history-partial',
      detail: 'notes.txt: earlier versions could not be read',
    });
  });

  it('does not carry twice an image the page already shows, nor a file larger than the sink takes', async () => {
    const { sink, result } = await run(
      [
        { id: 'img', title: 'diagram.png', mediaType: 'image/png', versions: [{ number: 1, served: 'png' }] },
        { id: 'big', title: 'dump.bin', mediaType: 'application/octet-stream', versions: [{ number: 1, served: 'x', recorded: 5000 }] },
        { id: 'ok', title: 'readme.md', mediaType: 'text/markdown', versions: [{ number: 1, served: '# hi' }] },
      ],
      { sink: collectingSink(1000) },
    );
    expect(sink.kept.map((version) => version.name)).toEqual(['readme.md']);
    expect(result.nodes[0]!.warnings).toContainEqual({ code: 'file-skipped', detail: 'dump.bin: larger than this instance takes' });
  });

  it('follows a download to another host without the credential, and never a link the listing forged', async () => {
    const { sink, calls } = await run([
      {
        id: 'r',
        title: 'moved.zip',
        mediaType: 'application/zip',
        versions: [{ number: 1, served: 'from the media host' }],
        redirectTo: 'https://media.example.net/signed/abc',
      },
      {
        id: 'f',
        title: 'forged.txt',
        mediaType: 'text/plain',
        versions: [{ number: 1, served: 'the real one' }],
        link: 'https://attacker.example/steal?x=1',
      },
    ]);
    expect(sink.kept.map((version) => [version.name, version.body])).toEqual([
      ['moved.zip', 'from the media host'],
      ['forged.txt', 'the real one'],
    ]);
    const media = calls.find((call) => call.url.startsWith('https://media.example.net/'));
    expect(media?.authorization).toBeNull();
    expect(calls.some((call) => call.url.includes('attacker.example'))).toBe(false);
    const origin = calls.find((call) => call.url.includes('/download/attachments/1001/moved.zip'));
    expect(origin?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('carries nothing but images when no sink is given', async () => {
    const site = fakeSite([{ id: 'a', title: 'spec.pdf', mediaType: 'application/pdf', versions: [{ number: 1, served: 'x' }] }]);
    const result = await importFromConfluence({
      credentials: { baseUrl: BASE, email: '', apiToken: TOKEN, deployment: 'datacenter' },
      spaceKey: 'ENG',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
    });
    expect(result.params['file_count']).toBeUndefined();
    expect(site.calls.some((call) => call.url.includes('child/attachment'))).toBe(false);
  });
});

describe('Confluence Cloud attachment history', () => {
  const ORIGIN = 'https://example.atlassian.net';
  const versions = [
    { number: 1, served: 'draft one', message: 'First' },
    { number: 2, served: 'current bytes' },
    { number: 3, served: 'current bytes' },
  ];

  function cloudSite(servesHistory: boolean) {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname === '/wiki/api/v2/spaces') return Response.json({ results: [{ id: '42', key: 'ENG', name: 'Engineering' }] });
      if (url.pathname === '/wiki/api/v2/spaces/42/pages') {
        return Response.json({ results: [{ id: '7', title: 'Release', status: 'current', body: { storage: { value: '<p>x</p>' } }, version: { number: 1 } }] });
      }
      if (url.pathname === '/wiki/api/v2/pages/7/attachments') {
        return Response.json({
          results: [{ id: 'att9', title: 'build.zip', mediaType: 'application/zip', fileSize: 13, version: { number: 3, createdAt: '2026-01-03T00:00:00Z' }, downloadLink: '/download/attachments/7/build.zip?version=3' }],
        });
      }
      if (url.pathname === '/wiki/api/v2/attachments/att9/versions') {
        return Response.json({
          results: [...versions].reverse().map((version) => ({ number: version.number, createdAt: `2026-01-0${version.number}T00:00:00Z`, message: version.message ?? '' })),
        });
      }
      if (url.pathname === '/wiki/download/attachments/7/build.zip') {
        const asked = Number(url.searchParams.get('version'));
        const version = servesHistory ? versions.find((candidate) => candidate.number === asked)! : versions[2]!;
        return new Response(text(version.served));
      }
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  async function runCloud(servesHistory: boolean) {
    const site = cloudSite(servesHistory);
    const sink = collectingSink();
    const result = await importFromConfluence({
      credentials: { baseUrl: ORIGIN, email: 'a@example.com', apiToken: 'token', deployment: 'cloud' },
      spaceKey: 'ENG',
      limits: DEFAULT_IMPORT_LIMITS,
      client: { fetchImpl: site.fetchImpl, lookup: publicLookup },
      files: sink,
    });
    return { sink, result };
  }

  it('carries the earlier versions a site serves, and refuses one served as the current bytes', async () => {
    const { sink, result } = await runCloud(true);
    const inOrder = [...sink.kept].sort((a, b) => a.position - b.position);
    // Version 2 really was the same bytes as version 3; it goes, and the
    // history loses nothing a reader could tell apart.
    expect(inOrder.map((version) => [version.sourceVersion, version.body, version.note])).toEqual([
      [1, 'draft one', 'First'],
      [3, 'current bytes', null],
    ]);
    expect(result.nodes[0]!.warnings).toContainEqual({
      code: 'file-history-partial',
      detail: 'build.zip: 1 earlier version(s) were not served as recorded',
    });
  });

  it('keeps only the current version from a site that serves it for every version', async () => {
    const { sink } = await runCloud(false);
    expect(sink.kept.map((version) => version.sourceVersion)).toEqual([3]);
  });
});

describe('download links', () => {
  const root = BASE;
  const origin = 'https://wiki.example.com';

  it('takes a download path on the site, under its context path or not', () => {
    expect(safeDownloadPath('/download/attachments/1/a.pdf?version=2&api=v2', root, origin)).toBe(
      '/download/attachments/1/a.pdf?version=2&api=v2',
    );
    expect(safeDownloadPath('https://wiki.example.com/confluence/download/attachments/1/a%20b.pdf', root, origin)).toBe(
      '/download/attachments/1/a%20b.pdf',
    );
  });

  it('refuses anything else', () => {
    for (const link of [
      'https://attacker.example/download/attachments/1/a.pdf',
      '//attacker.example/download/attachments/1/a.pdf',
      '/rest/api/user/current',
      '/download/attachments/1/%2e%2e/secret',
      '/download/attachments/1/a/b.pdf',
      'javascript:alert(1)',
      '',
      null,
    ]) {
      expect(safeDownloadPath(link, root, origin), String(link)).toBeNull();
    }
  });

  it('is what a Data Center client lists', async () => {
    const site = fakeSite([
      { id: 'x', title: 'a b.pdf', mediaType: 'application/pdf', versions: [{ number: 1, served: 'x' }], link: '/rest/api/user/current' },
    ]);
    const client = new ConfluenceClient(
      { baseUrl: BASE, email: '', apiToken: TOKEN, deployment: 'datacenter' },
      { fetchImpl: site.fetchImpl, lookup: publicLookup },
    );
    const [listed] = await client.listAttachments('1001');
    expect(listed!.downloadPath).toBe('/download/attachments/1001/a%20b.pdf?version=1&api=v2');
  });
});
