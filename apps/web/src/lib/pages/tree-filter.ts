/**
 * Which kind of page the space sidebar shows. Kept out of the client tree
 * component so the server layout can read the remembered choice too.
 */
export type KindFilter = 'all' | 'technical' | 'human';
export const TREE_KIND_COOKIE = 'clewwiki-tree-kind';

export function readTreeKind(value: string | undefined): KindFilter {
  return value === 'technical' || value === 'human' ? value : 'all';
}
