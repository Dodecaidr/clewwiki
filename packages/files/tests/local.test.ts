import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { blobKey, BlobTooLargeError, createLocalBlobStore, EmptyBlobError } from '../src/index';
import type { BlobStore } from '../src/index';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function text(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (stream === null) return null;
  return new Response(stream).text();
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('local blob store', () => {
  let root: string;
  let store: BlobStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'clewwiki-files-'));
    store = createLocalBlobStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('hashes while staging and stores under the key the hash decides', async () => {
    const staged = await store.stage(streamOf('hello ', 'world'), { maxBytes: 100 });
    expect(staged.sha256).toBe(sha('hello world'));
    expect(staged.byteSize).toBe(11);

    const key = blobKey(WORKSPACE, staged.sha256);
    expect(await store.has(key)).toBe(false);
    await staged.commit(key);
    expect(await store.has(key)).toBe(true);
    expect(await text(await store.read(key))).toBe('hello world');
    expect(await readdir(path.join(root, 'staging'))).toEqual([]);
  });

  it('reads a byte range, both ends inclusive', async () => {
    const staged = await store.stage(streamOf('0123456789'), { maxBytes: 100 });
    const key = blobKey(WORKSPACE, staged.sha256);
    await staged.commit(key);
    expect(await text(await store.read(key, { start: 2, end: 5 }))).toBe('2345');
  });

  it('keeps the stored blob when the same content is committed again', async () => {
    const first = await store.stage(streamOf('same'), { maxBytes: 100 });
    const second = await store.stage(streamOf('same'), { maxBytes: 100 });
    const key = blobKey(WORKSPACE, first.sha256);
    await Promise.all([first.commit(key), second.commit(key)]);
    expect(await text(await store.read(key))).toBe('same');
    expect(await readdir(path.join(root, 'staging'))).toEqual([]);
  });

  it('refuses past the limit and leaves nothing behind', async () => {
    await expect(store.stage(streamOf('12345', '67890'), { maxBytes: 7 })).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(await readdir(path.join(root, 'staging'))).toEqual([]);
  });

  it('refuses an empty upload', async () => {
    await expect(store.stage(streamOf(), { maxBytes: 7 })).rejects.toBeInstanceOf(EmptyBlobError);
  });

  it('answers null for a blob that is not there, and removes quietly', async () => {
    const key = blobKey(WORKSPACE, sha('absent'));
    expect(await store.read(key)).toBeNull();
    await expect(store.remove(key)).resolves.toBeUndefined();
  });

  it('refuses a key it could not have made', async () => {
    await expect(store.read('../../etc/passwd')).rejects.toThrow('Not a blob key');
    expect(() => blobKey('not-a-uuid', sha('x'))).toThrow();
    expect(() => blobKey(WORKSPACE, '../x')).toThrow();
  });

  it('sweeps staged uploads a dead process left behind, and only old ones', async () => {
    const abandoned = await store.stage(streamOf('left behind'), { maxBytes: 100 });
    const [name] = await readdir(path.join(root, 'staging'));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(root, 'staging', name!), old, old);
    await store.stage(streamOf('fresh'), { maxBytes: 100 });

    expect(await store.sweepStaging(60 * 60 * 1000)).toBe(1);
    expect(await readdir(path.join(root, 'staging'))).toHaveLength(1);
    await abandoned.discard();
  });
});

describe('local blob store listing', () => {
  it('lists the keys of blobs older than asked, and only those', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clewwiki-files-list-'));
    try {
      const store = createLocalBlobStore(root);
      const old = await store.stage(streamOf('old'), { maxBytes: 100 });
      const oldKey = blobKey(WORKSPACE, old.sha256);
      await old.commit(oldKey);
      const hash = old.sha256;
      const aged = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await utimes(path.join(root, 'blobs', WORKSPACE, hash.slice(0, 2), hash), aged, aged);
      const fresh = await store.stage(streamOf('fresh'), { maxBytes: 100 });
      await fresh.commit(blobKey(WORKSPACE, fresh.sha256));

      expect(await store.listOldKeys(24 * 60 * 60 * 1000, 10)).toEqual([oldKey]);
      expect(await createLocalBlobStore(path.join(root, 'nothing-here')).listOldKeys(0, 10)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
