import 'server-only';

import { createLocalBlobStore, createS3BlobStore, s3StagingDir } from '@clewwiki/files';
import type { BlobStore } from '@clewwiki/files';

import { getFilesDir, getFilesDriver, getFilesMaxUploadMb, getFilesS3Settings, getFilesStoreMaxMb } from '../env';

const MB = 1024 * 1024;

declare global {
  var __clewwikiFileStore: { driver: string; dir: string; store: BlobStore } | undefined;
}

/**
 * The instance's file store, or `null` when attached files are switched off.
 * One per process, rebuilt only if the configuration it was built from changed
 * — which in practice means only in tests.
 */
export function getFileStore(): BlobStore | null {
  const driver = getFilesDriver();
  if (driver === 'off') return null;
  const dir = getFilesDir();
  const cached = globalThis.__clewwikiFileStore;
  if (cached && cached.driver === driver && cached.dir === dir) return cached.store;
  // A bucket store still stages on the local disk, under FILES_DIR: the key of
  // an upload is its hash, and the hash is known only once it has been read.
  const store =
    driver === 's3' ? createS3BlobStore({ ...getFilesS3Settings(), stagingDir: s3StagingDir(dir) }) : createLocalBlobStore(dir);
  globalThis.__clewwikiFileStore = { driver, dir, store };
  return store;
}

export function filesEnabled(): boolean {
  return getFilesDriver() !== 'off';
}

export interface FileLimits {
  uploadBytes: number;
  storeBytes: number;
}

export function fileLimits(): FileLimits {
  return { uploadBytes: getFilesMaxUploadMb() * MB, storeBytes: getFilesStoreMaxMb() * MB };
}
