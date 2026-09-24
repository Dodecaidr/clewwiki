/**
 * Where the bytes of attached files live.
 *
 * A store knows nothing about pages, versions or who may read what: it keeps
 * blobs under keys and hands them back. Everything else — which blob a version
 * is, who can see it, when it stops being needed — is in the database, so a
 * store can be swapped without touching any rule.
 *
 * A blob is addressed by its content: the key is the workspace and the SHA-256
 * of the bytes, so a file uploaded twice is stored once, and a key never names
 * two different contents. That is also why a write is two steps. The bytes are
 * streamed to a staging area first, hashed on the way, and only then given the
 * key the hash decides — nothing is ever written under a key before its content
 * is known.
 */

export interface BlobRange {
  /** First byte, inclusive. */
  start: number;
  /** Last byte, inclusive. */
  end: number;
}

/** An upload that has been read to the end and hashed, and is not stored yet. */
export interface StagedBlob {
  sha256: string;
  byteSize: number;
  /**
   * Stores the bytes under `key`. A key that already holds a blob keeps it —
   * same key, same content — and the staged copy is dropped.
   */
  commit(key: string): Promise<void>;
  /** Drops the staged bytes. Safe to call after `commit`, and more than once. */
  discard(): Promise<void>;
}

export interface StageOptions {
  /** The upload is refused with `BlobTooLargeError` past this many bytes. */
  maxBytes: number;
}

export interface BlobStore {
  /** Reads `body` to the end into the staging area, never past `maxBytes`. */
  stage(body: ReadableStream<Uint8Array>, options: StageOptions): Promise<StagedBlob>;
  has(key: string): Promise<boolean>;
  /** The blob, or a range of it; `null` when there is no blob under `key`. */
  read(key: string, range?: BlobRange): Promise<ReadableStream<Uint8Array> | null>;
  /** Removes a blob. Removing one that is not there is not an error. */
  remove(key: string): Promise<void>;
  /** Drops staged uploads older than `olderThanMs` — left behind by a process that died mid-upload. */
  sweepStaging(olderThanMs: number, now?: Date): Promise<number>;
  /**
   * Keys of blobs last written more than `olderThanMs` ago, up to `limit`: what
   * a caller compares with its own records to find blobs nothing knows about.
   */
  listOldKeys(olderThanMs: number, limit: number, now?: Date): Promise<string[]>;
}

export class BlobTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`The upload is larger than ${limit} bytes`);
    this.name = 'BlobTooLargeError';
  }
}

export class EmptyBlobError extends Error {
  constructor() {
    super('The upload is empty');
    this.name = 'EmptyBlobError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/**
 * The key of a workspace's blob: `<workspace>/<first two hex digits>/<sha256>`.
 * The two-digit level keeps any one directory of a local store to a size a
 * file system lists comfortably.
 */
export function blobKey(workspaceId: string, sha256: string): string {
  if (!UUID.test(workspaceId)) throw new Error('blobKey: workspace id is not a UUID');
  if (!SHA256.test(sha256)) throw new Error('blobKey: not a lowercase SHA-256');
  return `${workspaceId}/${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * Refuses anything that is not a key `blobKey` could have made. Every store
 * checks this before touching storage, so no caller can reach outside the
 * store with a key of its own making.
 */
export function assertBlobKey(key: string): void {
  if (!KEY.test(key)) throw new Error('Not a blob key');
}
