/**
 * The Confluence source adapter.
 *
 * Reads one space of a Confluence Cloud site over the REST API v2 and turns it
 * into the tree the rest of the pipeline works on. The credential is passed in,
 * used for the length of this call, and never returned, stored or recorded: the
 * `params` the import row keeps carry the site address and the space key and
 * nothing else.
 *
 * Server and Data Center are untested. Their API is v1 and shaped differently
 * enough that this adapter would not merely need a different base path; saying
 * so is more honest than shipping a version check that pretends to cover them.
 */

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
  const client = new ConfluenceClient(input.credentials, input.client);
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

  const nodes = pages.map((page, index) =>
    toNode(page, index, {
      baseUrl: client.describe().base_url,
      pageIdByTitle,
      known,
      limits: input.limits,
    }),
  );

  return {
    source: 'confluence',
    nodes,
    warnings,
    // Everything recorded about the run. No e-mail, no token: the two things a
    // reader of the imports table must never be able to recover.
    params: {
      base_url: client.describe().base_url,
      space_key: input.spaceKey,
      space_name: space.name,
      page_count: pages.length,
    },
  };
}

interface NodeContext {
  baseUrl: string;
  pageIdByTitle: ReadonlyMap<string, string>;
  known: ReadonlySet<string>;
  limits: ImportLimits;
}

function toNode(page: ConfluencePage, index: number, context: NodeContext): ImportNode {
  const converted = convertStorageToMarkdown(page.storage, {
    baseUrl: context.baseUrl,
    pageId: page.id,
    pageIdByTitle: context.pageIdByTitle,
  });

  const warnings = [...converted.warnings];
  let markdown = converted.markdown;
  if (utf8Length(markdown) > context.limits.pageBytes) {
    markdown = truncateToBytes(markdown, context.limits.pageBytes);
    warnings.push(warn('truncated', page.title));
  }
  if (markdown.trim() === '') warnings.push(warn('empty'));

  return {
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
}
