import { describe, expect, it } from 'vitest';

import { computeContentHash } from '@/lib/pages/content';
import { exportPageMarkdown } from '@/lib/pages/export';
import type { PageRecord, PageTreeNode } from '@/lib/pages/service';
import { exportSpaceMarkdown, MAX_SPACE_EXPORT_BYTES, spaceExportEntryName } from '@/lib/spaces/export';
import {
  isSpaceKey,
  normalizeSpaceKey,
  spaceIconSchema,
  spaceKeyInputSchema,
  spaceKeyProblem,
} from '@/lib/spaces/keys';
import { flattenTree, subtreeIds } from '@/lib/spaces/tree';
import {
  newSpacePageHref,
  spaceHref,
  spacePageEditHref,
  spacePageHref,
  spaceSettingsHref,
} from '@/lib/spaces/urls';
import { crc32, createZip, isSafeZipName } from '@/lib/spaces/zip';

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  const body = overrides.body ?? '# Page\n';
  const now = new Date('2026-02-03T04:05:06.000Z');
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-0000000000ff',
    spaceId: '00000000-0000-4000-8000-0000000000aa',
    parentId: null,
    path: '/backend',
    title: 'Backend',
    kind: 'technical',
    linkedPageId: null,
    body,
    summary: null,
    contentHash: computeContentHash(body),
    version: 1,
    createdByType: 'user',
    createdById: 'user-1',
    updatedByType: 'user',
    updatedById: 'user-1',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

/** Reads a stored-entry ZIP back: name → bytes, via the central directory. */
function readZip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    expect(method).toBe(0);
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLength;
    const data = archive.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    cursor += 46 + nameLength;
  }
  return out;
}

describe('space keys', () => {
  it('accepts 2–10 uppercase letters and digits', () => {
    for (const key of ['AB', 'MOBILE', 'API2', '0123456789', 'X1']) {
      expect(isSpaceKey(key)).toBe(true);
      expect(spaceKeyProblem(key)).toBeNull();
    }
  });

  it('refuses keys that are too short, too long, or not letters and digits', () => {
    for (const key of ['A', 'ABCDEFGHIJK', 'MY-APP', 'MY APP', 'ÄPP', '', 'A_B']) {
      expect(spaceKeyProblem(key)).not.toBeNull();
      expect(spaceKeyInputSchema.safeParse(key).success).toBe(false);
    }
  });

  it('normalises case on the way in and stores the uppercase form', () => {
    expect(normalizeSpaceKey(' mobile ')).toBe('MOBILE');
    const parsed = spaceKeyInputSchema.safeParse('api2');
    expect(parsed.success && parsed.data).toBe('API2');
  });

  it('treats an empty icon as none and caps its length', () => {
    expect(spaceIconSchema.parse('  ')).toBeNull();
    expect(spaceIconSchema.parse('📱')).toBe('📱');
    expect(spaceIconSchema.safeParse('x'.repeat(17)).success).toBe(false);
  });
});

describe('space URLs', () => {
  it('puts pages, their editor and settings under the space key', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(spaceHref('MOBILE')).toBe('/spaces/MOBILE');
    expect(spaceSettingsHref('MOBILE')).toBe('/spaces/MOBILE/settings');
    expect(spacePageHref('MOBILE', id)).toBe(`/spaces/MOBILE/pages/${id}`);
    expect(spacePageEditHref('MOBILE', id)).toBe(`/spaces/MOBILE/pages/${id}/edit`);
    expect(newSpacePageHref('MOBILE')).toBe('/spaces/MOBILE/pages/new');
    expect(newSpacePageHref('MOBILE', id)).toBe(`/spaces/MOBILE/pages/new?parent=${id}`);
  });
});

describe('tree helpers', () => {
  const node = (id: string, path: string, children: PageTreeNode[] = []): PageTreeNode => ({
    id,
    spaceId: 's',
    parentId: null,
    path,
    title: id,
    kind: 'technical',
    updatedAt: new Date(0),
    children,
  });
  const tree = [
    node('backend', '/backend', [node('auth', '/backend/auth', [node('tokens', '/backend/auth/tokens')])]),
    node('runbooks', '/runbooks'),
  ];

  it('flattens in display order with depth', () => {
    expect(flattenTree(tree).map((entry) => [entry.id, entry.depth])).toEqual([
      ['backend', 0],
      ['auth', 1],
      ['tokens', 2],
      ['runbooks', 0],
    ]);
  });

  it('collects a subtree, so a page is never offered as its own new parent', () => {
    expect([...subtreeIds(tree, 'auth')].sort()).toEqual(['auth', 'tokens']);
    expect([...subtreeIds(tree, 'runbooks')]).toEqual(['runbooks']);
  });
});

describe('ZIP writer', () => {
  it('writes stored entries every reader can take apart again', () => {
    const encoder = new TextEncoder();
    const archive = createZip([
      { name: 'A/one.md', data: encoder.encode('first\n') },
      { name: 'A/folder/two.md', data: encoder.encode('second — ünïcode\n') },
      { name: 'A/empty.md', data: new Uint8Array() },
    ]);
    const entries = readZip(archive);
    expect([...entries.keys()]).toEqual(['A/one.md', 'A/folder/two.md', 'A/empty.md']);
    expect(new TextDecoder().decode(entries.get('A/folder/two.md'))).toBe('second — ünïcode\n');
    expect(entries.get('A/empty.md')?.length).toBe(0);
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('refuses a path that could escape the folder it is unpacked into', () => {
    for (const name of ['/etc/passwd', '../x.md', 'a/../../x.md', 'a\\b.md', 'a//b.md', '']) {
      expect(isSafeZipName(name)).toBe(false);
      expect(() => createZip([{ name, data: new Uint8Array() }])).toThrow();
    }
  });
});

describe('space export', () => {
  it('names each file after the page path inside a folder named by the key', () => {
    expect(spaceExportEntryName('API', '/backend')).toBe('API/backend.md');
    expect(spaceExportEntryName('API', '/backend/auth')).toBe('API/backend/auth.md');
  });

  it('mirrors the tree, each file carrying front matter with the space', () => {
    const exported = exportSpaceMarkdown({ key: 'API' }, [
      page({ id: 'b', path: '/backend/auth', title: 'Auth', body: '# Auth\n' }),
      page({ id: 'a', path: '/backend', title: 'Backend', body: '# Backend\n' }),
    ]);
    expect(exported.filename).toBe('API.zip');
    expect(exported.contentType).toBe('application/zip');
    expect(exported.pageCount).toBe(2);

    const entries = readZip(exported.body);
    expect([...entries.keys()]).toEqual(['API/backend.md', 'API/backend/auth.md']);
    const auth = new TextDecoder().decode(entries.get('API/backend/auth.md'));
    expect(auth).toContain('space: "API"');
    expect(auth).toContain('path: "/backend/auth"');
    expect(auth.endsWith('# Auth\n')).toBe(true);
  });

  it('refuses a space too large to hold in one archive instead of truncating it', () => {
    const big = 'x'.repeat(Math.ceil(MAX_SPACE_EXPORT_BYTES / 2) + 1);
    expect(() =>
      exportSpaceMarkdown({ key: 'API' }, [
        page({ id: '1', path: '/one', body: big }),
        page({ id: '2', path: '/two', body: big }),
      ]),
    ).toThrow(/too large/);
  });

  it('keeps the single-page export unchanged when no space is given', () => {
    expect(exportPageMarkdown(page()).body).not.toContain('space:');
    expect(exportPageMarkdown(page(), { key: 'API' }).body).toContain('space: "API"');
  });
});
