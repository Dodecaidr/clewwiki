import { createReadStream } from 'node:fs';
import { link, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { stageToDisk, sweepStagingDir } from './staging';
import { assertBlobKey } from './store';
import type { BlobRange, BlobStore, StagedBlob, StageOptions } from './store';

/**
 * A store on the local file system: `<root>/blobs/<key>` for blobs and
 * `<root>/staging/` for uploads still being read.
 *
 * Staging lives under the same root so that committing is a hard link on one
 * file system — a blob appears whole or not at all, and two uploads of the
 * same content racing to commit leave one blob, not a torn one. A link that
 * finds the key taken is exactly the "already stored" case, and the staged copy
 * is simply dropped.
 *
 * Files are written owner-only. Nothing here is served from disk directly; the
 * application reads a blob only after deciding the caller may see it.
 */
export function createLocalBlobStore(root: string): BlobStore {
  const blobsDir = path.join(root, 'blobs');
  const stagingDir = path.join(root, 'staging');

  const blobPath = (key: string) => {
    assertBlobKey(key);
    return path.join(blobsDir, ...key.split('/'));
  };

  return {
    async stage(body: ReadableStream<Uint8Array>, options: StageOptions): Promise<StagedBlob> {
      const { path: stagedPath, sha256, byteSize } = await stageToDisk(stagingDir, body, options);
      let settled = false;
      const discard = async () => {
        if (settled) return;
        settled = true;
        await rm(stagedPath, { force: true });
      };
      return {
        sha256,
        byteSize,
        discard,
        async commit(key: string) {
          const target = blobPath(key);
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          try {
            await link(stagedPath, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          await discard();
        },
      };
    },

    async has(key: string): Promise<boolean> {
      try {
        return (await stat(blobPath(key))).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },

    async read(key: string, range?: BlobRange): Promise<ReadableStream<Uint8Array> | null> {
      const file = blobPath(key);
      try {
        await stat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const stream = createReadStream(file, range ? { start: range.start, end: range.end } : undefined);
      return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    },

    async remove(key: string): Promise<void> {
      try {
        await unlink(blobPath(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },

    async listOldKeys(olderThanMs: number, limit: number, now: Date = new Date()): Promise<string[]> {
      const keys: string[] = [];
      const list = async (dir: string) => readdir(dir).catch(() => [] as string[]);
      for (const workspace of await list(blobsDir)) {
        for (const prefix of await list(path.join(blobsDir, workspace))) {
          for (const sha of await list(path.join(blobsDir, workspace, prefix))) {
            const key = `${workspace}/${prefix}/${sha}`;
            try {
              assertBlobKey(key);
              const info = await stat(path.join(blobsDir, workspace, prefix, sha));
              if (now.getTime() - info.mtimeMs < olderThanMs) continue;
            } catch {
              continue;
            }
            keys.push(key);
            if (keys.length >= limit) return keys;
          }
        }
      }
      return keys;
    },

    sweepStaging(olderThanMs: number, now: Date = new Date()): Promise<number> {
      return sweepStagingDir(stagingDir, olderThanMs, now);
    },
  };
}
