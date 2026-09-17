import type { PageTreeNode } from '../pages/service';

/**
 * The tree flattened in display order with each page's depth, for pickers that
 * are a `<select>` rather than a nested list.
 */
export interface FlatTreeEntry {
  id: string;
  title: string;
  path: string;
  depth: number;
}

export function flattenTree(nodes: readonly PageTreeNode[], depth = 0): FlatTreeEntry[] {
  const out: FlatTreeEntry[] = [];
  for (const node of nodes) {
    out.push({ id: node.id, title: node.title, path: node.path, depth });
    out.push(...flattenTree(node.children, depth + 1));
  }
  return out;
}

/** Every id in the subtree headed by `rootId`, the root included. */
export function subtreeIds(nodes: readonly PageTreeNode[], rootId: string): Set<string> {
  const ids = new Set<string>();
  const visit = (list: readonly PageTreeNode[], inside: boolean) => {
    for (const node of list) {
      const within = inside || node.id === rootId;
      if (within) ids.add(node.id);
      visit(node.children, within);
    }
  };
  visit(nodes, false);
  return ids;
}
