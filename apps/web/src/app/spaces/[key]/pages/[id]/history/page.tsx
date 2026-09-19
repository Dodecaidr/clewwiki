import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ReviewStatusBadge } from '@/components/review-status-badge';
import { Card, CardBody } from '@/components/ui/card';
import { getPageReviewState, listPageHistory } from '@/lib/reviews/service';
import { getSessionContext } from '@/lib/session';
import { spacePageChangesHref, spacePageHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { assertSameWorkspace } from '@/lib/workspace';
import { findPage, findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string; id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('reviews');
  return { title: t('historyTitle') };
}

/** Every version of a page: who wrote it, what became of it, and what it changed. */
export default async function PageHistoryPage({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const { key, id } = await params;
  if (!UUID.test(id)) notFound();
  const space = await findSpaceByKey(session, key);
  if (!space) notFound();
  const page = await findPage(session, id);
  if (!page || page.spaceId !== space.id) notFound();
  assertSameWorkspace(session.workspace.id, page.workspaceId);

  const t = await getTranslations('reviews');
  const format = await getFormatter();
  const [history, state] = await Promise.all([
    listPageHistory(session.workspace.id, page.id),
    getPageReviewState(session.workspace.id, page.id),
  ]);

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <p className="text-xs text-muted-foreground">
          <Link href={spacePageHref(space.key, page.id)} className="underline underline-offset-2">
            {page.title}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{t('historyTitle')}</h1>
        {state.pending ? (
          <p className="text-sm">
            <Link href={spacePageChangesHref(space.key, page.id)} className="underline underline-offset-2">
              {t('pendingBanner', { count: state.pendingRevisions.length })}
            </Link>
          </p>
        ) : null}
      </div>

      <Card>
        <CardBody className="p-0">
          <ol className="grid divide-y divide-border">
            {history.map((revision) => (
              <li
                key={revision.version}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2 text-sm"
              >
                <span className="w-10 font-medium tabular-nums">
                  {t('versionShort', { version: revision.version })}
                </span>
                <span>
                  {revision.author.type === 'agent'
                    ? t('byAgent', { name: revision.author.label })
                    : t('byPerson', { name: revision.author.label })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(format, revision.createdAt)}
                </span>
                <ReviewStatusBadge status={revision.status} label={revision.status === 'none' ? '' : t(`status.${revision.status}`)} />
                <span className="ml-auto flex flex-wrap gap-3 text-xs">
                  <Link
                    href={spacePageChangesHref(space.key, page.id, {
                      from: revision.version - 1,
                      to: revision.version,
                    })}
                    className="underline underline-offset-2"
                  >
                    {t('whatChanged')}
                  </Link>
                  {revision.version < page.version ? (
                    <Link
                      href={spacePageChangesHref(space.key, page.id, {
                        from: revision.version,
                        to: page.version,
                      })}
                      className="underline underline-offset-2"
                    >
                      {t('compareWithCurrent')}
                    </Link>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      {state.reviews.length > 0 ? (
        <section className="grid gap-2">
          <h2 className="text-sm font-semibold">{t('decisionsHeading')}</h2>
          <ul className="grid gap-2 text-sm">
            {state.reviews.map((review) => (
              <li key={review.id} className="grid gap-0.5">
                <span>
                  <Link
                    href={spacePageChangesHref(space.key, page.id, {
                      from: review.fromVersion,
                      to: review.toVersion,
                    })}
                    className="underline underline-offset-2"
                  >
                    {t('versionRange', { from: review.fromVersion, to: review.toVersion })}
                  </Link>
                  {' — '}
                  {review.decision === 'accepted'
                    ? t('decisionAcceptedBy', { name: review.reviewerLabel })
                    : t('decisionRevertedBy', { name: review.reviewerLabel })}
                  <span className="text-muted-foreground">
                    {' · '}
                    {formatDateTime(format, review.createdAt)}
                  </span>
                </span>
                {review.note ? (
                  <span className="whitespace-pre-wrap text-muted-foreground">{review.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
