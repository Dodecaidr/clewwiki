import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ReviewStatusBadge } from '@/components/review-status-badge';
import { Card, CardBody } from '@/components/ui/card';
import { isPageServiceError } from '@/lib/pages/errors';
import { listChanges, listPendingPages } from '@/lib/reviews/service';
import type { ChangeEntry } from '@/lib/reviews/service';
import { getSessionContext } from '@/lib/session';
import { getSpaceByKey } from '@/lib/spaces/service';
import { spaceChangesHref, spacePageChangesHref, spacePageHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const FEED_PAGE_SIZE = 50;

type Props = {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ view?: string; author?: string; before?: string }>;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('reviews');
  return { title: t('title') };
}

/**
 * What changed in a space.
 *
 * The first view is the one a person opens this for: the pages agents have
 * written to since somebody last looked, one row per page. The second is every
 * revision in order, for the question "what happened here yesterday".
 */
export default async function SpaceChangesPage({ params, searchParams }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await getSpaceByKey(session.workspace.id, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('reviews');
  const format = await getFormatter();
  const query = await searchParams;
  const showAll = query.view === 'all';
  const author = query.author === 'agent' || query.author === 'user' ? query.author : undefined;

  const tabs = [
    { label: t('tabPending'), href: spaceChangesHref(space.key), active: !showAll },
    { label: t('tabAll'), href: spaceChangesHref(space.key, 'all'), active: showAll },
  ];

  let feed: ChangeEntry[] = [];
  if (showAll) {
    try {
      feed = await listChanges(session.workspace.id, space.id, {
        limit: FEED_PAGE_SIZE,
        before: query.before ?? null,
        authorType: author,
      });
    } catch (error) {
      // A cursor somebody edited by hand: start from the top rather than fail.
      if (!isPageServiceError(error)) throw error;
      redirect(spaceChangesHref(space.key, 'all'));
    }
  }
  const pending = showAll ? [] : await listPendingPages(session.workspace.id, space.id, 100);
  const last = feed[feed.length - 1];
  const olderHref =
    feed.length === FEED_PAGE_SIZE && last
      ? `${spaceChangesHref(space.key, 'all')}${author ? `&author=${author}` : ''}&before=${encodeURIComponent(last.cursor)}`
      : null;

  const authorFilters: Array<{ label: string; value: 'agent' | 'user' | undefined }> = [
    { label: t('filterEveryone'), value: undefined },
    { label: t('filterAgents'), value: 'agent' },
    { label: t('filterPeople'), value: 'user' },
  ];

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <nav aria-label={t('viewLabel')} className="flex flex-wrap items-center gap-2 text-xs">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.active ? 'page' : undefined}
            className={`rounded-(--radius-base) border px-2 py-0.5 ${
              tab.active
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border hover:bg-secondary'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {showAll ? (
        <>
          <nav aria-label={t('filterLabel')} className="flex flex-wrap items-center gap-2 text-xs">
            {authorFilters.map((filter) => (
              <Link
                key={filter.label}
                href={`${spaceChangesHref(space.key, 'all')}${filter.value ? `&author=${filter.value}` : ''}`}
                aria-current={author === filter.value ? 'true' : undefined}
                className={`rounded-(--radius-base) border px-2 py-0.5 ${
                  author === filter.value ? 'border-primary' : 'border-border hover:bg-secondary'
                }`}
              >
                {filter.label}
              </Link>
            ))}
          </nav>

          {feed.length === 0 ? (
            <Card>
              <CardBody className="text-sm text-muted-foreground">{t('emptyAll')}</CardBody>
            </Card>
          ) : (
            <ul className="grid gap-px overflow-hidden rounded-(--radius-base) border border-border bg-border">
              {feed.map((entry) => (
                <li
                  key={`${entry.page.id}-${entry.version}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-card px-4 py-2 text-sm"
                >
                  <Link
                    href={spacePageChangesHref(space.key, entry.page.id, {
                      from: entry.version - 1,
                      to: entry.version,
                    })}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {entry.title}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {t('versionShort', { version: entry.version })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {entry.author.type === 'agent'
                      ? t('byAgent', { name: entry.author.label })
                      : t('byPerson', { name: entry.author.label })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(format, entry.createdAt)}
                  </span>
                  <span className="ml-auto">
                    <ReviewStatusBadge status={entry.status} label={entry.status === 'none' ? '' : t(`status.${entry.status}`)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {olderHref ? (
            <Link href={olderHref} className="text-sm underline underline-offset-2">
              {t('older')}
            </Link>
          ) : null}
        </>
      ) : pending.length === 0 ? (
        <Card>
          <CardBody className="grid justify-items-start gap-3 text-sm">
            <p className="text-muted-foreground">{t('emptyPending')}</p>
            <Link
              href="/guide#reviews"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {t('whatIsThis')}
            </Link>
          </CardBody>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {pending.map((entry) => (
            <li key={entry.page.id}>
              <Card>
                <CardBody className="grid gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      href={spacePageChangesHref(space.key, entry.page.id)}
                      className="text-base font-semibold underline-offset-2 hover:underline"
                    >
                      {entry.page.title}
                    </Link>
                    {entry.stats ? (
                      <span className="font-mono text-xs tabular-nums">
                        <span className="text-success">+{entry.stats.added}</span>{' '}
                        <span className="text-destructive">−{entry.stats.removed}</span>
                      </span>
                    ) : null}
                  </div>
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono">{entry.page.path}</span>
                    <span>
                      {entry.created
                        ? t('pendingCreated', { count: entry.revisionCount })
                        : t('pendingSince', {
                            count: entry.revisionCount,
                            version: entry.baselineVersion,
                          })}
                    </span>
                    <span>{entry.authors.map((who) => who.label).join(', ')}</span>
                    <span>{formatDateTime(format, entry.page.updatedAt)}</span>
                  </p>
                  <p className="flex flex-wrap gap-4 text-sm">
                    <Link
                      href={spacePageChangesHref(space.key, entry.page.id)}
                      className="underline underline-offset-2"
                    >
                      {t('reviewLink')}
                    </Link>
                    <Link
                      href={spacePageHref(space.key, entry.page.id)}
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      {t('openPage')}
                    </Link>
                  </p>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
