import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { PageTree } from '@/components/page-tree';
import type { PageTreeItem } from '@/components/page-tree';
import { buttonVariants } from '@/components/ui/button';
import { getStaleAnchorCounts } from '@/lib/anchors/service';
import { getActiveClaimsByPage } from '@/lib/claims/service';
import type { ClaimRecord } from '@/lib/claims/service';
import { getPageTree } from '@/lib/pages/service';
import type { PageTreeNode } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface TreeLabels {
  claim: (claim: ClaimRecord) => string;
  staleAnchors: (count: number) => string;
}

function toTreeItem(
  node: PageTreeNode,
  claims: Map<string, ClaimRecord>,
  staleAnchors: Map<string, number>,
  labels: TreeLabels,
): PageTreeItem {
  const claim = claims.get(node.id);
  const stale = staleAnchors.get(node.id) ?? 0;
  return {
    id: node.id,
    title: node.title,
    path: node.path,
    claimLabel: claim ? labels.claim(claim) : null,
    staleAnchorCount: stale,
    staleAnchorLabel: stale > 0 ? labels.staleAnchors(stale) : null,
    children: node.children.map((child) => toTreeItem(child, claims, staleAnchors, labels)),
  };
}

/**
 * The wiki shell: a tree on the left, the page on the right.
 *
 * The tree is read here, once per request, for every route under `/pages` —
 * the sidebar is identical on all of them, so rendering it in the layout keeps
 * each child page from querying it again.
 */
export default async function PagesLayout({ children }: { children: ReactNode }) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('pages');
  const ta = await getTranslations('anchors');
  const [tree, claims, staleAnchors] = await Promise.all([
    getPageTree(session.workspace.id),
    // One query each for the whole sidebar rather than one per node: the tree
    // is rendered on every route under `/pages`, and presence and anchor state
    // are cheap only if they are read in bulk.
    getActiveClaimsByPage(session.workspace.id),
    getStaleAnchorCounts(session.workspace.id),
  ]);

  const labels: TreeLabels = {
    claim: (claim: ClaimRecord) =>
      t('claimHeldBy', {
        name: claim.holderLabel,
        since: formatDateTime(claim.createdAt) ?? '—',
      }),
    staleAnchors: (count: number) => ta('treeBadge', { count }),
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="grid content-start gap-3">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/pages"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          >
            {t('treeHeading')}
          </Link>
          <Link href="/pages/new" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('new')}
          </Link>
        </div>
        <nav aria-label={t('treeHeading')}>
          <PageTree
            nodes={tree.map((node) => toTreeItem(node, claims, staleAnchors, labels))}
            emptyLabel={t('empty')}
          />
        </nav>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
