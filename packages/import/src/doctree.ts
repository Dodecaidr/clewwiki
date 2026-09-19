/**
 * Turning a folder of documents into a page tree.
 *
 * Two of the four sources arrive as a directory structure — a Notion export and
 * a folder of Markdown — and the rule for reading one is the same in both
 * cases, so it lives here once.
 *
 * The rule: every document becomes a page, and the directories become the
 * pages above them. A directory that has a document of its own — `README.md`,
 * `index.md`, or the file a Notion export writes beside a folder of the same
 * name — becomes that document's page, with the directory's contents below it.
 * A directory with no document of its own becomes a section page with an empty
 * body, so the tree has somewhere to hang its children rather than flattening
 * them.
 *
 * Link rewriting happens against the same keys. A relative link is resolved
 * from the linking document's directory, looked up as a node, and written as
 * the placeholder `../links` resolves later — so a link between two imported
 * pages survives whatever the reviewer does to the target paths afterwards.
 */

import { imagePlaceholderFor } from './images';
import { placeholderFor } from './links';
import { escapeInline } from './markdown-out';
import { warn } from './types';
import type { ImportNode, ImportWarning } from './types';

export interface SourceDocument {
  /** Forward-slash path inside the archive. */
  path: string;
  text: string;
  modifiedAt?: Date | null;
}

export interface DocumentPage {
  /** The node key: the path without its extension, or the directory it indexes. */
  key: string;
  title: string;
  markdown: string;
  warnings: ImportWarning[];
  /** The document this page came from, for relative-link resolution. */
  sourcePath: string | null;
  modifiedAt?: Date | null;
  ordering: number;
}

/** File names that make a document the page for its directory. */
export const INDEX_BASENAMES = new Set(['readme', 'index', '_index']);

/** `a/b/c.md` → `a/b`. `c.md` → `''`. */
export function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/** `a/b/c.md` → `c`. */
export function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/** `a/b/c.md` → `md`, lowercased; `''` when there is none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The node key a document occupies: its own path, or the directory it indexes. */
export function keyForDocument(path: string): string {
  const base = basenameOf(path);
  const directory = directoryOf(path);
  if (INDEX_BASENAMES.has(base.toLowerCase()) && directory !== '') return directory;
  return directory === '' ? base : `${directory}/${base}`;
}

/** Every ancestor directory of a key, nearest first. */
function ancestorsOf(key: string): string[] {
  const parts = key.split('/');
  const out: string[] = [];
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    out.push(parts.slice(0, depth).join('/'));
  }
  return out;
}

export interface BuildTreeOptions {
  /** The name a synthetic section page gets, from its directory name. */
  sectionTitle: (directoryName: string) => string;
  /**
   * The import root inside the archive, stripped from every key before the
   * tree is built. A Notion export is one folder deep; a Markdown archive
   * usually is too.
   */
  stripPrefix?: string;
}

export interface DocumentTree {
  nodes: ImportNode[];
  /** Node key to source id, so a caller can resolve its own links. */
  keys: Map<string, string>;
}

/**
 * Builds the tree, filling in the section pages a document set implies and
 * rewriting the relative links between its documents.
 */
export function buildDocumentTree(pages: DocumentPage[], options: BuildTreeOptions): DocumentTree {
  const byKey = new Map<string, DocumentPage>();
  for (const page of pages) {
    // A duplicate key means two files claim the same page — `README.md` and
    // `index.md` in one directory. The first in the source order wins, and the
    // second becomes a page of its own under its own name.
    if (byKey.has(page.key)) {
      byKey.set(`${page.key}~${byKey.size}`, { ...page, key: `${page.key}~${byKey.size}` });
    } else {
      byKey.set(page.key, page);
    }
  }

  // Fill in the directories nothing claimed, so a nested document keeps its
  // place instead of being lifted to the root.
  for (const key of [...byKey.keys()]) {
    for (const ancestor of ancestorsOf(key)) {
      if (byKey.has(ancestor)) break;
      byKey.set(ancestor, {
        key: ancestor,
        title: options.sectionTitle(ancestor.slice(ancestor.lastIndexOf('/') + 1)),
        markdown: '',
        warnings: [],
        sourcePath: null,
        ordering: 0,
      });
    }
  }

  const ordered = [...byKey.values()].sort(
    (a, b) => a.ordering - b.ordering || a.key.localeCompare(b.key),
  );

  const keys = new Map<string, string>();
  for (const page of ordered) keys.set(page.key, page.key);

  const nodes: ImportNode[] = ordered.map((page, index) => {
    const parent = ancestorsOf(page.key).find((ancestor) => byKey.has(ancestor)) ?? null;
    return {
      sourceId: page.key,
      parentSourceId: parent,
      title: page.title,
      kind: 'human',
      markdown: page.markdown,
      ...(page.modifiedAt ? { updatedAt: page.modifiedAt } : {}),
      warnings: page.warnings,
      ordering: index,
    };
  });

  return { nodes, keys };
}

/**
 * Rewrites the relative links of one document.
 *
 * A link to another document of the same import becomes a placeholder, and so
 * does an image the caller can find in the archive. An image it cannot — not
 * there, or not a format the image store takes — becomes a warning, because a
 * relative path will not resolve once the page is in the wiki. An absolute link
 * is left exactly as it was.
 */
export function rewriteRelativeLinks(
  markdown: string,
  fromPath: string,
  /**
   * Turns a path resolved against the archive root into the source id of a
   * node, or null when nothing in the import is there. The caller does the
   * normalising, because a Notion path has to have its hash suffixes stripped
   * first and a plain Markdown path does not.
   */
  resolveTarget: (resolvedPath: string) => string | null,
  /**
   * Turns an image's path, as the document wrote it (decoded, still relative),
   * into the key of the asset that carries it, or null. It is given the path
   * unresolved because the caller knows where the document really sat in the
   * archive, which `fromPath` — already stripped of a wrapping folder and of
   * Notion's suffixes — no longer says.
   */
  resolveImage?: (relativePath: string) => string | null,
): { markdown: string; warnings: ImportWarning[] } {
  const warnings: ImportWarning[] = [];
  const seen = new Set<string>();
  const note = (code: ImportWarning['code'], detail: string): void => {
    const tag = `${code}:${detail}`;
    if (seen.has(tag)) return;
    seen.add(tag);
    warnings.push(warn(code, detail));
  };

  // Inline links and images. Reference-style links are rare in these exports
  // and are left alone rather than half-rewritten.
  // A destination may hold one level of balanced parentheses, as CommonMark
  // allows and as `Untitled (1).png` needs.
  const pattern = /(!?)\[([^\]]*)\]\(\s*<?((?:[^()<>\s]|\([^()\s]*\))+)>?(\s+"[^"]*")?\s*\)/g;

  const rewritten = markdown.replace(
    pattern,
    (match, bang: string, text: string, target: string, title: string | undefined) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#')) {
        return match;
      }
      const [rawPath = '', fragment] = splitFragment(target);
      const relative = decodeSafely(rawPath);
      const resolved = resolvePath(directoryOf(fromPath), relative);

      if (bang === '!' && relative !== '') {
        const asset = resolveImage?.(relative) ?? null;
        if (asset !== null) return `![${text}](${imagePlaceholderFor(asset)}${title ?? ''})`;
      }
      if (resolved === null) return match;

      if (bang === '!') {
        // Nothing importable is behind this path, so it stays as it was written
        // and the reviewer is told it will not load.
        note('unresolved-image', resolved);
        return `![${text}](${target}${title ?? ''})`;
      }

      const key = resolveTarget(resolved);
      if (key === null) {
        note('unresolved-link', resolved);
        return text === '' ? '' : escapeInline(text);
      }
      return `[${text}](${placeholderFor(key, fragment)})`;
    },
  );

  return { markdown: rewritten, warnings };
}

function splitFragment(target: string): [string, string | undefined] {
  const hash = target.indexOf('#');
  return hash === -1 ? [target, undefined] : [target.slice(0, hash), target.slice(hash + 1)];
}

function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolves `./x`, `../x` and `x` against a directory, refusing to escape the root. */
export function resolvePath(from: string, target: string): string | null {
  if (target === '') return null;
  const base = target.startsWith('/') ? [] : from.split('/').filter((part) => part !== '');
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(part);
  }
  return base.join('/');
}

/**
 * The `title` of a YAML front-matter block, and the body without it.
 *
 * Only `title` is read, and only as a scalar: front matter in an imported file
 * was written for somebody else's generator, and guessing at the rest of it
 * would put arbitrary strings into fields that mean something here.
 */
export function splitFrontMatter(text: string): { title: string | null; body: string } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { title: null, body: text };

  const body = text.slice(match[0].length);
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const field = /^title\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    const raw = (field[1] ?? '').trim();
    const unquoted = /^(['"])([\s\S]*)\1$/.exec(raw);
    const title = (unquoted?.[2] ?? raw).trim();
    return { title: title === '' ? null : title, body };
  }
  return { title: null, body };
}

/** The first ATX heading of a body, and the body with that heading removed. */
export function takeLeadingHeading(body: string): { title: string | null; body: string } {
  const match = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(body);
  if (!match?.[1]) return { title: null, body };
  return { title: match[1].trim(), body: body.slice(match[0].length) };
}
