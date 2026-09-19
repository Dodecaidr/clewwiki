/**
 * The Markdown folder source.
 *
 * A ZIP of `.md` and `.mdx` files, which is what a docs directory looks like
 * once it leaves a repository. The directory structure becomes the page tree,
 * `README.md` and `index.md` become the page for the directory they sit in, and
 * front matter `title` wins over the file name, because that is the title the
 * document was published under.
 *
 * Text is carried across, and the images the documents show: a PNG, JPEG, GIF
 * or WebP that a document refers to by a relative path comes along as an asset
 * (`../images`). An image that is not in the archive, or is some other format,
 * stays as it was written and gets a warning — a broken image a reviewer was
 * told about is better than one they were not.
 */

import { ImportError } from '../limits';
import type { ImportLimits } from '../limits';
import { truncateToBytes, utf8Length } from '../limits';
import { createImageCollector } from '../image-collector';
import { IMPORTABLE_IMAGE_EXTENSIONS } from '../images';
import { finishBody } from '../markdown-out';
import { warn } from '../types';
import type { ImportParseResult, ImportWarning } from '../types';
import {
  basenameOf,
  buildDocumentTree,
  extensionOf,
  keyForDocument,
  rewriteRelativeLinks,
  splitFrontMatter,
  takeLeadingHeading,
} from '../doctree';
import type { DocumentPage } from '../doctree';
import { entryText, readZip } from '../zip';

export const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

export interface MarkdownImportInput {
  zip: Uint8Array;
  limits: ImportLimits;
}

export function importFromMarkdownZip(input: MarkdownImportInput): ImportParseResult {
  // Documents and the pictures they might show are the only entries expanded:
  // whatever else the archive holds is counted and never read.
  let unread = 0;
  const entries = readZip(input.zip, {
    limits: input.limits,
    accept: (name) => {
      const extension = extensionOf(name);
      return MARKDOWN_EXTENSIONS.has(extension) || IMPORTABLE_IMAGE_EXTENSIONS.has(extension);
    },
    onRejected: (name) => {
      if (!isIgnored(name)) unread += 1;
    },
  });
  const documents = entries.filter(
    (entry) => MARKDOWN_EXTENSIONS.has(extensionOf(entry.name)) && !isIgnored(entry.name),
  );

  if (documents.length === 0) {
    throw new ImportError('validation', 'The archive holds no Markdown files');
  }
  if (documents.length > input.limits.pages) {
    throw new ImportError('validation', `The archive holds more than ${input.limits.pages} Markdown files`, {
      limit: input.limits.pages,
    });
  }

  const prefix = commonPrefix(documents.map((entry) => entry.name));
  const paths = documents.map((entry) => entry.name.slice(prefix.length));
  const known = new Set(paths.map((path) => keyForDocument(path)));

  const images = createImageCollector(entries.filter((entry) => !isIgnored(entry.name)));

  const pages: DocumentPage[] = documents.map((entry, index) => {
    const path = paths[index] ?? entry.name;
    const raw = entryText(entry);
    const front = splitFrontMatter(raw);
    const lead = front.title === null ? takeLeadingHeading(front.body) : { title: null, body: front.body };
    const rewritten = rewriteRelativeLinks(
      lead.body,
      path,
      (target) => {
        const key = keyForDocument(target);
        return known.has(key) ? key : null;
      },
      images.resolverFor(entry.name),
    );

    const pageWarnings = [...rewritten.warnings];
    if (extensionOf(path) === 'mdx' && /<[A-Z][\w.]*[\s/>]/.test(rewritten.markdown)) {
      // Components are not Markdown; the renderer drops raw HTML, so whatever
      // they rendered is not coming with them.
      pageWarnings.push(warn('html-dropped', path));
    }

    let markdown = finishBody(rewritten.markdown);
    if (utf8Length(markdown) > input.limits.pageBytes) {
      markdown = truncateToBytes(markdown, input.limits.pageBytes);
      pageWarnings.push(warn('truncated', path));
    }
    if (markdown.trim() === '') pageWarnings.push(warn('empty', path));

    return {
      key: keyForDocument(path),
      title: front.title ?? lead.title ?? titleFromName(basenameOf(path)),
      markdown,
      warnings: pageWarnings,
      sourcePath: path,
      modifiedAt: entry.modifiedAt,
      ordering: index,
    };
  });

  const tree = buildDocumentTree(pages, { sectionTitle: titleFromName });

  const warnings: ImportWarning[] = [];
  const skipped =
    unread + entries.filter((entry) => !isIgnored(entry.name)).length - documents.length - images.used;
  if (skipped > 0) warnings.push(warn('unresolved-image', `${skipped} files that are neither Markdown nor an image a page shows`));

  return {
    source: 'markdown',
    nodes: tree.nodes,
    assets: images.assets(),
    warnings,
    params: {
      file_count: documents.length,
      image_count: images.used,
      root: prefix.replace(/\/$/, ''),
    },
  };
}

/** Editor leftovers and archive metadata nobody wants as a page. */
function isIgnored(name: string): boolean {
  return name.split('/').some(
    (segment) =>
      segment === '__MACOSX' ||
      segment === '.git' ||
      segment === 'node_modules' ||
      segment.startsWith('._'),
  );
}

/**
 * The directory every file shares, so an archive that wraps its contents in one
 * folder does not import a page named after the folder.
 */
export function commonPrefix(names: readonly string[]): string {
  const first = names[0];
  if (first === undefined) return '';
  let prefix = first.slice(0, first.lastIndexOf('/') + 1);
  for (const name of names) {
    while (prefix !== '' && !name.startsWith(prefix)) {
      prefix = prefix.slice(0, prefix.lastIndexOf('/', prefix.length - 2) + 1);
    }
    if (prefix === '') break;
  }
  return prefix;
}

/** `getting-started` → `Getting started`: a file name read as a title. */
export function titleFromName(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (words === '') return 'Untitled';
  return words.charAt(0).toUpperCase() + words.slice(1);
}
