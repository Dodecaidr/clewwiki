'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

/**
 * One node of the navigation tree.
 *
 * Deliberately narrower than the service's `PageTreeNode`: the sidebar sends
 * its data across the server/client boundary, and there is no reason for a
 * page body or an author id to make that trip.
 */
export interface PageTreeItem {
  id: string;
  title: string;
  path: string;
  children: PageTreeItem[];
}

function TreeLevel({ nodes, activeId, depth }: { nodes: PageTreeItem[]; activeId: string | null; depth: number }) {
  return (
    <ul className={cn('grid gap-0.5', depth > 0 && 'ml-2 border-l border-border pl-2')}>
      {nodes.map((node) => (
        <li key={node.id} className="grid gap-0.5">
          <Link
            href={`/pages/${node.id}`}
            aria-current={node.id === activeId ? 'page' : undefined}
            title={node.path}
            className={cn(
              'block truncate rounded-(--radius-base) px-2 py-1 text-sm hover:bg-secondary',
              node.id === activeId
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground',
            )}
          >
            {node.title}
          </Link>
          {node.children.length > 0 ? (
            <TreeLevel nodes={node.children} activeId={activeId} depth={depth + 1} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The navigation tree: plain links, fully expanded, rendered from data the
 * server already had. Which entry is current comes from the URL rather than
 * from a prop, so the tree can live in the layout and survive navigation
 * between pages without being re-fetched.
 */
export function PageTree({ nodes, emptyLabel }: { nodes: PageTreeItem[]; emptyLabel: string }) {
  const pathname = usePathname();
  const match = /^\/pages\/([0-9a-f-]{36})/.exec(pathname ?? '');
  const activeId = match?.[1] ?? null;

  if (nodes.length === 0) {
    return <p className="px-2 py-1 text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return <TreeLevel nodes={nodes} activeId={activeId} depth={0} />;
}
