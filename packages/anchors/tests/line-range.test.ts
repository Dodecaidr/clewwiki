import { describe, expect, it } from 'vitest';

import { buildFileIndex, lineRangeAnchor, resolveAnchor } from '../src/index';
import type { AnchorTarget, FileIndex } from '../src/index';

/**
 * The fallback path, for blocks the parser has no declaration for.
 *
 * It is the weaker half of the mechanism on purpose, and these tests say
 * exactly how weak: re-indentation is absorbed, a content change is caught,
 * and an edit that shortens the file past the anchored range is reported as
 * `lost` rather than silently re-pointed at whatever is now on those lines.
 */

const FILE = 'config/service.yml';

const ORIGINAL = `service:
  name: rates
  retries: 3
  timeout: 30

logging:
  level: info
`;

function fallbackAnchor(hash: string, start: number, end: number): AnchorTarget {
  return {
    language: 'typescript',
    kind: 'lines',
    qualifiedName: `${FILE}:${start}-${end}`,
    container: null,
    fileHint: FILE,
    tokenHash: hash,
    bodyHash: null,
    bodyTokenCount: 0,
    fallback: true,
    lineStart: start,
    lineEnd: end,
  };
}

function indexOf(source: string): FileIndex {
  return buildFileIndex([{ path: FILE, source, declarations: [] }]);
}

describe('line range fallback', () => {
  it('hashes a range and refuses one outside the file', () => {
    const anchor = lineRangeAnchor(ORIGINAL, 1, 4);
    expect(anchor).not.toBeNull();
    expect(anchor?.lineCount).toBe(4);
    expect(lineRangeAnchor(ORIGINAL, 1, 400)).toBeNull();
    expect(lineRangeAnchor(ORIGINAL, 0, 2)).toBeNull();
    expect(lineRangeAnchor(ORIGINAL, 4, 2)).toBeNull();
  });

  it('is fresh when only the indentation changed', () => {
    const base = lineRangeAnchor(ORIGINAL, 1, 4);
    const anchor = fallbackAnchor(base?.hash ?? '', 1, 4);

    const reindented = `service:
      name: rates
      retries: 3
      timeout: 30

logging:
  level: info
`;
    expect(resolveAnchor(anchor, indexOf(reindented))).toMatchObject({
      state: 'fresh',
      detail: { reason: 'identity_matched' },
    });
  });

  it('is stale when a value inside the range changed', () => {
    const base = lineRangeAnchor(ORIGINAL, 1, 4);
    const anchor = fallbackAnchor(base?.hash ?? '', 1, 4);

    const edited = ORIGINAL.replace('retries: 3', 'retries: 5');
    expect(resolveAnchor(anchor, indexOf(edited))).toMatchObject({
      state: 'stale',
      detail: { reason: 'range_changed' },
    });
  });

  it('is lost when the file no longer reaches the anchored lines', () => {
    const base = lineRangeAnchor(ORIGINAL, 6, 7);
    const anchor = fallbackAnchor(base?.hash ?? '', 6, 7);

    expect(resolveAnchor(anchor, indexOf('service:\n  name: rates\n'))).toMatchObject({
      state: 'lost',
      detail: { reason: 'range_missing' },
    });
  });

  it('is lost when the file is gone', () => {
    const base = lineRangeAnchor(ORIGINAL, 1, 4);
    const anchor = fallbackAnchor(base?.hash ?? '', 1, 4);

    const index = buildFileIndex([{ path: 'config/other.yml', source: '', declarations: [] }]);
    expect(resolveAnchor(anchor, index)).toMatchObject({
      state: 'lost',
      detail: { reason: 'file_missing' },
    });
  });
});
