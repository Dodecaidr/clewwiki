import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ReviewForm } from './review-form';
import { DiffView } from '@/components/diff-view';
import { Alert, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { isPageServiceError } from '@/lib/pages/errors';
import { diffPageVersions, getPageReviewState } from '@/lib/reviews/service';
import type { VersionDiff } from '@/lib/reviews/service';
import { getSessionContext } from '@/lib/session';
import { getSpaceByKey } from '@/lib/spaces/service';
import {
  spaceChangesHref,
  spacePageChangesHref,
  spacePageHistoryHref,
  spacePageHref,
} from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { assertSameWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ key: string; id: string }>;
  searchParams: Promise<{ from?: string; to?: string; decided?: string }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toVersion(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('reviews');
  return { title: t('compareTitle') };
}

/**
 * Two versions of a page side by side in one column: what was, what is.
 *
 * Opened without versions it shows what is waiting for a review — the baseline
 * against the current version — and that comparison, and only that one, carries
 * the accept and revert buttons: a decision is about everything since the
 * baseline, so it is offered where everything since the baseline is on screen.
 */
export default async function PageChangesPage({ params, searchParams }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const { key, id } = await params;
  if (!UUID.test(id)) notFound();
  const space = await getSpaceByKey(session.workspace.id, key);
  if (!space) notFound();

  let state;
  try {
    state = await getPageReviewState(session.workspace.id, id);
  } catch (error) {
    if (isPageServiceError(error) && error.code === 'not_found') notFound();
    throw error;
  }
  const { page } = state;
  assertSameWorkspace(session.workspace.id, page.workspaceId);
  if (page.spaceId !== space.id) notFound();

  const t = await getTranslations('reviews');
  const format = await getFormatter();
  const query = await searchParams;

  const to = toVersion(query.to) ?? page.version;
  const from =
    toVersion(query.from) ?? (state.pending ? state.baselineVersion : Math.max(0, to - 1));

  let result: VersionDiff;
  try {
    result = await diffPageVersions(session.workspace.id, page.id, from, to);
  } catch (error) {
    if (isPageServiceError(error)) redirect(spacePageHistoryHref(space.key, page.id));
    throw error;
  }

  const isPendingRange = state.pending && from === state.baselineVersion && to === page.version;
  const decision = state.reviews.find(
    (review) => review.fromVersion === from && review.toVersion === to,
  );
  const authors = state.pendingRevisions
    .filter((revision) => revision.version > from && revision.version <= to)
    .map((revision) => revision.author.label);

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <p className="text-xs text-muted-foreground">
          <Link href={spacePageHref(space.key, page.id)} className="underline underline-offset-2">
            {page.title}
          </Link>
          {' · '}
          <Link
            href={spacePageHistoryHref(space.key, page.id)}
            className="underline underline-offset-2"
          >
            {t('historyLink')}
          </Link>
          {' · '}
          <Link href={spaceChangesHref(space.key)} className="underline underline-offset-2">
            {t('title')}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {from === 0
            ? t('compareHeadingCreated', { to })
            : t('compareHeading', { from, to })}
        </h1>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">
            <span className="text-success">+{result.diff.stats.added}</span>{' '}
            <span className="text-destructive">−{result.diff.stats.removed}</span>
          </span>
          <span>{formatDateTime(format, result.to.createdAt)}</span>
          {authors.length > 0 ? <span>{[...new Set(authors)].join(', ')}</span> : null}
        </p>
      </div>

      {query.decided && decision ? (
        <Alert tone="success">
          {decision.decision === 'accepted'
            ? t('decidedAccepted')
            : t('decidedReverted', { version: decision.resultVersion ?? page.version })}
        </Alert>
      ) : null}

      {state.pending && !isPendingRange ? (
        <Alert tone="info">
          {t('pendingElsewhere')}{' '}
          <Link href={spacePageChangesHref(space.key, page.id)} className="underline underline-offset-2">
            {t('reviewLink')}
          </Link>
        </Alert>
      ) : null}

      {result.titleChanged && result.from ? (
        <p className="text-sm">
          {t('titleChanged')}: <del className="text-muted-foreground">{result.from.title}</del>{' '}
          → <ins className="no-underline">{result.to.title}</ins>
        </p>
      ) : null}
      {result.summaryChanged ? <p className="text-sm text-muted-foreground">{t('summaryChanged')}</p> : null}

      <DiffView
        diff={result.diff}
        labels={{
          caption: t('diffCaption', { from, to }),
          oldLine: t('diffOldLine'),
          newLine: t('diffNewLine'),
          added: t('diffAdded'),
          removed: t('diffRemoved'),
          skipped: (count) => t('diffSkipped', { count }),
          identical: t('diffIdentical'),
          onlyLineEndings: t('diffOnlyLineEndings'),
          coarse: t('diffCoarse'),
        }}
      />

      {isPendingRange ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('decideHeading')}</CardTitle>
          </CardHeader>
          <CardBody>
            <ReviewForm
              pageId={page.id}
              version={page.version}
              canRevert={state.baselineVersion > 0}
              baselineVersion={state.baselineVersion}
            />
          </CardBody>
        </Card>
      ) : null}

      {decision ? (
        <Card>
          <CardBody className="grid gap-1 text-sm">
            <p>
              {decision.decision === 'accepted'
                ? t('decisionAcceptedBy', { name: decision.reviewerLabel })
                : t('decisionRevertedBy', { name: decision.reviewerLabel })}
              <span className="text-muted-foreground">
                {' · '}
                {formatDateTime(format, decision.createdAt)}
              </span>
            </p>
            {decision.note ? <p className="whitespace-pre-wrap text-muted-foreground">{decision.note}</p> : null}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
