import { describe, expect, it } from 'vitest';

import { resolveAnchor } from '../src/index';
import { anchorFor, declarationsOf, find, indexFiles } from './helpers';

/**
 * The Swift half of the mechanism, on fixtures small enough to read.
 *
 * Every case here is one of the five outcomes the product promises a reader:
 * a formatter run is silence, a body edit is `stale`, a rename or a move is
 * `moved-renamed`, and a deletion is `lost`.
 */

const FILE = 'Sources/Audio/Mixer.swift';

const ORIGINAL = `import Foundation

/// Mixes the input channels.
struct Mixer {
    let channels: Int

    func blend(first: Double, second: Double) -> Double {
        let total = first + second
        return total / Double(channels)
    }
}

enum Mode {
    case stereo
    case mono
}
`;

describe('swift declaration extraction', () => {
  it('finds containers and their members with qualified names', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const names = declarations.map((entry) => `${entry.kind} ${entry.qualifiedName}`);

    expect(names).toContain('struct Mixer');
    expect(names).toContain('let Mixer.channels');
    expect(names).toContain('func Mixer.blend(first:second:)');
    expect(names).toContain('enum Mode');

    const blend = find(declarations, 'Mixer.blend(first:second:)');
    expect(blend.container).toBe('Mixer');
    expect(blend.startLine).toBeGreaterThan(1);
    expect(blend.endLine).toBeGreaterThanOrEqual(blend.startLine);
  });

  it('keeps argument labels in a function identity', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    expect(
      declarations.some((entry) => entry.qualifiedName === 'Mixer.blend(first:second:)'),
    ).toBe(true);
  });
});

describe('swift anchor resolution', () => {
  it('stays fresh through a formatting-only change', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'Mixer.blend(first:second:)'), 'swift');

    const reformatted = `import Foundation

/// Mixes the input channels. Rewritten comment, same code.
struct Mixer {
    let channels: Int

    func blend(
        first: Double,
        second: Double
    ) -> Double {
        // a new comment nobody should be told about
        let total = first + second

        return total / Double(channels)
    }
}

enum Mode {
    case stereo
    case mono
}
`;

    const index = await indexFiles({ [FILE]: reformatted });
    expect(resolveAnchor(anchor, index)).toMatchObject({
      state: 'fresh',
      detail: { reason: 'identity_matched' },
    });
  });

  it('flags a body change as stale', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'Mixer.blend(first:second:)'), 'swift');

    const edited = ORIGINAL.replace(
      'return total / Double(channels)',
      'return total / Double(max(channels, 1))',
    );
    const index = await indexFiles({ [FILE]: edited });

    const resolution = resolveAnchor(anchor, index);
    expect(resolution.state).toBe('stale');
    expect(resolution.detail.reason).toBe('body_changed');
    expect(resolution.detail.actual_hash).not.toBe(anchor.tokenHash);
  });

  it('reports a rename as moved-renamed', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'Mixer.blend(first:second:)'), 'swift');

    const renamed = ORIGINAL.replace('func blend(', 'func combine(');
    const index = await indexFiles({ [FILE]: renamed });

    const resolution = resolveAnchor(anchor, index);
    expect(resolution.state).toBe('moved-renamed');
    expect(resolution.detail.reason).toBe('renamed');
    expect(resolution.detail.renamed_to).toBe('Mixer.combine(first:second:)');
  });

  it('reports a move to another file as moved-renamed', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'Mixer.blend(first:second:)'), 'swift');

    const moved = 'Sources/Audio/Blending.swift';
    const index = await indexFiles({
      [FILE]: 'import Foundation\n\nenum Mode {\n    case stereo\n}\n',
      [moved]: ORIGINAL,
    });

    const resolution = resolveAnchor(anchor, index);
    expect(resolution.state).toBe('moved-renamed');
    expect(resolution.detail.reason).toBe('moved');
    expect(resolution.detail.moved_to).toBe(moved);
    expect(resolution.detail.body_changed).toBe(false);
  });

  it('reports a deletion as lost', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'Mixer.blend(first:second:)'), 'swift');

    const index = await indexFiles({
      [FILE]: 'import Foundation\n\nstruct Mixer {\n    let channels: Int\n}\n',
    });

    const resolution = resolveAnchor(anchor, index);
    expect(resolution.state).toBe('lost');
    expect(resolution.detail.reason).toBe('declaration_missing');
  });

  it('reports a deleted file as lost', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'Mixer'), 'swift');

    const index = await indexFiles({ 'Sources/Audio/Other.swift': 'struct Other {}\n' });
    expect(resolveAnchor(anchor, index)).toMatchObject({
      state: 'lost',
      detail: { reason: 'file_missing' },
    });
  });

  it('marks a container stale when one of its members changes', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'Mixer'), 'swift');

    const edited = ORIGINAL.replace('let total = first + second', 'let total = first - second');
    const index = await indexFiles({ [FILE]: edited });

    expect(resolveAnchor(anchor, index).state).toBe('stale');
  });
});
