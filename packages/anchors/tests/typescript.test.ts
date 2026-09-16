import { describe, expect, it } from 'vitest';

import { resolveAnchor } from '../src/index';
import { anchorFor, declarationsOf, find, indexFiles } from './helpers';

/**
 * The same five outcomes in TypeScript. The pipeline above the grammar is
 * shared, so what these fixtures really exercise is the declaration table:
 * exported functions, class members, interfaces, and the arrow function bound
 * to a `const` that so much real TypeScript is made of.
 */

const FILE = 'src/lib/rates.ts';

const ORIGINAL = `import { load } from './io';

export interface Quote {
  readonly symbol: string;
  price(): number;
}

export class RateBook {
  private entries = new Map<string, number>();

  record(symbol: string, price: number): void {
    const rounded = Math.round(price * 100) / 100;
    this.entries.set(symbol, rounded);
  }

  lookup(symbol: string): number | undefined {
    return this.entries.get(symbol);
  }

  size(): number {
    return 0;
  }
}

export const normalise = (input: string): string => {
  const trimmed = input.trim();
  return trimmed.toUpperCase();
};

export function refresh(source: string): Promise<void> {
  return load(source).then(() => undefined);
}
`;

describe('typescript declaration extraction', () => {
  it('covers classes, members, interfaces and const bindings', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const names = declarations.map((entry) => `${entry.kind} ${entry.qualifiedName}`);

    expect(names).toContain('interface Quote');
    expect(names).toContain('class RateBook');
    expect(names).toContain('method RateBook.record');
    expect(names).toContain('method RateBook.lookup');
    expect(names).toContain('property RateBook.entries');
    expect(names).toContain('const normalise');
    expect(names).toContain('function refresh');
  });

  it('parses TSX with the same table', async () => {
    const declarations = await declarationsOf(
      'src/ui/badge.tsx',
      `export function Badge({ label }: { label: string }) {
  return <span className="badge">{label}</span>;
}
`,
    );
    expect(declarations.map((entry) => entry.qualifiedName)).toContain('Badge');
  });
});

describe('typescript anchor resolution', () => {
  it('stays fresh through a formatting-only change', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'RateBook.record'), 'typescript');

    const reformatted = `import { load } from './io';

export class RateBook {
      private entries = new Map<string, number>();

      record(
            symbol: string,
            price: number
      ): void {
            // rounding is deliberate; the pricing page explains why
            const rounded = Math.round(price * 100) / 100;

            this.entries.set(symbol, rounded);
      }
}
`;

    const index = await indexFiles({ [FILE]: reformatted });
    expect(resolveAnchor(anchor, index).state).toBe('fresh');
  });

  it('flags a body change as stale', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'RateBook.record'), 'typescript');

    const edited = ORIGINAL.replace('price * 100) / 100', 'price * 1000) / 1000');
    const index = await indexFiles({ [FILE]: edited });

    expect(resolveAnchor(anchor, index)).toMatchObject({
      state: 'stale',
      detail: { reason: 'body_changed' },
    });
  });

  it('reports a rename as moved-renamed', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'RateBook.record'), 'typescript');

    const renamed = ORIGINAL.replace('record(symbol: string', 'store(symbol: string');
    const index = await indexFiles({ [FILE]: renamed });

    const resolution = resolveAnchor(anchor, index);
    expect(resolution.state).toBe('moved-renamed');
    expect(resolution.detail.renamed_to).toBe('RateBook.store');
  });

  it('reports a move to another file as moved-renamed', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'normalise'), 'typescript');

    const moved = 'src/lib/text.ts';
    const index = await indexFiles({
      [FILE]: "import { load } from './io';\n\nexport function refresh(source: string): Promise<void> {\n  return load(source).then(() => undefined);\n}\n",
      [moved]: ORIGINAL,
    });

    expect(resolveAnchor(anchor, index)).toMatchObject({
      state: 'moved-renamed',
      detail: { reason: 'moved', moved_to: moved },
    });
  });

  it('reports a deletion as lost', async () => {
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'normalise'), 'typescript');

    const index = await indexFiles({
      [FILE]: "import { load } from './io';\n\nexport function refresh(source: string): Promise<void> {\n  return load(source).then(() => undefined);\n}\n",
    });

    expect(resolveAnchor(anchor, index)).toMatchObject({
      state: 'lost',
      detail: { reason: 'declaration_missing' },
    });
  });

  it('does not recover a short body under a new name', async () => {
    // `size` is one `return` long. Matching it by body hash would find any
    // other trivial accessor in the repository, so the anchor is honestly lost
    // rather than confidently wrong.
    const declarations = await declarationsOf(FILE, ORIGINAL);
    const anchor = anchorFor(FILE, find(declarations, 'RateBook.size'), 'typescript');
    expect(anchor.bodyTokenCount).toBeLessThan(8);

    const renamed = ORIGINAL.replace('size(): number', 'count(): number');
    const index = await indexFiles({ [FILE]: renamed });

    expect(resolveAnchor(anchor, index).state).toBe('lost');
  });
});
