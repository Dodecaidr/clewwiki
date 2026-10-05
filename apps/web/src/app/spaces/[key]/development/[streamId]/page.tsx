import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { PageBody } from '@/components/page-body';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getStream, listReleases, listStreamProblems } from '@/lib/development/service';
import { renderMarkdown } from '@/lib/pages/markdown';
import { renderLabels } from '@/lib/pages/render-labels';
import { canWrite } from '@/lib/roles';
import { getSessionContext } from '@/lib/session';
import { issueLinker, readTrackers } from '@/lib/trackers/settings';
import { spaceDevelopmentHref, spaceDiscussionHref, spaceDiscussionsHref, spacePageHref } from '@/lib/spaces/urls';
import { findPage, findSpaceByKey } from '@/lib/spaces/visibility';
import { formatDateTime } from '@/lib/utils';

import { DocsPageButton, StreamEditForm } from '../forms';
import { buildRows } from '../rows';
import { StreamRow } from '../stream-row';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('development');
  return { title: t('title') };
}

/**
 * One line of development: where its branch stands, what it is for, its
 * issues, the problems being worked out for it, and its documentation — where
 * the decisions of those problems are written.
 */
export default async function StreamPage({ params }: { params: Promise<{ key: string; streamId: string }> }) {
  const session = await getSessionContext();
  if (!session) redirect('/login');
  const { key, streamId } = await params;
  const space = await findSpaceByKey(session, key);
  if (!space || !/^[0-9a-f-]{36}$/i.test(streamId)) notFound();
  const stream = await getStream(session.workspace.id, streamId);
  if (!stream || stream.spaceId !== space.id) notFound();

  const t = await getTranslations('development');
  const format = await getFormatter();
  const [releases, problems, docsPage] = await Promise.all([
    listReleases(session.workspace.id, space.id),
    listStreamProblems(session.workspace.id, stream.id),
    stream.docsPageId ? findPage(session, stream.docsPageId) : Promise.resolve(null),
  ]);
  const openCount = problems.filter((problem) => problem.status === 'open').length;
  const { rows, labels } = await buildRows(session.workspace, space.key, [stream], releases, new Map([[stream.id, openCount]]));
  const row = rows.get(stream.id);
  const goalHtml =
    stream.goal.trim() === ''
      ? ''
      : await renderMarkdown(stream.goal, await renderLabels(), undefined, issueLinker(readTrackers(session.workspace)));
  const writer = canWrite(session.role) && space.archivedAt === null;
  const docs = docsPage && docsPage.deletedAt === null ? docsPage : null;

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link href={spaceDevelopmentHref(space.key)} className="text-xs text-muted-foreground hover:underline">
          ← {t('title')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{stream.title}</h1>
        {stream.branch?.subject ? (
          <p className="text-xs text-muted-foreground">
            {t('lastCommitSubject')}: <span className="font-mono">{stream.branch.subject}</span>
          </p>
        ) : null}
      </div>

      {row ? (
        <ul>
          <StreamRow row={row} labels={labels} />
        </ul>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('goal')}</CardTitle>
        </CardHeader>
        <CardBody>{goalHtml ? <PageBody html={goalHtml} /> : <p className="text-sm text-muted-foreground">{t('noGoal')}</p>}</CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('problemsHeading', { count: openCount })}</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 text-sm">
          <p className="text-xs text-muted-foreground">{t('problemsIntro')}</p>
          {problems.length === 0 ? <p className="text-muted-foreground">{t('noProblems')}</p> : null}
          <ul className="grid gap-1.5">
            {problems.map((problem) => (
              <li key={problem.id} className="flex flex-wrap items-baseline gap-x-2">
                <Link href={spaceDiscussionHref(space.key, problem.id)} className="font-medium hover:underline">
                  {problem.title}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {problem.status === 'open' ? t('problemOpen') : t('problemResolved')} · {problem.openedByLabel} ·{' '}
                  {formatDateTime(format, problem.lastActivityAt)}
                </span>
                {problem.decisionPageId ? (
                  <Link href={spacePageHref(space.key, problem.decisionPageId)} className="text-xs text-primary hover:underline">
                    {t('decision')}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          {writer ? (
            <div>
              <Link
                href={`${spaceDiscussionsHref(space.key)}/new?stream=${stream.id}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('openProblem')}
              </Link>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('docsHeading')}</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-2 text-sm">
          {docs ? (
            <Link href={spacePageHref(space.key, docs.id)} className="font-medium text-primary hover:underline">
              {docs.title}
            </Link>
          ) : (
            <>
              <p className="text-muted-foreground">{t('noDocs')}</p>
              {writer ? <DocsPageButton spaceKey={space.key} streamId={stream.id} /> : null}
            </>
          )}
        </CardBody>
      </Card>

      {writer ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('editHeading')}</CardTitle>
          </CardHeader>
          <CardBody>
            <StreamEditForm
              spaceKey={space.key}
              stream={{
                id: stream.id,
                title: stream.title,
                ref: stream.ref,
                state: stream.state,
                goal: stream.goal,
                issueKeys: stream.issueKeys,
                releaseId: stream.releaseId,
              }}
              releases={releases.filter((release) => release.state === 'planned' || release.id === stream.releaseId).map((release) => ({ id: release.id, name: release.name }))}
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
