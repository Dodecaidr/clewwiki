import { open, rm } from 'node:fs/promises';
import path from 'node:path';

import { AwsClient } from 'aws4fetch';

import { stageToDisk, sweepStagingDir } from './staging';
import { assertBlobKey } from './store';
import type { BlobRange, BlobStore, StagedBlob, StageOptions } from './store';

/**
 * A store in an S3-compatible bucket: Amazon S3, Cloudflare R2, Backblaze B2,
 * Hetzner, a Garage or SeaweedFS of your own.
 *
 * Uploads are staged on the local disk first, as with the local store, so the
 * key is known before anything reaches the bucket; committing sends the staged
 * file — in one request up to `partSize`, as a multipart upload past it, read a
 * part at a time so memory holds one part and no more. An object that is
 * already there is not sent again: same key, same content.
 *
 * Requests are signed with SigV4 by `aws4fetch`. The credentials never leave
 * this module: an error names the operation and the status the bucket answered
 * with, never a URL with a signature in it or a body the bucket wrote.
 */

export interface S3StoreOptions {
  /** `https://s3.eu-central-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, … */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket in the path (`endpoint/bucket/key`) rather than the host. Most self-hosted stores want it. */
  forcePathStyle?: boolean;
  /** Prepended to every key, for a bucket shared with something else. */
  prefix?: string;
  /** Where uploads are staged on this machine before they are sent. */
  stagingDir: string;
  /** Size of one part of a multipart upload, and the largest single upload. */
  partSize?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
const MIN_PART_SIZE = 5 * 1024 * 1024;

export class S3StoreError extends Error {
  constructor(operation: string, status: number) {
    super(`The file store answered ${status} to ${operation}`);
    this.name = 'S3StoreError';
  }
}

export function createS3BlobStore(options: S3StoreOptions): BlobStore {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('FILES_S3_ENDPOINT must be an http or https URL');
  }
  const pathStyle = options.forcePathStyle ?? true;
  const prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
  const partSize = Math.max(options.partSize ?? DEFAULT_PART_SIZE, MIN_PART_SIZE);
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: 's3',
    region: options.region,
  });
  const doFetch = options.fetchImpl ?? fetch;
  const send = async (url: string, init: RequestInit): Promise<Response> => doFetch(await client.sign(url, init));

  const bucketUrl = (): URL => {
    const base = new URL(endpoint.toString());
    if (pathStyle) {
      base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(options.bucket)}/`;
    } else {
      base.hostname = `${options.bucket}.${base.hostname}`;
      base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
    }
    return base;
  };
  const objectUrl = (key: string, query = ''): string => {
    assertBlobKey(key);
    const objectKey = prefix === '' ? key : `${prefix}/${key}`;
    const url = new URL(objectKey.split('/').map(encodeURIComponent).join('/'), bucketUrl());
    return `${url.toString()}${query}`;
  };

  const check = async (response: Response, operation: string, allowed: number[] = []): Promise<Response> => {
    if (response.ok || allowed.includes(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    throw new S3StoreError(operation, response.status);
  };

  async function has(key: string): Promise<boolean> {
    const response = await check(await send(objectUrl(key), { method: 'HEAD' }), 'HEAD', [404]);
    return response.status !== 404;
  }

  async function readPart(file: string, position: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const handle = await open(file, 'r');
    try {
      const buffer = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buffer.subarray(0, read);
    } finally {
      await handle.close();
    }
  }

  async function put(key: string, file: string, byteSize: number): Promise<void> {
    if (byteSize <= partSize) {
      const body = await readPart(file, 0, byteSize);
      await check(
        await send(objectUrl(key), { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' } }),
        'PUT',
      );
      return;
    }

    const created = await check(
      await send(objectUrl(key, '?uploads'), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } }),
      'CreateMultipartUpload',
    );
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await created.text())?.[1];
    if (!uploadId) throw new S3StoreError('CreateMultipartUpload', 502);

    const parts: string[] = [];
    try {
      for (let position = 0, number = 1; position < byteSize; position += partSize, number += 1) {
        const body = await readPart(file, position, Math.min(partSize, byteSize - position));
        const response = await check(
          await send(objectUrl(key, `?partNumber=${number}&uploadId=${encodeURIComponent(uploadId)}`), {
            method: 'PUT',
            body,
          }),
          'UploadPart',
        );
        const etag = response.headers.get('etag');
        if (!etag) throw new S3StoreError('UploadPart', 502);
        parts.push(`<Part><PartNumber>${number}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`);
      }
      const completed = await check(
        await send(objectUrl(key, `?uploadId=${encodeURIComponent(uploadId)}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/xml' },
          body: `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`,
        }),
        'CompleteMultipartUpload',
      );
      // A completion can fail inside a 200 answer.
      if ((await completed.text()).includes('<Error>')) throw new S3StoreError('CompleteMultipartUpload', 500);
    } catch (error) {
      await send(objectUrl(key, `?uploadId=${encodeURIComponent(uploadId)}`), { method: 'DELETE' }).catch(() => undefined);
      throw error;
    }
  }

  return {
    async stage(body: ReadableStream<Uint8Array>, stageOptions: StageOptions): Promise<StagedBlob> {
      const staged = await stageToDisk(options.stagingDir, body, stageOptions);
      let settled = false;
      const discard = async () => {
        if (settled) return;
        settled = true;
        await rm(staged.path, { force: true });
      };
      return {
        sha256: staged.sha256,
        byteSize: staged.byteSize,
        discard,
        async commit(key: string) {
          if (!(await has(key))) await put(key, staged.path, staged.byteSize);
          await discard();
        },
      };
    },

    has,

    async read(key: string, range?: BlobRange): Promise<ReadableStream<Uint8Array> | null> {
      const response = await check(
        await send(objectUrl(key), {
          method: 'GET',
          headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
        }),
        'GET',
        [404],
      );
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return response.body;
    },

    async remove(key: string): Promise<void> {
      await check(await send(objectUrl(key), { method: 'DELETE' }), 'DELETE', [404]);
    },

    sweepStaging(olderThanMs: number, now: Date = new Date()): Promise<number> {
      return sweepStagingDir(options.stagingDir, olderThanMs, now);
    },

    async listOldKeys(olderThanMs: number, limit: number, now: Date = new Date()): Promise<string[]> {
      const keys: string[] = [];
      let token: string | null = null;
      for (let requests = 0; requests < 100 && keys.length < limit; requests += 1) {
        const query = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
        if (prefix !== '') query.set('prefix', `${prefix}/`);
        if (token !== null) query.set('continuation-token', token);
        const url = bucketUrl();
        const response = await check(await send(`${url.toString()}?${query.toString()}`, { method: 'GET' }), 'ListObjectsV2');
        const xml = await response.text();
        for (const entry of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const body = entry[1] ?? '';
          const rawKey = unescapeXml(/<Key>([^<]*)<\/Key>/.exec(body)?.[1] ?? '');
          const modified = Date.parse(/<LastModified>([^<]*)<\/LastModified>/.exec(body)?.[1] ?? '');
          const key = prefix === '' ? rawKey : rawKey.slice(prefix.length + 1);
          try {
            assertBlobKey(key);
          } catch {
            continue;
          }
          if (!Number.isFinite(modified) || now.getTime() - modified < olderThanMs) continue;
          keys.push(key);
          if (keys.length >= limit) break;
        }
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        token = unescapeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '');
        if (token === '') break;
      }
      return keys;
    },
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Where a bucket store stages uploads: a directory of its own under the one given. */
export function s3StagingDir(root: string): string {
  return path.join(root, 'staging');
}
