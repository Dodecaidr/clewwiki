/**
 * The vocabulary of the anchoring library.
 *
 * An anchor ties a documentation section to a declaration in a source
 * repository. Its identity is the declaration — `{kind, qualified_name}` — and
 * not its location: `fileHint` only tells the resolver where to look first, so
 * a declaration that moved to another file is still the same anchor.
 */

/** Languages with a declaration table and a grammar shipped as WebAssembly. */
export const ANCHOR_LANGUAGES = ['swift', 'typescript', 'tsx', 'kotlin'] as const;

export type AnchorLanguage = (typeof ANCHOR_LANGUAGES)[number];

export function isAnchorLanguage(value: string): value is AnchorLanguage {
  return (ANCHOR_LANGUAGES as readonly string[]).includes(value);
}

/**
 * One declaration found in one file.
 *
 * `tokenHash` covers the declaration's whole token sequence, including its
 * name; `bodyHash` covers only the tokens inside its body block. The pair is
 * what separates "the body changed" from "the same body under a new name".
 */
export interface Declaration {
  /** Grammar-specific declaration kind: `func`, `class`, `interface`, … */
  kind: string;
  /** `Container.member`, or just the name at the top level of a file. */
  qualifiedName: string;
  /** The enclosing declaration's qualified name, or null at the top level. */
  container: string | null;
  /** 1-based, inclusive. Display metadata — never the staleness signal. */
  startLine: number;
  endLine: number;
  tokenHash: string;
  bodyHash: string | null;
  /** How many tokens `bodyHash` covers; a short body is not worth matching. */
  bodyTokenCount: number;
}

/**
 * The four states `docs/architecture.md` names. There is deliberately no
 * single "stale" flag: a body change, a rename and a disappearance each need a
 * different response from the reader, and collapsing them is what makes a
 * staleness badge stop being believed.
 */
export type AnchorState = 'fresh' | 'stale' | 'moved-renamed' | 'lost';

/** Why an anchor ended up in the state it did, for the reader and the API. */
export interface AnchorDetail {
  reason:
    | 'identity_matched'
    | 'body_changed'
    | 'moved'
    | 'renamed'
    | 'moved_and_renamed'
    | 'file_missing'
    | 'declaration_missing'
    | 'range_missing'
    | 'range_changed';
  /** Where the declaration was found, when it was found. */
  file?: string;
  moved_to?: string;
  renamed_to?: string;
  line_start?: number;
  line_end?: number;
  expected_hash?: string;
  actual_hash?: string;
  /** True for a `moved-renamed` whose body also changed. */
  body_changed?: boolean;
}

export interface AnchorResolution {
  state: AnchorState;
  detail: AnchorDetail;
}

/**
 * The stored half of an anchor, as the resolver needs it.
 *
 * A `fallback` anchor carries no declaration identity: `tokenHash` is then the
 * hash of its normalised line range, and only `fileHint`, `lineStart` and
 * `lineEnd` are meaningful.
 */
export interface AnchorTarget {
  /** Null for a fallback anchor on a file no grammar covers. */
  language: AnchorLanguage | null;
  kind: string;
  qualifiedName: string;
  container: string | null;
  fileHint: string;
  tokenHash: string;
  bodyHash: string | null;
  bodyTokenCount: number;
  fallback: boolean;
  lineStart: number | null;
  lineEnd: number | null;
}
