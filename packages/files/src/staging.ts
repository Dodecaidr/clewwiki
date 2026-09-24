import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { BlobTooLargeError, EmptyBlobError } from './store';
import type { StageOptions } from './store';

/**
 * Staging, shared by every store: an upload is read to the end into a file of
 * its own on the local disk, hashed on the way, and only then handed to the
 * store under the key its hash decides. Whatever the store is — a directory or
 * a bucket — nothing is written under a key before its content is known.
 */

export interface StagedFile {
  path: string;
  sha256: string;
  byteSize: number;
}

export async function stageToDisk(
  stagingDir: string,
  body: ReadableStream<Uint8Array>,
  options: StageOptions,
): Promise<StagedFile> {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const stagedPath = path.join(stagingDir, randomUUID());
  const hash = createHash('sha256');
  let byteSize = 0;

  // Written through a handle opened up front, so that there is never a moment
  // when a refused upload's file is still being created after it was removed.
  const out = await open(stagedPath, 'wx', 0o600);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > options.maxBytes) throw new BlobTooLargeError(byteSize, options.maxBytes);
      hash.update(value);
      // A write may take fewer bytes than it was given; the rest is written
      // until none is left, so a blob is never shorter than its hash says.
      for (let offset = 0; offset < value.byteLength; ) {
        const { bytesWritten } = await out.write(value, offset, value.byteLength - offset);
        offset += bytesWritten;
      }
    }
    if (byteSize === 0) throw new EmptyBlobError();
    // On disk before it can be stored under its key: a key is forever.
    await out.sync();
    await out.close();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await out.close().catch(() => undefined);
    await rm(stagedPath, { force: true });
    throw error;
  }
  return { path: stagedPath, sha256: hash.digest('hex'), byteSize };
}

/** Drops staged uploads older than `olderThanMs`: left behind by a process that died mid-upload. */
export async function sweepStagingDir(stagingDir: string, olderThanMs: number, now: Date = new Date()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(stagingDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const file = path.join(stagingDir, name);
    try {
      const info = await stat(file);
      if (now.getTime() - info.mtimeMs < olderThanMs) continue;
      await rm(file, { force: true });
      removed += 1;
    } catch {
      // Gone between listing and looking: somebody else finished with it.
    }
  }
  return removed;
}
