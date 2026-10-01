'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { TREE_KIND_COOKIE } from '@/lib/pages/tree-filter';
import type { KindFilter } from '@/lib/pages/tree-filter';
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
  kind: 'technical' | 'human';
  /**
   * "Held by Dana since …", ready to display, when somebody holds this page.
   * The sentence is built on the server: a client component cannot be handed a
   * translation function across the boundary, and the tree has no other reason
   * to carry one.
   */
  claimLabel?: string | null;
  /** How many anchors on this page are not fresh, and a label for the badge. */
  staleAnchorCount?: number;
  staleAnchorLabel?: string | null;
  children: PageTreeItem[];
}

const kindFilters: KindFilter[] = ['all', 'technical', 'human'];

/**
 * Keeps the pages of one kind and every ancestor needed to reach them. An
 * ancestor of the other kind stays in the tree — dropping it would detach its
 * children — but is drawn dimmed, so the reader sees it is only a way through.
 */
function filterByKind(nodes: PageTreeItem[], kind: KindFilter): Array<PageTreeItem & { through?: boolean }> {
  if (kind === 'all') return nodes;
  const out: Array<PageTreeItem & { through?: boolean }> = [];
  for (const node of nodes) {
    const children = filterByKind(node.children, kind);
    if (node.kind === kind) out.push({ ...node, children });
    else if (children.length > 0) out.push({ ...node, children, through: true });
  }
  return out;
}

function TreeLevel({
  nodes,
  activeId,
  depth,
  hrefBase,
}: {
  nodes: Array<PageTreeItem & { through?: boolean }>;
  activeId: string | null;
  depth: number;
  hrefBase: string;
}) {
  return (
    <ul className={cn('grid min-w-0 gap-0.5', depth > 0 && 'ml-2 border-l border-border pl-2')}>
      {nodes.map((node) => (
        <li key={node.id} className="grid min-w-0 gap-0.5">
          <Link
            href={`${hrefBase}/${node.id}`}
            aria-current={node.id === activeId ? 'page' : undefined}
            title={`${node.title}\n${node.path}`}
            className={cn(
              // min-w-0 down the whole chain: without it a long title widens the
              // grid track past the sidebar and is drawn over the page beside it.
              'flex min-w-0 items-center rounded-(--radius-base) px-2 py-1 text-sm hover:bg-secondary',
              node.id === activeId
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground',
              node.through && node.id !== activeId && 'opacity-50',
            )}
          >
            <span className="min-w-0 truncate">{node.title}</span>
            {node.staleAnchorCount ? (
              // The count, not a dot: "3 anchors out of date" is a different
              // thing to walk into than "something here changed".
              <span
                aria-label={node.staleAnchorLabel ?? undefined}
                title={node.staleAnchorLabel ?? undefined}
                className="ml-1 inline-flex shrink-0 items-center rounded-(--radius-base) border border-destructive/40 bg-destructive/10 px-1 text-[10px] font-medium leading-4"
              >
                {node.staleAnchorCount}
              </span>
            ) : null}
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
            <TreeLevel nodes={node.children} activeId={activeId} depth={depth + 1} hrefBase={hrefBase} />
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
export function PageTree({
  nodes,
  emptyLabel,
  hrefBase,
  filterLabels,
  initialKind = 'all',
}: {
  nodes: PageTreeItem[];
  emptyLabel: string;
  /** Where a page of this tree lives, without the id: `/spaces/KEY/pages`. */
  hrefBase: string;
  /** Labels for the technical / for-people filter; without them there is no filter. */
  filterLabels?: Record<KindFilter, string> & { group: string; none: string };
  /** The filter remembered in a cookie, read by the server so both renders agree. */
  initialKind?: KindFilter;
}) {
  const pathname = usePathname();
  const match = /\/pages\/([0-9a-f-]{36})(?:\/|$)/.exec(pathname ?? '');
  const activeId = match?.[1] ?? null;
  const [kind, setKind] = useState<KindFilter>(initialKind);

  if (nodes.length === 0) {
    return <p className="px-2 py-1 text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  const shown = filterByKind(nodes, kind);
  return (
    <div className="grid min-w-0 gap-2">
      {filterLabels ? (
        <div
          role="group"
          aria-label={filterLabels.group}
          className="flex flex-wrap gap-1 text-xs"
        >
          {kindFilters.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === kind}
              onClick={() => {
                setKind(option);
                // A per-browser convenience, not a setting: a plain cookie the
                // layout reads on the next request.
                document.cookie = `${TREE_KIND_COOKIE}=${option}; path=/; max-age=31536000; samesite=lax`;
              }}
              className={cn(
                'rounded-full border px-2 py-0.5',
                option === kind
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {filterLabels[option]}
            </button>
          ))}
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className="px-2 py-1 text-sm text-muted-foreground">{filterLabels?.none ?? emptyLabel}</p>
      ) : (
        <TreeLevel nodes={shown} activeId={activeId} depth={0} hrefBase={hrefBase} />
      )}
    </div>
  );
}
