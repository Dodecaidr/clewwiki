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
import type { FileSink, ImportNode, ImportParseResult, ImportWarning } from '../types';
import { ConfluenceClient } from './client';
import type { ConfluenceAttachment, ConfluenceCredentials, ConfluenceClientOptions, ConfluencePage } from './client';
import { convertStorageToMarkdown } from './storage';

export * from './client';
export * from './storage';
export * from './xml';

export interface ConfluenceImportInput {
  credentials: ConfluenceCredentials;
  spaceKey: string;
  limits: ImportLimits;
  client?: ConfluenceClientOptions;
  /**
   * Where the page's other attachments go, with their earlier versions. Left
   * out, attachments that are not images a page shows stay behind, as before.
   */
  files?: FileSink;
}

/** File versions carried in one import, across all pages. */
export const MAX_IMPORTED_FILE_VERSIONS = 5_000;

export async function importFromConfluence(input: ConfluenceImportInput): Promise<ImportParseResult> {
  const client = new ConfluenceClient(input.credentials, {
    maxImageBytes: input.limits.imageBytes,
    ...(input.files ? { maxFileBytes: input.files.maxFileBytes } : {}),
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

  let fileVersions = 0;
  let files = 0;
  if (input.files) {
    const sink = input.files;
    for (let index = 0; index < nodes.length; index += 1) {
      const entry = converted[index];
      const node = nodes[index];
      if (!entry || !node) continue;
      const carried = await carryAttachments(client, sink, entry, MAX_IMPORTED_FILE_VERSIONS - fileVersions);
      fileVersions += carried.versions;
      files += carried.files;
      if (carried.warnings.length > 0) nodes[index] = { ...node, warnings: [...node.warnings, ...carried.warnings] };
    }
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
      ...(input.files ? { file_count: files, file_version_count: fileVersions } : {}),
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

/**
 * The attachments of one page, each with its history, into the sink.
 *
 * An image the page shows is already carried as the page's image and is not
 * carried twice. The rest go oldest version first, so the file's history on
 * this side reads in the order it happened. An earlier version is refused, not
 * faked: when the site serves a download of another size than its record of
 * that version — some answer every `?version=` with the latest; cwiki.apache.org
 * does — the version is left out with a warning rather than stored as history
 * it is not.
 *
 * Nothing here ends the import. A page whose attachments cannot be listed, a
 * download that fails, a sink that is full: each is a warning on the page.
 */
async function carryAttachments(
  client: ConfluenceClient,
  sink: FileSink,
  page: ConvertedPage,
  budget: number,
): Promise<{ files: number; versions: number; warnings: ImportWarning[] }> {
  const warnings: ImportWarning[] = [];
  // Past the import's budget there is nothing to ask the site for.
  if (budget <= 0) return { files: 0, versions: 0, warnings };
  let attachments: ConfluenceAttachment[];
  try {
    attachments = await client.listAttachments(page.pageId);
  } catch (error) {
    warnings.push(warn('file-skipped', `attachments of this page could not be listed: ${reasonOf(error)}`));
    return { files: 0, versions: 0, warnings };
  }

  const shown = new Set(page.images.map((image) => image.filename));
  let position = 0;
  let files = 0;
  let versions = 0;
  for (const current of attachments) {
    if (shown.has(current.title)) continue;
    if (current.fileSize !== null && current.fileSize > sink.maxFileBytes) {
      warnings.push(warn('file-skipped', `${current.title}: larger than this instance takes`));
      continue;
    }

    const history = await client.listAttachmentHistory(page.pageId, current);
    if (history === null) {
      warnings.push(warn('file-history-partial', `${current.title}: earlier versions could not be read`));
    }
    let kept = 0;
    let missed = 0;
    const earlier = history ?? [];
    const base = position;
    position += earlier.length + 1;
    // The current version first: it is the file, and its bytes are what an
    // earlier version must not turn out to be. Positions keep the history in
    // the order it happened whatever the order it was read in.
    let currentSha: string | null = null;
    const ordered = [
      { version: current, at: base + earlier.length },
      ...earlier.map((version, index) => ({ version, at: base + index })),
    ];
    for (const { version, at } of ordered) {
      if (versions >= budget) {
        warnings.push(warn('file-skipped', `${current.title}: more than ${MAX_IMPORTED_FILE_VERSIONS} file versions in one import`));
        return { files, versions, warnings };
      }
      const isCurrent = version === current;
      if (!isCurrent && currentSha === null) break;
      if (version.fileSize !== null && version.fileSize > sink.maxFileBytes) {
        if (isCurrent) warnings.push(warn('file-skipped', `${current.title}: larger than this instance takes`));
        else missed += 1;
        continue;
      }
      const opened = await client.openAttachment(version);
      if ('failed' in opened) {
        if (isCurrent) warnings.push(warn('file-skipped', `${current.title}: ${opened.failed}`));
        else missed += 1;
        continue;
      }
      const stored = await sink.store(
        {
          sourceId: page.node.sourceId,
          name: current.title,
          position: at,
          mediaType: version.mediaType,
          // Only an earlier version is held to its recorded size: that is how a
          // site answering every `?version=` with the latest is caught. The
          // current version is what the site serves — some record a size for
          // it that its own download does not match. An earlier version with no
          // recorded size is held to not being the current bytes instead.
          expectedBytes: isCurrent ? null : version.fileSize,
          rejectSha256: isCurrent || version.fileSize !== null ? null : currentSha,
          note: version.comment,
          sourceVersion: version.version,
          author: version.author,
          createdAt: version.createdAt,
        },
        opened.body,
      );
      if ('refused' in stored) {
        if (isCurrent) warnings.push(warn('file-skipped', `${current.title}: ${stored.refused}`));
        else missed += 1;
        continue;
      }
      if (isCurrent) currentSha = stored.sha256;
      kept += 1;
      versions += 1;
    }
    if (kept > 0) files += 1;
    if (missed > 0) {
      warnings.push(
        warn('file-history-partial', `${current.title}: ${missed} earlier version(s) were not served as recorded`),
      );
    }
  }
  return { files, versions, warnings };
}

function reasonOf(error: unknown): string {
  return error instanceof ImportError ? error.message : 'the request failed';
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
