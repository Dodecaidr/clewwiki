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
  /**
   * "Held by Dana since …", ready to display, when somebody holds this page.
   * The sentence is built on the server: a client component cannot be handed a
   * translation function across the boundary, and the tree has no other reason
   * to carry one.
   */
  claimLabel?: string | null;
  children: PageTreeItem[];
}

function TreeLevel({
  nodes,
  activeId,
  depth,
}: {
  nodes: PageTreeItem[];
  activeId: string | null;
  depth: number;
}) {
  return (
    <ul className={cn('grid gap-0.5', depth > 0 && 'ml-2 border-l border-border pl-2')}>
      {nodes.map((node) => (
        <li key={node.id} className="grid gap-0.5">
          <Link
            href={`/pages/${node.id}`}
            aria-current={node.id === activeId ? 'page' : undefined}
            title={node.path}
            className={cn(
              'flex items-center rounded-(--radius-base) px-2 py-1 text-sm hover:bg-secondary',
              node.id === activeId
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground',
            )}
          >
            <span className="truncate">{node.title}</span>
            {node.claimLabel ? (
              // A held page is marked where the reader already is, rather than
              // only on the presence board: the point of the badge is to be
              // seen before the edit button is clicked.
              <span
                aria-label={node.claimLabel}
                title={node.claimLabel}
                className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-primary align-middle"
              />
            ) : null}
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
