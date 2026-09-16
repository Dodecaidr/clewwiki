import { MIN_BODY_TOKENS } from './declarations';
import { lineRangeAnchor } from './line-range';
import type { AnchorDetail, AnchorResolution, AnchorTarget, Declaration } from './types';

/**
 * Resolving an anchor against a revision of the repository.
 *
 * The ladder below is the whole mechanism, and its order is what separates a
 * refactor from a documentation problem:
 *
 * 1. the same file, the same `{kind, qualified_name}` — the ordinary case;
 * 2. another file, the same identity — the declaration *moved*;
 * 3. the same container, the same body under a different name — *renamed*;
 * 4. anywhere at all, the same body — *moved and renamed*;
 * 5. nothing — *lost*, which is a decision for a person, not an edit.
 *
 * Stages 3 and 4 match on the body hash rather than on the full token hash:
 * the full hash covers the declaration's name, so a rename changes it by
 * definition and could never be the thing that recovers the rename. The body
 * hash is only trusted above `MIN_BODY_TOKENS` tokens, because short bodies
 * collide and a confident wrong answer is worse than `lost`.
 */

export interface IndexedFile {
  path: string;
  declarations: readonly Declaration[];
  /** Needed only by line-range anchors; declaration anchors never read it. */
  source?: string;
}

export interface FileIndex {
  /** Declarations by file path, in the order they appear in the file. */
  byFile: ReadonlyMap<string, readonly Declaration[]>;
  /** Every declaration in the revision, keyed `kind|qualifiedName`. */
  byIdentity: ReadonlyMap<string, readonly IndexedDeclaration[]>;
  /** Every declaration with a body long enough to match on, keyed by body hash. */
  byBodyHash: ReadonlyMap<string, readonly IndexedDeclaration[]>;
  sources: ReadonlyMap<string, string>;
}

export interface IndexedDeclaration {
  file: string;
  declaration: Declaration;
}

function identityKey(kind: string, qualifiedName: string): string {
  return `${kind}|${qualifiedName}`;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Builds the lookup tables one `check` pass needs, in a single walk. */
export function buildFileIndex(files: Iterable<IndexedFile>): FileIndex {
  const byFile = new Map<string, readonly Declaration[]>();
  const byIdentity = new Map<string, IndexedDeclaration[]>();
  const byBodyHash = new Map<string, IndexedDeclaration[]>();
  const sources = new Map<string, string>();

  for (const file of files) {
    byFile.set(file.path, file.declarations);
    if (file.source !== undefined) sources.set(file.path, file.source);

    for (const declaration of file.declarations) {
      const entry: IndexedDeclaration = { file: file.path, declaration };
      push(byIdentity, identityKey(declaration.kind, declaration.qualifiedName), entry);
      if (declaration.bodyHash !== null && declaration.bodyTokenCount >= MIN_BODY_TOKENS) {
        push(byBodyHash, declaration.bodyHash, entry);
      }
    }
  }

  return { byFile, byIdentity, byBodyHash, sources };
}

function located(entry: IndexedDeclaration): Pick<AnchorDetail, 'file' | 'line_start' | 'line_end'> {
  return {
    file: entry.file,
    line_start: entry.declaration.startLine,
    line_end: entry.declaration.endLine,
  };
}

/**
 * Resolves a line-range anchor: the file still has those lines and they still
 * normalise to the same hash, or it does not.
 */
function resolveLineRange(anchor: AnchorTarget, index: FileIndex): AnchorResolution {
  const source = index.sources.get(anchor.fileHint);
  if (source === undefined) {
    return { state: 'lost', detail: { reason: 'file_missing', file: anchor.fileHint } };
  }
  if (anchor.lineStart === null || anchor.lineEnd === null) {
    return { state: 'lost', detail: { reason: 'range_missing', file: anchor.fileHint } };
  }

  const current = lineRangeAnchor(source, anchor.lineStart, anchor.lineEnd);
  if (current === null) {
    return {
      state: 'lost',
      detail: {
        reason: 'range_missing',
        file: anchor.fileHint,
        line_start: anchor.lineStart,
        line_end: anchor.lineEnd,
      },
    };
  }

  const detail: AnchorDetail = {
    reason: current.hash === anchor.tokenHash ? 'identity_matched' : 'range_changed',
    file: anchor.fileHint,
    line_start: current.lineStart,
    line_end: current.lineEnd,
    expected_hash: anchor.tokenHash,
    actual_hash: current.hash,
  };
  return { state: current.hash === anchor.tokenHash ? 'fresh' : 'stale', detail };
}

/**
 * The ladder. `state` is what the reader sees; `detail` is what they act on.
 */
export function resolveAnchor(anchor: AnchorTarget, index: FileIndex): AnchorResolution {
  if (anchor.fallback) return resolveLineRange(anchor, index);

  const key = identityKey(anchor.kind, anchor.qualifiedName);
  const candidates = index.byIdentity.get(key) ?? [];

  // (1) Same file, same identity — the overwhelmingly common case.
  const sameFile = candidates.find((entry) => entry.file === anchor.fileHint);
  if (sameFile) {
    const fresh = sameFile.declaration.tokenHash === anchor.tokenHash;
    return {
      state: fresh ? 'fresh' : 'stale',
      detail: {
        reason: fresh ? 'identity_matched' : 'body_changed',
        ...located(sameFile),
        expected_hash: anchor.tokenHash,
        actual_hash: sameFile.declaration.tokenHash,
      },
    };
  }

  // (2) Another file, same identity — a move, not a staleness event. The body
  // may also have changed; that is reported alongside rather than instead,
  // because the reader has to re-anchor either way.
  const elsewhere = candidates[0];
  if (elsewhere) {
    return {
      state: 'moved-renamed',
      detail: {
        reason: 'moved',
        ...located(elsewhere),
        moved_to: elsewhere.file,
        body_changed: elsewhere.declaration.tokenHash !== anchor.tokenHash,
        expected_hash: anchor.tokenHash,
        actual_hash: elsewhere.declaration.tokenHash,
      },
    };
  }

  const matchable =
    anchor.bodyHash !== null && anchor.bodyTokenCount >= MIN_BODY_TOKENS ? anchor.bodyHash : null;

  if (matchable !== null) {
    const byBody = index.byBodyHash.get(matchable) ?? [];

    // (3) Same container, same body, different name — a plain rename.
    const renamed = byBody.find(
      (entry) =>
        entry.declaration.kind === anchor.kind && entry.declaration.container === anchor.container,
    );
    if (renamed) {
      return {
        state: 'moved-renamed',
        detail: {
          reason: 'renamed',
          ...located(renamed),
          renamed_to: renamed.declaration.qualifiedName,
          ...(renamed.file === anchor.fileHint ? {} : { moved_to: renamed.file }),
        },
      };
    }

    // (4) The same body anywhere in the revision — renamed and moved at once,
    // or lifted into a different container.
    const anywhere = byBody.find((entry) => entry.declaration.kind === anchor.kind) ?? byBody[0];
    if (anywhere) {
      return {
        state: 'moved-renamed',
        detail: {
          reason: 'moved_and_renamed',
          ...located(anywhere),
          moved_to: anywhere.file,
          renamed_to: anywhere.declaration.qualifiedName,
        },
      };
    }
  }

  // (5) Nothing resolvable. The page needs a decision, not a re-read.
  return {
    state: 'lost',
    detail: {
      reason: index.byFile.has(anchor.fileHint) ? 'declaration_missing' : 'file_missing',
      file: anchor.fileHint,
    },
  };
}
