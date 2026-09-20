import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { canWrite } from '@/lib/roles';
import { listDiscussions, wasClosedForInactivity } from '@/lib/discussions/service';
import { readDiscussionPolicy } from '@/lib/discussions/retention';
import { getSessionContext } from '@/lib/session';
import {
  newSpaceDiscussionHref,
  spaceDiscussionHref,
  spaceDiscussionsHref,
  spacePageHref,
} from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { findPage, findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string }>; searchParams: Promise<{ status?: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('discussions');
  return { title: t('title') };
}

/**
 * A space's discussions.
 *
 * No live updates: a discussion moves at the speed of the work it is about, and
 * a page that refetches itself would spend an instance's budget to save a
 * keystroke. Reload the page to see new messages — the thread says as much.
 */
export default async function SpaceDiscussionsPage({ params, searchParams }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await findSpaceByKey(session, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('discussions');
  const format = await getFormatter();

  const requested = (await searchParams).status;
  const status = requested === 'open' || requested === 'resolved' ? requested : undefined;
  const entries = await listDiscussions(session.workspace.id, space.id, { status });
  const policy = readDiscussionPolicy(space.settings);

  // The pages threads are about, in one pass rather than one query per row.
  const pageIds = [...new Set(entries.map((entry) => entry.pageId).filter((id): id is string => !!id))];
  const pageTitles = new Map<string, string>();
  for (const pageId of pageIds) {
    const page = await findPage(session, pageId);
    if (page) pageTitles.set(pageId, page.title);
  }

  const filters: Array<{ key: string; value: 'open' | 'resolved' | undefined }> = [
    { key: 'filterAll', value: undefined },
    { key: 'filterOpen', value: 'open' },
    { key: 'filterResolved', value: 'resolved' },
  ];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t('retentionSummary', {
              idleDays: policy.idleDays,
              retentionDays: policy.retentionDays,
            })}
          </p>
        </div>
        {space.archivedAt || !canWrite(session.role) ? null : (
          <Link href={newSpaceDiscussionHref(space.key)} className={buttonVariants({ size: 'sm' })}>
            {t('new')}
          </Link>
        )}
      </div>

      <nav aria-label={t('filterLabel')} className="flex flex-wrap items-center gap-2 text-xs">
        {filters.map((filter) => {
          const active = status === filter.value;
          const href = filter.value
            ? `${spaceDiscussionsHref(space.key)}?status=${filter.value}`
            : spaceDiscussionsHref(space.key);
          return (
            <Link
              key={filter.key}
              href={href}
              className={`rounded-(--radius-base) border px-2 py-0.5 ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:bg-secondary'
              }`}
            >
              {t(filter.key)}
            </Link>
          );
        })}
      </nav>

      {entries.length === 0 ? (
        <Card>
          <CardBody className="grid justify-items-start gap-4 text-sm">
            <p className="text-muted-foreground">{status ? t('emptyFiltered') : t('empty')}</p>
            <div className="flex flex-wrap items-center gap-4">
              {space.archivedAt || !canWrite(session.role) ? null : (
                <Link
                  href={newSpaceDiscussionHref(space.key)}
                  className={buttonVariants({ size: 'sm' })}
                >
                  {t('new')}
                </Link>
              )}
              <Link
                href="/guide#discussions"
                className="text-sm underline underline-offset-2 hover:text-foreground"
              >
                {t('whatIsThis')}
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Card>
                <CardBody className="grid gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      href={spaceDiscussionHref(space.key, entry.id)}
                      className="text-base font-semibold underline-offset-2 hover:underline"
                    >
                      {entry.title}
                    </Link>
                    <span
                      className={`rounded-(--radius-base) border px-2 py-0.5 text-xs ${
                        entry.status === 'open'
                          ? 'border-primary text-foreground'
                          : 'border-border text-muted-foreground'
                      }`}
                    >
                      {entry.status === 'open' ? t('statusOpen') : t('statusResolved')}
                    </span>
                  </div>

                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{t('messageCount', { count: entry.messageCount })}</span>
                    <span>
                      {t('participantsLabel')}:{' '}
                      {entry.participants.map((who) => who.label).join(', ')}
                    </span>
                    <span>
                      {t('lastActivityLabel')}: {formatDateTime(format, entry.lastActivityAt)}
                    </span>
                  </p>

                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {entry.pageId ? (
                      <span>
                        {t('aboutLabel')}:{' '}
                        <Link
                          href={spacePageHref(space.key, entry.pageId)}
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {pageTitles.get(entry.pageId) ?? entry.pageId}
                        </Link>
                      </span>
                    ) : null}
                    <span>
                      {entry.status === 'open'
                        ? t('closesAt', { at: formatDateTime(format, entry.expiresAt) ?? '—' })
                        : t('deletedAt', { at: formatDateTime(format, entry.expiresAt) ?? '—' })}
                    </span>
                    {wasClosedForInactivity(entry) ? <span>{t('closedForInactivity')}</span> : null}
                    {entry.decisionPageId ? (
                      <Link
                        href={spacePageHref(space.key, entry.decisionPageId)}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        {t('decisionPageLink')}
                      </Link>
                    ) : null}
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
