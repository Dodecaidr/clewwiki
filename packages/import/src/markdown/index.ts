/**
 * The Markdown folder source.
 *
 * A ZIP of `.md` and `.mdx` files, which is what a docs directory looks like
 * once it leaves a repository. The directory structure becomes the page tree,
 * `README.md` and `index.md` become the page for the directory they sit in, and
 * front matter `title` wins over the file name, because that is the title the
 * document was published under.
 *
 * Nothing but text is carried across. Images referenced by a relative path stay
 * relative and get a warning: there is no attachment store to put the file in,
 * and a broken image a reviewer was told about is better than one they were not.
 */

import { ImportError } from '../limits';
import type { ImportLimits } from '../limits';
import { truncateToBytes, utf8Length } from '../limits';
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
  const entries = readZip(input.zip, { limits: input.limits });
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

  const warnings: ImportWarning[] = [];
  const skipped = entries.length - documents.length;
  if (skipped > 0) warnings.push(warn('unresolved-image', `${skipped} non-Markdown files`));

  const pages: DocumentPage[] = documents.map((entry, index) => {
    const path = paths[index] ?? entry.name;
    const raw = entryText(entry);
    const front = splitFrontMatter(raw);
    const lead = front.title === null ? takeLeadingHeading(front.body) : { title: null, body: front.body };
    const rewritten = rewriteRelativeLinks(lead.body, path, (target) => {
      const key = keyForDocument(target);
      return known.has(key) ? key : null;
    });

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

  return {
    source: 'markdown',
    nodes: tree.nodes,
    warnings,
    params: { file_count: documents.length, root: prefix.replace(/\/$/, '') },
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
