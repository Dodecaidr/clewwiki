/**
 * Placing a parsed tree into a space.
 *
 * Every node gets the path the application would have given it: the segment
 * `@clewwiki/content/slug` generates from the title, joined onto its parent's
 * path, numbered with `withNumericSuffix` when a sibling already took it. The
 * generator is shared rather than reimplemented — a second implementation would
 * drift the first time one of them learned a transliteration rule, and an
 * import that puts a page somewhere other than where the form would have put it
 * is a bug nobody notices until the links break.
 *
 * Placement is deterministic: the same export placed twice produces the same
 * paths, in the same order, whatever a `Map` iteration order happens to be.
 */

import { joinPath, MAX_PATH_DEPTH, normalizePath, pathDepth } from '@clewwiki/content/paths';
import { generateSegment, withNumericSuffix } from '@clewwiki/content/slug';

import { warn } from './types';
import type { ImportNode, PlacedNode } from './types';

export interface PlaceOptions {
  /**
   * Path every imported page goes under, or null for the space root. Normalised
   * by the caller; a node placed deeper than the path limit allows is flattened
   * onto its nearest permitted ancestor rather than refused.
   */
  rootPath?: string | null;
  /** Paths already taken in the destination space, so an import never collides with itself. */
  taken?: Iterable<string>;
}

/**
 * Orders nodes so a parent is always placed before its children, and siblings
 * keep the order their source presented them in. A node whose parent is not in
 * the set — a Confluence page whose ancestor is restricted, a Notion subpage
 * exported without its parent — is treated as a root, which is the only way to
 * keep it rather than drop it.
 */
export function orderForPlacement(nodes: readonly ImportNode[]): ImportNode[] {
  const byId = new Map(nodes.map((node) => [node.sourceId, node]));
  const children = new Map<string | null, ImportNode[]>();

  for (const node of nodes) {
    const parent =
      node.parentSourceId !== null && byId.has(node.parentSourceId) && node.parentSourceId !== node.sourceId
        ? node.parentSourceId
        : null;
    const bucket = children.get(parent);
    if (bucket) bucket.push(node);
    else children.set(parent, [node]);
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => a.ordering - b.ordering || a.sourceId.localeCompare(b.sourceId));
  }

  const ordered: ImportNode[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null): void => {
    for (const node of children.get(parent) ?? []) {
      if (visited.has(node.sourceId)) continue;
      visited.add(node.sourceId);
      ordered.push(node);
      walk(node.sourceId);
    }
  };
  walk(null);

  // Anything left is in a cycle its source invented. Kept, at the root, in a
  // stable order, because losing a page is worse than misplacing one.
  for (const node of nodes) {
    if (!visited.has(node.sourceId)) {
      visited.add(node.sourceId);
      ordered.push(node);
    }
  }
  return ordered;
}

export interface PlacedTree {
  nodes: PlacedNode[];
  /** Source id to target path, for the link rewriter. */
  paths: Map<string, string>;
}

export function placeNodes(nodes: readonly ImportNode[], options: PlaceOptions = {}): PlacedTree {
  const rootPath = options.rootPath ? normalizePath(options.rootPath) : null;
  const used = new Set<string>(options.taken ?? []);
  const paths = new Map<string, string>();
  const placed: PlacedNode[] = [];

  for (const node of orderForPlacement(nodes)) {
    const parentPath =
      node.parentSourceId !== null ? (paths.get(node.parentSourceId) ?? rootPath) : rootPath;
    // Past the depth limit the tree keeps its shape as far as it can and the
    // rest becomes siblings of the deepest permitted ancestor.
    const base =
      parentPath !== null && pathDepth(parentPath) >= MAX_PATH_DEPTH
        ? trimToDepth(parentPath, MAX_PATH_DEPTH - 1)
        : parentPath;

    const segment = generateSegment(node.title);
    let path = joinPath(base, segment);
    let attempt = 1;
    while (used.has(path)) {
      attempt += 1;
      if (attempt > 500) {
        path = joinPath(base, withNumericSuffix(segment, attempt + hashOf(node.sourceId)));
        break;
      }
      path = joinPath(base, withNumericSuffix(segment, attempt));
    }

    used.add(path);
    paths.set(node.sourceId, path);
    placed.push({
      ...node,
      targetPath: path,
      warnings:
        attempt === 1 ? node.warnings : [...node.warnings, warn('path-adjusted', path)],
    });
  }

  return { nodes: placed, paths };
}

function trimToDepth(path: string, depth: number): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return `/${segments.slice(0, Math.max(depth, 1)).join('/')}`;
}

/** Small deterministic spread, so the escape hatch above still ends somewhere. */
function hashOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 1000;
  }
  return hash;
}
