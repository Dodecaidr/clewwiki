import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { blobKey, createS3BlobStore, S3StoreError } from '../src/index';
import type { BlobStore } from '../src/index';

/**
 * The bucket store against a real S3-compatible server.
 *
 * Point `FILES_S3_TEST_ENDPOINT`, `FILES_S3_TEST_BUCKET`, `FILES_S3_TEST_REGION`,
 * `FILES_S3_TEST_ACCESS_KEY_ID` and `FILES_S3_TEST_SECRET_ACCESS_KEY` at a
 * throwaway bucket — a Garage started for the purpose will do — and the suite
 * runs; leave them unset and it skips, so a plain `pnpm test` stays green.
 */

const env = {
  endpoint: process.env.FILES_S3_TEST_ENDPOINT ?? '',
  bucket: process.env.FILES_S3_TEST_BUCKET ?? '',
  region: process.env.FILES_S3_TEST_REGION ?? 'us-east-1',
  accessKeyId: process.env.FILES_S3_TEST_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.FILES_S3_TEST_SECRET_ACCESS_KEY ?? '',
};
const configured = env.endpoint !== '' && env.bucket !== '';

const WORKSPACE = randomUUID();

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
      }
      controller.close();
    },
  });
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = async (stream: ReadableStream<Uint8Array> | null) =>
  stream === null ? null : new Uint8Array(await new Response(stream).arrayBuffer());

describe.skipIf(!configured)('S3 blob store', () => {
  let staging: string;
  let store: BlobStore;
  const prefix = `test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    staging = await mkdtemp(path.join(tmpdir(), 'clewwiki-s3-staging-'));
    store = createS3BlobStore({ ...env, prefix, stagingDir: staging, partSize: 5 * 1024 * 1024 });
  });

  afterAll(async () => {
    await rm(staging, { recursive: true, force: true });
  });

  it('stores a small blob under its key, reads it back whole and in part, and removes it', async () => {
    const content = new TextEncoder().encode('hello from the bucket');
    const staged = await store.stage(streamOf(content), { maxBytes: 1024 });
    const key = blobKey(WORKSPACE, staged.sha256);
    expect(await store.has(key)).toBe(false);
    await staged.commit(key);
    expect(await store.has(key)).toBe(true);
    expect(await readdir(staging)).toEqual([]);

    expect(new TextDecoder().decode((await bytesOf(await store.read(key)))!)).toBe('hello from the bucket');
    expect(new TextDecoder().decode((await bytesOf(await store.read(key, { start: 6, end: 9 })))!)).toBe('from');

    // The same content again is not sent again.
    const again = await store.stage(streamOf(content), { maxBytes: 1024 });
    await again.commit(key);

    await store.remove(key);
    expect(await store.has(key)).toBe(false);
    expect(await store.read(key)).toBeNull();
    await expect(store.remove(key)).resolves.toBeUndefined();
  });

  it('sends a large blob as a multipart upload, a part at a time', async () => {
    const content = new Uint8Array(randomBytes(12 * 1024 * 1024 + 123));
    const staged = await store.stage(streamOf(content), { maxBytes: 64 * 1024 * 1024 });
    const key = blobKey(WORKSPACE, staged.sha256);
    await staged.commit(key);
    const back = await bytesOf(await store.read(key));
    expect(back!.byteLength).toBe(content.byteLength);
    expect(sha(back!)).toBe(sha(content));
    await store.remove(key);
  });

  it('lists the keys under its prefix that are old enough, and nothing else', async () => {
    const content = new TextEncoder().encode(`listed ${randomUUID()}`);
    const staged = await store.stage(streamOf(content), { maxBytes: 1024 });
    const key = blobKey(WORKSPACE, staged.sha256);
    await staged.commit(key);

    expect(await store.listOldKeys(60 * 60 * 1000, 100)).not.toContain(key);
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await store.listOldKeys(60 * 60 * 1000, 100, later)).toContain(key);

    const elsewhere = createS3BlobStore({ ...env, prefix: `${prefix}-other`, stagingDir: staging });
    expect(await elsewhere.listOldKeys(0, 100, later)).not.toContain(key);
    await store.remove(key);
  });

  it('names the operation and the status when the bucket refuses, and nothing more', async () => {
    const wrong = createS3BlobStore({ ...env, secretAccessKey: 'not-the-secret', prefix, stagingDir: staging });
    const error = await wrong.has(blobKey(WORKSPACE, sha(new Uint8Array([1])))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(S3StoreError);
    expect(String((error as Error).message)).toMatch(/^The file store answered 403 to HEAD$/);
  });
});
