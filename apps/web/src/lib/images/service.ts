import 'server-only';

import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { pageImages, pages } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import { getImageMaxUploadMb, getImageStoreMaxMb } from '../env';
import { PageServiceError } from '../pages/errors';
import { detectImageType } from './detect';
import type { ImageType } from './detect';

/**
 * The image store.
 *
 * An image is reached through its page: whoever can see the page can see its
 * images, in whichever space the page is now, and an image of a deleted page is
 * gone with it. This module answers "which space decides" for every image it
 * returns (`visibleInSpaceId`, `uploaderOnly`); whether the caller can see that
 * space is the handler's check, written out next to the workspace check as it
 * is for pages.
 */

const MB = 1024 * 1024;

export interface ImageActor {
  type: 'user' | 'agent';
  id: string;
}

export interface ImageLimits {
  /** Zero when uploads are switched off. */
  uploadBytes: number;
  storeBytes: number;
}

export function imageLimits(): ImageLimits {
  return { uploadBytes: getImageMaxUploadMb() * MB, storeBytes: getImageStoreMaxMb() * MB };
}

export interface ImageRecord {
  id: string;
  workspaceId: string;
  pageId: string | null;
  contentType: ImageType;
  byteSize: number;
  sha256: string;
  createdByType: 'user' | 'agent';
  createdById: string;
  createdAt: Date;
}

const metadataColumns = {
  id: pageImages.id,
  workspaceId: pageImages.workspaceId,
  pageId: pageImages.pageId,
  contentType: pageImages.contentType,
  byteSize: pageImages.byteSize,
  sha256: pageImages.sha256,
  createdByType: pageImages.createdByType,
  createdById: pageImages.createdById,
  createdAt: pageImages.createdAt,
};

function toRecord(row: Omit<ImageRecord, 'contentType'> & { contentType: string }): ImageRecord {
  return { ...row, contentType: row.contentType as ImageType };
}

export interface StoreImageInput {
  workspaceId: string;
  /** The space the upload is made in: the page's, or the one a new page is being written in. */
  spaceId: string;
  /** Null from the new-page form; the page claims the image when it is created. */
  pageId: string | null;
  actor: ImageActor;
  bytes: Uint8Array;
}

/**
 * Stores an upload, or returns the image already stored when this page has
 * these exact bytes — pasting the same screenshot twice is one image.
 *
 * Refused as `validation`: uploads switched off, an empty or oversized body,
 * and bytes that are not one of the accepted formats, whatever they were
 * declared as. Refused as `conflict`: the workspace's store is full.
 */
export async function storeImage(input: StoreImageInput): Promise<{ image: ImageRecord; created: boolean }> {
  const limits = imageLimits();
  if (limits.uploadBytes === 0) {
    throw new PageServiceError('forbidden', 'Image uploads are switched off on this instance');
  }
  if (input.bytes.byteLength === 0) {
    throw new PageServiceError('validation', 'The upload is empty');
  }
  if (input.bytes.byteLength > limits.uploadBytes) {
    throw new PageServiceError(
      'validation',
      `The image is larger than the ${Math.round(limits.uploadBytes / MB)} MB limit`,
      { bytes: input.bytes.byteLength, limit: limits.uploadBytes },
    );
  }
  const contentType = detectImageType(input.bytes);
  if (contentType === null) {
    throw new PageServiceError('validation', 'Only PNG, JPEG, GIF and WebP images can be uploaded', {
      accepted: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    });
  }

  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const db = getDatabase();

  return db.transaction(async (tx) => {
    // The same bytes on the same page, or waiting for the same author's new
    // page, are the same image.
    const [existing] = await tx
      .select(metadataColumns)
      .from(pageImages)
      .where(
        and(
          eq(pageImages.workspaceId, input.workspaceId),
          eq(pageImages.sha256, sha256),
          input.pageId === null
            ? and(
                isNull(pageImages.pageId),
                eq(pageImages.spaceId, input.spaceId),
                eq(pageImages.createdByType, input.actor.type),
                eq(pageImages.createdById, input.actor.id),
              )
            : eq(pageImages.pageId, input.pageId),
        ),
      )
      .limit(1);
    if (existing) return { image: toRecord(existing), created: false };

    const [usage] = await tx
      .select({ bytes: sql<string>`coalesce(sum(${pageImages.byteSize}), 0)` })
      .from(pageImages)
      .where(eq(pageImages.workspaceId, input.workspaceId));
    const used = Number(usage?.bytes ?? 0);
    if (used + input.bytes.byteLength > limits.storeBytes) {
      throw new PageServiceError(
        'conflict',
        'The image store of this workspace is full; an administrator can raise IMAGE_STORE_MAX_MB or remove images',
        { used_bytes: used, limit_bytes: limits.storeBytes },
      );
    }

    const [created] = await tx
      .insert(pageImages)
      .values({
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        pageId: input.pageId,
        contentType,
        byteSize: input.bytes.byteLength,
        sha256,
        data: input.bytes,
        createdByType: input.actor.type,
        createdById: input.actor.id,
      })
      .returning(metadataColumns);
    if (!created) throw new Error('image insert returned no row');

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'image.uploaded',
        target: created.id,
        metadata: { pageId: input.pageId, spaceId: input.spaceId, contentType, bytes: created.byteSize, sha256 },
      },
      tx,
    );

    return { image: toRecord(created), created: true };
  });
}

export interface ImageAccess extends ImageRecord {
  /** The space whose visibility decides who may see the image. */
  visibleInSpaceId: string;
  /** True while no page has claimed it: only whoever uploaded it may see it. */
  uploaderOnly: boolean;
}

/**
 * One image, and the space that decides who sees it — without its bytes, so
 * that a refusal and a "not modified" cost a row and not a file. `null` for an
 * image that does not exist in this workspace, and for one whose page has been
 * deleted: a deleted page's pictures are no more readable than its text.
 */
export async function getImageAccess(workspaceId: string, imageId: string): Promise<ImageAccess | null> {
  const [row] = await getDatabase()
    .select({
      ...metadataColumns,
      uploadSpaceId: pageImages.spaceId,
      pageSpaceId: pages.spaceId,
      pageDeletedAt: pages.deletedAt,
    })
    .from(pageImages)
    .leftJoin(pages, eq(pages.id, pageImages.pageId))
    .where(and(eq(pageImages.id, imageId), eq(pageImages.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;

  const { uploadSpaceId, pageSpaceId, pageDeletedAt, ...metadata } = row;
  if (metadata.pageId !== null && (pageSpaceId === null || pageDeletedAt !== null)) return null;

  return {
    ...toRecord(metadata),
    visibleInSpaceId: pageSpaceId ?? uploadSpaceId,
    uploaderOnly: metadata.pageId === null,
  };
}

/** The bytes of an image the caller has already been allowed to see. */
export async function getImageData(workspaceId: string, imageId: string): Promise<Uint8Array | null> {
  const [row] = await getDatabase()
    .select({ data: pageImages.data })
    .from(pageImages)
    .where(and(eq(pageImages.id, imageId), eq(pageImages.workspaceId, workspaceId)))
    .limit(1);
  return row?.data ?? null;
}

/** The images of a page, newest first, without their bytes. */
export async function listImagesForPage(workspaceId: string, pageId: string): Promise<ImageRecord[]> {
  const rows = await getDatabase()
    .select(metadataColumns)
    .from(pageImages)
    .where(and(eq(pageImages.workspaceId, workspaceId), eq(pageImages.pageId, pageId)))
    .orderBy(sql`${pageImages.createdAt} desc`);
  return rows.map(toRecord);
}

/**
 * Removes an image for good — the one thing here that is not soft, because the
 * reason to remove a picture is usually what is in it. Revisions that refer to
 * it keep their text and show a broken image, which is the honest rendering of
 * a picture that was taken down.
 */
export async function deleteImage(input: {
  workspaceId: string;
  imageId: string;
  actor: ImageActor;
}): Promise<boolean> {
  return getDatabase().transaction(async (tx) => {
    const [removed] = await tx
      .delete(pageImages)
      .where(and(eq(pageImages.id, input.imageId), eq(pageImages.workspaceId, input.workspaceId)))
      .returning({ id: pageImages.id, pageId: pageImages.pageId, sha256: pageImages.sha256, bytes: pageImages.byteSize });
    if (!removed) return false;

    await recordAudit(
      {
        workspaceId: input.workspaceId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'image.deleted',
        target: removed.id,
        metadata: { pageId: removed.pageId, sha256: removed.sha256, bytes: removed.bytes },
      },
      tx,
    );
    return true;
  });
}
