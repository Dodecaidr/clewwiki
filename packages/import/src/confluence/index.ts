/**
 * The Confluence source adapter.
 *
 * Reads one space of a Confluence site — Cloud over the REST API v2, Server and
 * Data Center over v1 — and turns it into the tree the rest of the pipeline
 * works on. The storage format of a page body is the same on both, so
 * everything after the listing is shared. The credential is passed in,
 * used for the length of this call, and never returned, stored or recorded: the
 * `params` the import row keeps carry the site address and the space key and
 * nothing else.
 *
 * What differs between the two lives in `client.ts`: the API, the context path,
 * the credential, and the rule that lets a site on a private network be reached.
 */

import { archivePathHref, imagePlaceholderFor, referencedImageKeys, rewriteImages } from '../images';
import type { ImportAsset } from '../images';
import { ImportError } from '../limits';
import type { ImportLimits } from '../limits';
import { truncateToBytes, utf8Length } from '../limits';
import { warn } from '../types';
import type { ImportNode, ImportParseResult, ImportWarning } from '../types';
import { ConfluenceClient } from './client';
import type { ConfluenceCredentials, ConfluenceClientOptions, ConfluencePage } from './client';
import { convertStorageToMarkdown } from './storage';

export * from './client';
export * from './storage';
export * from './xml';

export interface ConfluenceImportInput {
  credentials: ConfluenceCredentials;
  spaceKey: string;
  limits: ImportLimits;
  client?: ConfluenceClientOptions;
}

export async function importFromConfluence(input: ConfluenceImportInput): Promise<ImportParseResult> {
  const client = new ConfluenceClient(input.credentials, {
    maxImageBytes: input.limits.imageBytes,
    ...input.client,
  });
  const space = await client.findSpaceId(input.spaceKey);
  // One over the cap, so an export that is exactly at the limit can be told
  // apart from one that was cut short.
  const pages = await client.listPages(space.id, input.limits.pages + 1);

  const warnings: ImportWarning[] = [];
  if (pages.length > input.limits.pages) {
    throw new ImportError('validation', `This space has more than ${input.limits.pages} pages`, {
      limit: input.limits.pages,
    });
  }
  if (pages.length === 0) {
    warnings.push(warn('empty', input.spaceKey));
  }

  // Link resolution is by title, which is how `ri:page` names its target.
  // A duplicate title inside one space is not possible in Confluence, so the
  // map is unambiguous.
  const pageIdByTitle = new Map<string, string>();
  for (const page of pages) pageIdByTitle.set(page.title, page.id);
  const known = new Set(pages.map((page) => page.id));

  const converted = pages.map((page, index) =>
    toNode(page, index, {
      baseUrl: client.contentBase(),
      pageIdByTitle,
      known,
      limits: input.limits,
    }),
  );

  // Images are fetched after every page has been read, one at a time: the
  // pages are what the import is for, and a site that is slow or stingy with
  // pictures should cost pictures.
  const assets: ImportAsset[] = [];
  let budget = input.limits.expandedBytes;
  const nodes: ImportNode[] = [];
  for (const { node, images, pageId } of converted) {
    const lost = new Map<string, string>();
    for (const { key, filename } of images) {
      if (assets.length >= input.limits.imageDownloads) {
        lost.set(key, `more than ${input.limits.imageDownloads} images in one import`);
        continue;
      }
      const download = await client.downloadAttachment(pageId, filename);
      if ('failed' in download) {
        lost.set(key, download.failed);
      } else if (download.data.byteLength > budget) {
        lost.set(key, 'the images of this import are larger together than it may hold');
      } else {
        budget -= download.data.byteLength;
        assets.push({ key, data: download.data });
      }
    }
    // What could not be fetched goes back to being what it always was: an
    // image that points at Confluence, with a warning that says so.
    nodes.push(
      lost.size === 0
        ? node
        : {
            ...node,
            markdown: rewriteImages(node.markdown, (key) =>
              lost.has(key) ? archivePathHref(key) : imagePlaceholderFor(key),
            ),
            warnings: [
              ...node.warnings,
              ...[...lost].map(([key, reason]) =>
                warn('external-attachment', `${key.slice(key.lastIndexOf('/') + 1)}: ${reason}`),
              ),
            ],
          },
    );
  }

  return {
    source: 'confluence',
    nodes,
    assets,
    warnings,
    // Everything recorded about the run. No e-mail, no token: the two things a
    // reader of the imports table must never be able to recover.
    params: {
      base_url: client.describe().base_url,
      deployment: client.describe().deployment,
      space_key: input.spaceKey,
      space_name: space.name,
      page_count: pages.length,
      image_count: assets.length,
    },
  };
}

interface NodeContext {
  baseUrl: string;
  pageIdByTitle: ReadonlyMap<string, string>;
  known: ReadonlySet<string>;
  limits: ImportLimits;
}

interface ConvertedPage {
  node: ImportNode;
  pageId: string;
  images: Array<{ filename: string; key: string }>;
}

function toNode(page: ConfluencePage, index: number, context: NodeContext): ConvertedPage {
  const converted = convertStorageToMarkdown(page.storage, {
    // Attachments are served under `/wiki` on a Cloud site and under the
    // context path on a Data Center; the client knows which.
    baseUrl: context.baseUrl,
    pageId: page.id,
    pageIdByTitle: context.pageIdByTitle,
    carryImages: context.limits.imageBytes > 0,
  });

  const warnings = [...converted.warnings];
  let markdown = converted.markdown;
  if (utf8Length(markdown) > context.limits.pageBytes) {
    markdown = truncateToBytes(markdown, context.limits.pageBytes);
    warnings.push(warn('truncated', page.title));
  }
  if (markdown.trim() === '') warnings.push(warn('empty'));

  const node: ImportNode = {
    sourceId: page.id,
    parentSourceId:
      page.parentId !== null && context.known.has(page.parentId) ? page.parentId : null,
    title: page.title.trim() === '' ? 'Untitled' : page.title.trim(),
    kind: 'human',
    markdown,
    attachments: converted.attachments.map((name) => ({ name })),
    ...(page.webUrl === null ? {} : { sourceUrl: page.webUrl }),
    ...(page.updatedAt === null ? {} : { updatedAt: page.updatedAt }),
    warnings,
    ordering: page.position ?? index,
  };
  // A body cut to the limit may have lost some of its images with the cut.
  const shown = new Set(referencedImageKeys(markdown));
  return { node, pageId: page.id, images: converted.images.filter((image) => shown.has(image.key)) };
}
