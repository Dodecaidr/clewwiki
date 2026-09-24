import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import { importImages, pageImages } from '@clewwiki/db';
import { archivePathHref, referencedImageKeys, rewriteFiles, rewriteImages, warn } from '@clewwiki/import';
import type { ImportAsset, ImportNode, ImportWarning } from '@clewwiki/import';

import { getDatabase } from '../db';
import { detectImageType, imageHref } from '../images/detect';
import { imageLimits, storeImage } from '../images/service';

/**
 * The images of an import, between the archive and the pages.
 *
 * An archive's pictures go through the same door as a person's upload, held to
 * the same rules: the type is read from the bytes, the size limit is the
 * instance's, and the workspace's store has to have room. The difference is
 * when. An upload is judged when it arrives; an import's images are judged when
 * it is *staged*, so that what could not be taken is a warning the reviewer
 * reads before applying, not a broken picture they find afterwards.
 *
 * What passes waits in `import_images` and becomes a page's image when the page
 * is written — through `storeImage`, so it is audited and deduplicated like any
 * other. What does not pass keeps its placeholder, and a placeholder with
 * nothing behind it resolves to the path the document used.
 */

const MB = 1024 * 1024;

export interface StagedImages {
  accepted: Array<ImportAsset & { contentType: string }>;
  /** Why each refused image was refused, by asset key. */
  refused: Map<string, string>;
}

/** Decides which of an import's images will be carried. Writes nothing. */
export async function judgeImportImages(
  workspaceId: string,
  assets: readonly ImportAsset[],
): Promise<StagedImages> {
  const result: StagedImages = { accepted: [], refused: new Map() };
  if (assets.length === 0) return result;

  const limits = imageLimits();
  if (limits.uploadBytes === 0) {
    for (const asset of assets) result.refused.set(asset.key, 'image uploads are switched off on this instance');
    return result;
  }

  const [usage] = await getDatabase()
    .select({ bytes: sql<string>`coalesce(sum(${pageImages.byteSize}), 0)` })
    .from(pageImages)
    .where(eq(pageImages.workspaceId, workspaceId));
  let room = limits.storeBytes - Number(usage?.bytes ?? 0);

  for (const asset of assets) {
    const contentType = detectImageType(asset.data);
    if (asset.data.byteLength === 0 || contentType === null) {
      result.refused.set(asset.key, 'not a PNG, JPEG, GIF or WebP image');
    } else if (asset.data.byteLength > limits.uploadBytes) {
      result.refused.set(asset.key, `larger than the ${Math.round(limits.uploadBytes / MB)} MB image limit`);
    } else if (asset.data.byteLength > room) {
      result.refused.set(asset.key, 'the image store of this workspace is full');
    } else {
      room -= asset.data.byteLength;
      result.accepted.push({ ...asset, contentType });
    }
  }
  return result;
}

/** The warnings a node earns for the refused images it shows. */
export function refusedImageWarnings(
  node: Pick<ImportNode, 'markdown'>,
  refused: ReadonlyMap<string, string>,
): ImportWarning[] {
  if (refused.size === 0) return [];
  return referencedImageKeys(node.markdown)
    .filter((key) => refused.has(key))
    .map((key) => warn('image-skipped', `${key}: ${refused.get(key)}`));
}

export async function stageImportImages(importId: string, images: StagedImages['accepted']): Promise<void> {
  const db = getDatabase();
  // One row at a time: a statement carrying every picture of an export at once
  // is a statement sized by somebody else's archive.
  for (const image of images) {
    await db.insert(importImages).values({
      importId,
      key: image.key,
      contentType: image.contentType,
      byteSize: image.data.byteLength,
      data: image.data,
    });
  }
}

export async function dropStagedImages(importId: string): Promise<void> {
  await getDatabase().delete(importImages).where(eq(importImages.importId, importId));
}

/** The body as a reviewer reads it: every image under the path the archive had it at. */
export function previewImages(markdown: string): string {
  return rewriteFiles(rewriteImages(markdown, archivePathHref), archivePathHref);
}

export interface CarryImagesInput {
  workspaceId: string;
  spaceId: string;
  importId: string;
  /** The page being overwritten, or null for a page about to be created. */
  pageId: string | null;
  actor: { type: 'user'; id: string };
  markdown: string;
}

export interface CarriedImages {
  markdown: string;
  carried: number;
  failed: number;
}

/**
 * Stores the staged images one body shows and points the body at them.
 *
 * For a new page they are stored unattached, exactly as the new-page form
 * stores them, and `createPage` claims the ones its body names in the
 * transaction that makes the page. For an overwrite they go straight onto the
 * page. Each page gets its own copy of an image two pages share: an image is
 * seen by whoever can see its page, and pages move.
 */
export async function carryImages(input: CarryImagesInput): Promise<CarriedImages> {
  const keys = referencedImageKeys(input.markdown);
  if (keys.length === 0) return { markdown: input.markdown, carried: 0, failed: 0 };

  const db = getDatabase();
  const hrefs = new Map<string, string>();
  let failed = 0;

  for (const key of keys) {
    const [staged] = await db
      .select({ data: importImages.data })
      .from(importImages)
      .where(and(eq(importImages.importId, input.importId), eq(importImages.key, key)))
      .limit(1);
    // Refused when the import was staged: the reviewer has already been told.
    if (!staged) continue;

    try {
      const { image } = await storeImage({
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        pageId: input.pageId,
        actor: input.actor,
        bytes: staged.data,
      });
      hrefs.set(key, imageHref(image.id));
    } catch (error) {
      // The store filled up, or uploads were switched off, between staging and
      // applying. The page is still worth having; the result says what it lost.
      failed += 1;
      console.error('[imports] an image could not be carried', { importId: input.importId }, error);
    }
  }

  return {
    markdown: rewriteImages(input.markdown, (key) => hrefs.get(key) ?? archivePathHref(key)),
    carried: hrefs.size,
    failed,
  };
}
