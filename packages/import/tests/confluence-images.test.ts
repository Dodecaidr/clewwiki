import { describe, expect, it } from 'vitest';

import { importFromConfluence } from '../src/confluence/index';
import { NON_PUBLIC_MESSAGE } from '../src/confluence/transport';
import { imagePlaceholderFor, referencedImageKeys } from '../src/images';
import { DEFAULT_IMPORT_LIMITS } from '../src/limits';
import type { ImportLimits } from '../src/limits';

/**
 * Images of a Confluence import, against a site that exists only as a `fetch`.
 * What matters most here is where the credential goes: to the origin that was
 * typed, and to no host a redirect names.
 */

const ORIGIN = 'https://example.atlassian.net';
const MEDIA = 'https://api.media.atlassian.com';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

const image = (filename: string, inner = ''): string =>
  `<ac:image ac:alt="Flow"><ri:attachment ri:filename="${filename}">${inner}</ri:attachment></ac:image>`;

type Route = (url: URL) => Response | undefined;

function site(storage: string | string[], routes: Route) {
  const bodies = Array.isArray(storage) ? storage : [storage];
  const calls: Array<{ url: string; authorization: string | null }> = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization') });

    if (url.pathname === '/wiki/api/v2/spaces') {
      return Response.json({ results: [{ id: '5001', key: 'API', name: 'API platform' }] });
    }
    if (url.pathname.startsWith('/wiki/api/v2/spaces/')) {
      return Response.json({
        results: bodies.map((value, index) => ({
          id: String(101 + index),
          title: `Page ${index + 1}`,
          status: 'current',
          body: { storage: { value } },
        })),
      });
    }
    return routes(url) ?? new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } });

const lookup = async (hostname: string): Promise<string[]> =>
  hostname === 'internal.example.test' ? ['10.0.0.5'] : ['104.192.136.1'];

function run(fake: ReturnType<typeof site>, limits: Partial<ImportLimits> = {}) {
  return importFromConfluence({
    credentials: { baseUrl: ORIGIN, email: 'importer@example.test', apiToken: 'secret-api-token-value' },
    spaceKey: 'API',
    limits: { ...DEFAULT_IMPORT_LIMITS, ...limits },
    client: { fetchImpl: fake.fetchImpl, lookup, sleep: async () => undefined },
  });
}

const KEY = `${ORIGIN}/wiki/download/attachments/101/flow (1).png`;
const DOWNLOAD = `${ORIGIN}/wiki/download/attachments/101/flow%20(1).png`;

describe('confluence images', () => {
  it('follows the redirect to the media host and keeps the credential at home', async () => {
    const fake = site(image('flow (1).png'), (url) => {
      if (url.href === DOWNLOAD) return redirect(`${MEDIA}/file/abc/binary?token=signed`);
      if (url.origin === MEDIA) return new Response(PNG);
      return undefined;
    });
    const result = await run(fake);

    expect(result.assets).toEqual([{ key: KEY, data: PNG }]);
    expect(result.params['image_count']).toBe(1);
    expect(result.nodes[0]?.markdown.trim()).toBe(`![Flow](${imagePlaceholderFor(KEY)})`);
    expect(result.nodes[0]?.warnings).toEqual([]);

    const download = fake.calls.find((call) => call.url === DOWNLOAD);
    const media = fake.calls.find((call) => call.url.startsWith(MEDIA));
    expect(download?.authorization).toMatch(/^Basic /);
    expect(media).toBeDefined();
    expect(media?.authorization).toBeNull();
  });

  it('sends the credential again when the redirect stays on the origin', async () => {
    const fake = site(image('flow.png'), (url) => {
      if (url.pathname === '/wiki/download/attachments/101/flow.png') return redirect('/wiki/download/real/flow.png');
      if (url.pathname === '/wiki/download/real/flow.png') return new Response(PNG);
      return undefined;
    });
    const result = await run(fake);
    expect(result.assets).toHaveLength(1);
    expect(fake.calls.at(-1)?.authorization).toMatch(/^Basic /);
  });

  it('does not go where a redirect to a private address points', async () => {
    const fake = site(image('flow.png'), (url) =>
      url.origin === ORIGIN ? redirect('https://internal.example.test/latest/meta-data') : new Response(PNG),
    );
    const result = await run(fake);

    expect(result.assets).toEqual([]);
    expect(fake.calls.some((call) => call.url.includes('internal.example.test'))).toBe(false);
    // Back to what it always was: a link to Confluence, and a warning.
    expect(result.nodes[0]?.markdown.trim()).toBe(`![Flow](${ORIGIN}/wiki/download/attachments/101/flow.png)`);
    expect(result.nodes[0]?.warnings).toEqual([
      {
        code: 'external-attachment',
        // The same refusal a connection gets, so the wording stays in one place.
        detail: `flow.png: ${NON_PUBLIC_MESSAGE}`,
      },
    ]);
  });

  it('refuses a redirect away from https', async () => {
    const fake = site(image('flow.png'), () => redirect('http://api.media.atlassian.com/file'));
    const result = await run(fake);
    expect(result.assets).toEqual([]);
    expect(fake.calls.some((call) => call.url.startsWith('http://'))).toBe(false);
    expect(result.nodes[0]?.warnings[0]?.detail).toBe('flow.png: a redirect away from https');
  });

  it('gives up on a chain of redirects', async () => {
    const fake = site(image('flow.png'), (url) => redirect(`${MEDIA}/hop/${url.pathname.length}`));
    const result = await run(fake);
    expect(result.nodes[0]?.warnings[0]?.detail).toBe('flow.png: too many redirects');
    expect(fake.calls.filter((call) => !call.url.includes('/api/v2/'))).toHaveLength(4);
  });

  it('keeps the pages when a picture cannot be had', async () => {
    const fake = site(`<p>Before.</p>${image('gone.png')}`, () => new Response('', { status: 403 }));
    const result = await run(fake);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.markdown).toContain('Before.');
    expect(result.nodes[0]?.warnings).toEqual([
      { code: 'external-attachment', detail: 'gone.png: Confluence answered 403' },
    ]);
  });

  it('will not read an image past the limit', async () => {
    const fake = site(image('huge.png'), () => new Response(new Uint8Array(2048)));
    const result = await run(fake, { imageBytes: 1024 });
    expect(result.assets).toEqual([]);
    expect(result.nodes[0]?.warnings[0]?.detail).toBe(
      'huge.png: Confluence answered with more than this import will read',
    );
  });

  it('downloads nothing when image uploads are off', async () => {
    const fake = site(image('flow.png'), () => new Response(PNG));
    const result = await run(fake, { imageBytes: 0 });
    expect(result.assets).toEqual([]);
    expect(fake.calls.every((call) => call.url.includes('/api/v2/'))).toBe(true);
    expect(result.nodes[0]?.warnings).toEqual([{ code: 'external-attachment', detail: 'flow.png' }]);
  });

  it('leaves alone what it cannot store or cannot address', async () => {
    const other = '<ri:page ri:content-title="Elsewhere" />';
    const fake = site(`${image('logo.svg')}${image('theirs.png', other)}`, () => new Response(PNG));
    const result = await run(fake);
    expect(result.assets).toEqual([]);
    expect(fake.calls.every((call) => call.url.includes('/api/v2/'))).toBe(true);
    expect(referencedImageKeys(result.nodes[0]?.markdown ?? '')).toEqual([]);
  });

  it('stops downloading at the cap and says so', async () => {
    const fake = site([image('a.png'), image('b.png')], () => new Response(PNG));
    const result = await run(fake, { imageDownloads: 1 });
    expect(result.assets).toHaveLength(1);
    expect(result.nodes[1]?.warnings).toEqual([
      { code: 'external-attachment', detail: 'b.png: more than 1 images in one import' },
    ]);
  });
});
