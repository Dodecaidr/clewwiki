import 'server-only';

import type { NextResponse } from 'next/server';

import { apiError } from '../api-response';
import { imageHref, IMAGE_EXTENSIONS } from './detect';
import { consumeUploadBudget } from './rate-limit';
import { imageLimits } from './service';
import type { ImageActor, ImageRecord } from './service';

/**
 * Reads an image upload's body, never holding more than the limit.
 *
 * The declared size refuses an oversized upload before a byte is read; the
 * count while reading refuses one that declared less than it sent. Both answer
 * `413`. An upload with no declared size is `411`, as the import's is.
 */
export async function readImageUpload(
  request: Request,
  actor: ImageActor,
): Promise<{ bytes: Uint8Array } | { response: NextResponse }> {
  const limits = imageLimits();
  if (limits.uploadBytes === 0) {
    return { response: apiError(403, 'forbidden', 'Image uploads are switched off on this instance') };
  }

  const budget = consumeUploadBudget(actor.type, actor.id);
  if (!budget.allowed) {
    return {
      response: apiError(429, 'rate_limited', 'Too many image uploads in a short time', {
        retry_after_seconds: budget.resetAfterSeconds,
      }),
    };
  }

  const tooLarge = (bytes: number) =>
    apiError(413, 'validation', `The image is larger than the ${Math.round(limits.uploadBytes / (1024 * 1024))} MB limit`, {
      bytes,
      limit: limits.uploadBytes,
    });

  const header = request.headers.get('content-length');
  if (header === null || !/^\d+$/.test(header.trim())) {
    return { response: apiError(411, 'validation', 'An upload must declare its size (Content-Length)') };
  }
  if (Number(header.trim()) > limits.uploadBytes) return { response: tooLarge(Number(header.trim())) };

  if (!request.body) return { response: apiError(400, 'validation', 'The upload is empty') };

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.uploadBytes) {
        await reader.cancel();
        return { response: tooLarge(total) };
      }
      chunks.push(value);
    }
  } catch {
    return { response: apiError(400, 'validation', 'The upload could not be read') };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

export interface ImageResource {
  image_id: string;
  page_id: string | null;
  /** Relative on purpose: put it in a page body as it is. */
  url: string;
  content_type: string;
  bytes: number;
  sha256: string;
  file_name: string;
  created_at: string;
  created_by: { type: string; id: string };
}

export function toImageResource(image: ImageRecord): ImageResource {
  return {
    image_id: image.id,
    page_id: image.pageId,
    url: imageHref(image.id),
    content_type: image.contentType,
    bytes: image.byteSize,
    sha256: image.sha256,
    file_name: `${image.id}.${IMAGE_EXTENSIONS[image.contentType]}`,
    created_at: image.createdAt.toISOString(),
    created_by: { type: image.createdByType, id: image.createdById },
  };
}
