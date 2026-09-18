import { describe, expect, it } from 'vitest';

import { generateSegment } from '@clewwiki/content/slug';

import { hasPlaceholders, placeholderFor, rewriteLinks, slugifyFragment } from '../src/links';
import { orderForPlacement, placeNodes } from '../src/tree';
import { truncateToBytes, utf8Length } from '../src/limits';
import type { ImportNode } from '../src/types';

function node(
  sourceId: string,
  title: string,
  parentSourceId: string | null = null,
  ordering = 0,
): ImportNode {
  return {
    sourceId,
    parentSourceId,
    title,
    kind: 'human',
    markdown: '',
    warnings: [],
    ordering,
  };
}

describe('placement', () => {
  it('uses the application slug generator, transliteration included', () => {
    const placed = placeNodes([node('1', 'Архитектура бэкенда')]);
    expect(placed.nodes[0]?.targetPath).toBe(`/${generateSegment('Архитектура бэкенда')}`);
    expect(placed.nodes[0]?.targetPath).toBe('/arkhitektura-bekenda');
  });

  it('places a parent before its children and nests the paths', () => {
    const placed = placeNodes([
      node('c', 'Runbook', 'b', 0),
      node('a', 'Platform', null, 0),
      node('b', 'Deployment', 'a', 0),
    ]);
    expect(placed.nodes.map((entry) => entry.targetPath)).toEqual([
      '/platform',
      '/platform/deployment',
      '/platform/deployment/runbook',
    ]);
  });

  it('keeps sibling order from the source', () => {
    const placed = placeNodes([
      node('b', 'Beta', null, 2),
      node('a', 'Alpha', null, 1),
      node('c', 'Gamma', null, 3),
    ]);
    expect(placed.nodes.map((entry) => entry.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('numbers a second page that wants the same segment and says so', () => {
    const placed = placeNodes([node('a', 'Overview', null, 1), node('b', 'Overview', null, 2)]);
    expect(placed.nodes.map((entry) => entry.targetPath)).toEqual(['/overview', '/overview-2']);
    expect(placed.nodes[1]?.warnings).toContainEqual({ code: 'path-adjusted', detail: '/overview-2' });
  });

  it('avoids paths the space already has', () => {
    const placed = placeNodes([node('a', 'Overview')], { taken: ['/overview'] });
    expect(placed.nodes[0]?.targetPath).toBe('/overview-2');
  });

  it('places everything under a root path when one is given', () => {
    const placed = placeNodes([node('a', 'Platform'), node('b', 'Deploy', 'a')], {
      rootPath: '/imported',
    });
    expect(placed.nodes.map((entry) => entry.targetPath)).toEqual([
      '/imported/platform',
      '/imported/platform/deploy',
    ]);
  });

  it('treats a node whose parent is missing as a root', () => {
    const placed = placeNodes([node('a', 'Orphan', 'gone')]);
    expect(placed.nodes[0]?.targetPath).toBe('/orphan');
  });

  it('keeps a node caught in a cycle its source invented', () => {
    const ordered = orderForPlacement([node('a', 'A', 'b'), node('b', 'B', 'a')]);
    expect(ordered).toHaveLength(2);
  });

  it('is deterministic: the same export places the same way twice', () => {
    const nodes = [node('b', 'Beta', null, 1), node('a', 'Alpha', null, 1), node('c', 'Alpha', null, 1)];
    const first = placeNodes(nodes).nodes.map((entry) => entry.targetPath);
    const second = placeNodes(nodes).nodes.map((entry) => entry.targetPath);
    expect(first).toEqual(second);
  });
});

describe('link rewriting', () => {
  it('resolves a placeholder to whatever the resolver says', () => {
    const markdown = `See [the runbook](${placeholderFor('222')}).`;
    expect(rewriteLinks(markdown, () => '/ops/runbook').markdown).toBe(
      'See [the runbook](/ops/runbook).',
    );
  });

  it('keeps a fragment, slugified the way a heading anchor is', () => {
    const markdown = `[step two](${placeholderFor('222', 'Step Two')})`;
    expect(rewriteLinks(markdown, () => '/ops/runbook').markdown).toBe('[step two](/ops/runbook#step-two)');
  });

  it('flattens an unresolved link to its own text and warns once', () => {
    const markdown = `[a](${placeholderFor('x')}) and [b](${placeholderFor('x')})`;
    const result = rewriteLinks(markdown, () => null);
    expect(result.markdown).toBe('a and b');
    expect(result.warnings).toEqual([{ code: 'unresolved-link', detail: 'x' }]);
  });

  it('keeps an image an image when it resolves', () => {
    const markdown = `![alt](${placeholderFor('222')})`;
    expect(rewriteLinks(markdown, () => '/x').markdown).toBe('![alt](/x)');
  });

  it('leaves an ordinary link alone', () => {
    const markdown = '[docs](https://example.com/a)';
    expect(rewriteLinks(markdown, () => '/x').markdown).toBe(markdown);
  });

  it('reports whether a body still has placeholders in it', () => {
    expect(hasPlaceholders(`[a](${placeholderFor('1')})`)).toBe(true);
    expect(hasPlaceholders('[a](/b)')).toBe(false);
  });

  it('slugifies a fragment the way the renderer anchors a heading', () => {
    expect(slugifyFragment('Step 2: restart')).toBe('step-2-restart');
    expect(slugifyFragment('Перезапуск')).toBe('перезапуск');
  });
});

describe('limits', () => {
  it('measures in bytes of UTF-8, not characters', () => {
    expect(utf8Length('привет')).toBe(12);
  });

  it('truncates on a character boundary', () => {
    const value = 'привет мир';
    const cut = truncateToBytes(value, 7);
    expect(utf8Length(cut)).toBeLessThanOrEqual(7);
    expect(cut).toBe('при');
  });
});
