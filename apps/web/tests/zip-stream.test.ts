import { describe, expect, it } from 'vitest';

import { readZip } from '@clewwiki/import';

import { createZipStream, ZipBudget } from '@/lib/spaces/zip-stream';
import type { StreamedZipEntry } from '@/lib/spaces/zip-stream';
import { exportSpaceWithFiles } from '@/lib/spaces/export';
import type { FileRecord, FileVersionRecord } from '@/lib/files/service';
import type { PageRecord } from '@/lib/pages/service';

const text = (value: string) => new TextEncoder().encode(value);
const read = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());
const limits = { expandedBytes: 64 * 1024 * 1024, zipEntries: 1000 };

describe('streamed ZIP', () => {
  it('writes entries in hand and streamed ones into one archive a reader takes', async () => {
    async function* entries(): AsyncGenerator<StreamedZipEntry> {
      yield { name: 'A/page.md', data: text('# Page\n') };
      yield { name: 'A/page.files/big.bin', size: 5, open: async () => new Response('bytes').body };
      yield { name: 'A/page.files/gone.bin', size: 1, open: async () => null };
    }
    const missing: string[] = [];
    const zip = await read(createZipStream(entries(), (name) => missing.push(name)));
    expect(readZip(zip, { limits }).map((entry) => [entry.name, new TextDecoder().decode(entry.data)])).toEqual([
      ['A/page.md', '# Page\n'],
      ['A/page.files/big.bin', 'bytes'],
    ]);
    expect(missing).toEqual(['A/page.files/gone.bin']);
  });

  it('lets go of the file being read when the download is cancelled', async () => {
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    async function* entries(): AsyncGenerator<StreamedZipEntry> {
      yield { name: 'A/big.bin', size: 1e9, open: async () => endless };
    }
    const reader = createZipStream(entries()).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  it('keeps an entry and room back for what is written last', () => {
    const budget = new ZipBudget();
    expect(budget.fits('x', 0xffff_0000)).toBe(true);
    expect(budget.fits('x', 0xffff_0000, 0x0010_0000)).toBe(false);
  });
});

describe('space export with files', () => {
  const page = { id: 'p1', path: '/release', title: 'Release', body: '# Release\n', kind: 'human', version: 1, contentHash: 'h', createdAt: new Date(0), updatedAt: new Date(0) } as unknown as PageRecord;
  const version = (sha: string): FileVersionRecord =>
    ({ version: 1, byteSize: 5, sha256: sha }) as unknown as FileVersionRecord;
  const file = (name: string, sha: string): FileRecord =>
    ({ id: name, pageId: 'p1', name, latestVersion: 1, updatedAt: new Date(0), latest: version(sha) }) as unknown as FileRecord;

  it('leaves out a file the store fails to open, and says so, instead of breaking the archive', async () => {
    const exported = exportSpaceWithFiles(
      { key: 'REL' },
      [page],
      async () => [file('ok.bin', 'a'), file('broken.bin', 'b')],
      async (latest) => {
        if (latest.sha256 === 'b') throw new Error('the bucket answered 503');
        return new Response('bytes').body;
      },
    );
    const entries = readZip(await read(exported.body), { limits });
    expect(entries.map((entry) => entry.name)).toEqual(['REL/release.md', 'REL/release.files/ok.bin', 'REL/_files.json']);
    const manifest = JSON.parse(new TextDecoder().decode(entries[2]!.data)) as { files: unknown[]; left_out: Array<Record<string, unknown>> };
    expect(manifest.files).toHaveLength(1);
    expect(manifest.left_out).toEqual([
      expect.objectContaining({ name: 'broken.bin', reason: 'the bytes of this version could not be read from the file store' }),
    ]);
  });
});
