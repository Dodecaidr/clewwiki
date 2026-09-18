import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
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
import { getSpaceByKey } from '@/lib/spaces/service';
import {
  newSpacePageHref,
  spaceHref,
  spacePagesBase,
  spaceRulesHref,
  spaceSettingsHref,
  spaceSkillsHref,
} from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { assertSameWorkspace } from '@/lib/workspace';

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
 * The space shell: the space's name on top, its page tree on the left, the
 * overview or a page on the right.
 *
 * The tree is read here, once per request, for every route inside the space —
 * the sidebar is the same on all of them, so rendering it in the layout keeps
 * each child page from querying it again.
 */
export default async function SpaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ key: string }>;
}) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const { key } = await params;
  const space = await getSpaceByKey(session.workspace.id, key);
  if (!space) {
    notFound();
  }
  // The lookup already scoped to the workspace; this re-asserts it on the row
  // about to be rendered. `/spaces/mobile` finds the space `MOBILE`; the page
  // views redirect to the canonical spelling.
  assertSameWorkspace(session.workspace.id, space.workspaceId);

  const t = await getTranslations('pages');
  const ts = await getTranslations('spaces');
  const ta = await getTranslations('anchors');
  const trules = await getTranslations('rules');
  const tsk = await getTranslations('skills');
  const format = await getFormatter();
  const [tree, claims, staleAnchors] = await Promise.all([
    getPageTree(session.workspace.id, space.id),
    // One query each for the whole sidebar rather than one per node: presence
    // and anchor state are cheap only if they are read in bulk.
    getActiveClaimsByPage(session.workspace.id),
    getStaleAnchorCounts(session.workspace.id),
  ]);

  const labels: TreeLabels = {
    claim: (claim: ClaimRecord) =>
      t('claimHeldBy', {
        name: claim.holderLabel,
        since: formatDateTime(format, claim.createdAt) ?? '—',
      }),
    staleAnchors: (count: number) => ta('treeBadge', { count }),
  };

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="flex min-w-0 items-center gap-3">
          {space.icon ? (
            <span aria-hidden className="text-2xl leading-none">
              {space.icon}
            </span>
          ) : null}
          <div className="grid min-w-0 gap-0.5">
            <Link
              href={spaceHref(space.key)}
              className="truncate text-lg font-semibold tracking-tight hover:underline"
            >
              {space.name}
            </Link>
            <p className="font-mono text-xs text-muted-foreground">
              {space.key}
              {space.archivedAt ? ` · ${ts('archivedBadge')}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* A plain download link: the export endpoint answers with a file. */}
          <a
            href={`/api/v1/spaces/${space.key}/export?format=md`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {ts('exportZip')}
          </a>
          {session.role === 'admin' ? (
            <Link
              href={spaceSettingsHref(space.key)}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {ts('settings')}
            </Link>
          ) : null}
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="grid content-start gap-3">
          {/* Rules and skills sit above the tree rather than inside it: they
              are not pages of the project, they are how the project tells an
              agent how to work in it. */}
          <nav aria-label={ts('sidebarResources')} className="grid gap-1 text-sm">
            <Link
              href={spaceRulesHref(space.key)}
              className="rounded-(--radius-base) px-2 py-1 font-medium hover:bg-secondary"
            >
              {trules('title')}
            </Link>
            <Link
              href={spaceSkillsHref(space.key)}
              className="rounded-(--radius-base) px-2 py-1 font-medium hover:bg-secondary"
            >
              {tsk('title')}
            </Link>
          </nav>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <Link
              href={spaceHref(space.key)}
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              {t('treeHeading')}
            </Link>
            {space.archivedAt ? null : (
              <Link
                href={newSpacePageHref(space.key)}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('new')}
              </Link>
            )}
          </div>
          <nav aria-label={t('treeHeading')}>
            <PageTree
              nodes={tree.map((node) => toTreeItem(node, claims, staleAnchors, labels))}
              emptyLabel={t('empty')}
              hrefBase={spacePagesBase(space.key)}
            />
          </nav>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
