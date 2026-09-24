/**
 * The shape every import source produces.
 *
 * An adapter's only job is to turn whatever it was handed — a Confluence
 * space, a Notion export, a folder of Markdown, a PDF — into a list of
 * `ImportNode`s and a list of warnings. Everything after that point is the same
 * code for all four sources: target paths are assigned, links are rewritten,
 * rows are staged, a person reviews them, and only then are pages written.
 *
 * Nothing in this package touches a database, the filesystem or Next.js. It is
 * a pure library over bytes and strings, which is what makes every converter
 * testable against a fixture and what keeps the untrusted-content rule easy to
 * state: content read here is data. It is never evaluated, never used to build
 * a query, and never read as an instruction.
 */

import type { ImportAsset } from './images';

/** The four sources an import can come from. */
export const IMPORT_SOURCES = ['confluence', 'notion', 'markdown', 'pdf'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/**
 * Why an item needs a human's eye.
 *
 * A warning is never a failure: the item is still staged, still shown in the
 * preview and still importable. It is the record of everything the converter
 * could not carry across faithfully, which is the difference between an import
 * a reviewer can trust and one that quietly loses content.
 */
export interface ImportWarning {
  /** Machine-readable reason, so the UI can translate it. */
  code: ImportWarningCode;
  /** English detail: a macro name, a file name, a link target. */
  detail?: string;
}

export const IMPORT_WARNING_CODES = [
  /** A Confluence macro with no Markdown equivalent; kept as a visible note. */
  'unsupported-macro',
  /** An image or attachment that stays where it is, because there is no upload. */
  'external-attachment',
  /** A relative image path with nothing importable behind it; it will not load. */
  'unresolved-image',
  /** An image that was in the archive and was not taken: too large, not an image, no room. */
  'image-skipped',
  /** A link that pointed at something outside the imported set. */
  'unresolved-link',
  /** A Notion toggle, turned into a details block. */
  'toggle-converted',
  /** A Notion database too large to inline; linked instead. */
  'database-too-large',
  /** A table the PDF reader could not reconstruct with confidence. */
  'low-confidence-table',
  /** A PDF whose structure was guessed rather than read. */
  'reconstructed',
  /** Raw HTML found in the source; dropped, because bodies are Markdown. */
  'html-dropped',
  /** The body was cut to the per-page limit. */
  'truncated',
  /** Content that arrived empty. */
  'empty',
  /** Two source items wanted the same path; the second was numbered. */
  'path-adjusted',
  /** An attachment, or one version of it, that was not carried across as a file. */
  'file-skipped',
  /** An attachment carried across without all of its earlier versions. */
  'file-history-partial',
] as const;

export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

export function warn(code: ImportWarningCode, detail?: string): ImportWarning {
  return detail === undefined ? { code } : { code, detail };
}

/**
 * One page-to-be.
 *
 * `sourceId` is the identity the source itself uses — a Confluence page id, a
 * path inside a ZIP, `pdf:3` — and it is what `parentSourceId` and the link
 * rewriter refer to. It never reaches a page: it exists so a second run over
 * the same export can be compared with the first.
 */
export interface ImportNode {
  sourceId: string;
  /** The parent's `sourceId`, or `null` for a top-level page. */
  parentSourceId: string | null;
  title: string;
  /**
   * Imported documentation is written by people for people, so it lands as a
   * `human` page. An agent-facing counterpart is written afterwards, by hand or
   * by an agent, and paired with it.
   */
  kind: 'human';
  markdown: string;
  /** Files the source referenced and this package did not bring across. */
  attachments?: ImportAttachment[];
  /** Where the page came from, for the preview and for the audit row. */
  sourceUrl?: string;
  updatedAt?: Date;
  warnings: ImportWarning[];
  /** Sibling order as the source presented it. */
  ordering: number;
}

export interface ImportAttachment {
  /** File name as the source called it. */
  name: string;
  /** Absolute URL it can still be fetched from, when there is one. */
  url?: string;
  mediaType?: string;
  bytes?: number;
}

/** What the source says about one version of a file, handed to a `FileSink`. */
export interface ImportFileVersion {
  /** The `sourceId` of the page the file is attached to. */
  sourceId: string;
  name: string;
  /** Order among all versions of all files of that page. */
  position: number;
  mediaType: string | null;
  /** What the source says this version weighs; a download of another size is refused. */
  expectedBytes: number | null;
  note: string | null;
  sourceVersion: number;
  author: string | null;
  createdAt: Date | null;
  /** The placeholder key a page body links to this file by, for a file from an archive. */
  sourceKey?: string;
  /**
   * Refuse this version if its bytes hash to this: an earlier version whose
   * size the source does not record is held to not being the current bytes,
   * which is what a site serves when it ignores `?version=`.
   */
  rejectSha256?: string | null;
}

/**
 * Where an adapter puts the files it carries across. The bytes are streamed
 * into it version by version and never pass through the adapter's memory; what
 * the sink keeps, and why it refuses what it refuses — too large, no room, a
 * name that cannot be one, a download that is not the version it claims — is
 * its own decision, reported back so it can become a warning.
 */
export interface FileSink {
  /** The largest file the sink takes, so an adapter can skip one without downloading it. */
  maxFileBytes: number;
  store(
    version: ImportFileVersion,
    body: ReadableStream<Uint8Array>,
  ): Promise<{ kept: true; sha256: string } | { refused: string }>;
}

/** What an adapter hands back. */
export interface ImportParseResult {
  source: ImportSource;
  nodes: ImportNode[];
  /**
   * The images the nodes refer to through `clewwiki-import-image:` placeholders
   * — see `./images`. Only images a document shows are here; the rest of an
   * archive's pictures are not read into the import at all.
   */
  assets?: ImportAsset[];
  /**
   * The files other than images the nodes link to through
   * `clewwiki-import-file:` placeholders, keyed by their path in the archive.
   * Carried as files of the pages that link to them, when the instance takes
   * files.
   */
  fileAssets?: ImportAsset[];
  /** Warnings about the import as a whole rather than about one page. */
  warnings: ImportWarning[];
  /** Recorded on the import row. Never carries a credential. */
  params: Record<string, string | number | boolean>;
}

/**
 * A node that has been given its place in the destination space.
 *
 * `targetPath` is absolute and normalised — the same form `pages.path` holds —
 * and it is what the preview shows and what a reviewer may edit before the
 * import is applied.
 */
export interface PlacedNode extends ImportNode {
  targetPath: string;
}
