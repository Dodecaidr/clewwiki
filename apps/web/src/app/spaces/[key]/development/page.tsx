import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buildOverview, countOpenProblems, listReleases, listStreams } from '@/lib/development/service';
import { readRepositorySettings } from '@/lib/repository';
import { canWrite } from '@/lib/roles';
import { getSessionContext } from '@/lib/session';
import { findSpaceByKey } from '@/lib/spaces/visibility';

import { NewReleaseForm, NewStreamForm, QuickReleaseForm, ShipReleaseForm, SyncButton } from './forms';
import { buildRows } from './rows';
import { StreamRow } from './stream-row';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('development');
  return { title: t('title') };
}

/**
 * Development: the releases the space is heading for, what each still lacks
 * in the default branch, what was merged with no release to ship in, and the
 * work in progress — so nothing merged is forgotten and nothing planned
 * silently misses the release.
 */
export default async function DevelopmentPage({ params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionContext();
  if (!session) redirect('/login');
  const { key } = await params;
  const space = await findSpaceByKey(session, key);
  if (!space) notFound();

  const t = await getTranslations('development');
  const [streams, releases] = await Promise.all([
    listStreams(session.workspace.id, space.id),
    listReleases(session.workspace.id, space.id),
  ]);
  const problems = await countOpenProblems(session.workspace.id, streams.map((stream) => stream.id));
  const overview = buildOverview(streams, releases);
  const { rows, labels } = await buildRows(session.workspace, space.key, streams, releases, problems);
  const writer = canWrite(session.role) && space.archivedAt === null;
  const hasRepository = readRepositorySettings(space.settings) !== null;
  const planned = releases.filter((release) => release.state === 'planned');
  const plannedOptions = planned.map((release) => ({ id: release.id, name: release.name }));
  const row = (id: string) => rows.get(id);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        {writer && hasRepository ? <SyncButton spaceKey={space.key} /> : null}
      </div>
      {!hasRepository ? <p className="text-xs text-muted-foreground">{t('noRepository')}</p> : null}

      {overview.releases
        .filter((entry) => entry.release.state === 'planned')
        .map((entry) => (
          <Card key={entry.release.id}>
            <CardHeader>
              <CardTitle>
                {t('releaseHeading', { name: entry.release.name })}
                {entry.release.dueOn ? <span className="ml-2 text-sm font-normal text-muted-foreground">{entry.release.dueOn}</span> : null}
              </CardTitle>
              <CardDescription>
                {entry.streams.length === 0
                  ? t('releaseEmpty')
                  : entry.missing.length === 0
                    ? t('releaseReady', { count: entry.streams.length })
                    : t('releaseMissing', { missing: entry.missing.length, total: entry.streams.length })}
              </CardDescription>
            </CardHeader>
            <CardBody className="grid gap-3">
              <ul className="grid gap-2">
                {[...entry.missing, ...entry.streams.filter((stream) => !entry.missing.includes(stream))].map((stream) => {
                  const data = row(stream.id);
                  return data ? <StreamRow key={stream.id} row={data} labels={labels} /> : null;
                })}
              </ul>
              {writer ? <ShipReleaseForm spaceKey={space.key} releaseId={entry.release.id} missing={entry.missing.length} /> : null}
            </CardBody>
          </Card>
        ))}

      <Card className={overview.mergedUnreleased.length > 0 ? 'border-warning' : undefined}>
        <CardHeader>
          <CardTitle>{t('mergedUnreleasedHeading', { count: overview.mergedUnreleased.length })}</CardTitle>
          <CardDescription>{t('mergedUnreleasedIntro')}</CardDescription>
        </CardHeader>
        <CardBody>
          {overview.mergedUnreleased.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('nothingHere')}</p>
          ) : (
            <ul className="grid gap-2">
              {overview.mergedUnreleased.map((stream) => {
                const data = row(stream.id);
                return data ? (
                  <StreamRow
                    key={stream.id}
                    row={data}
                    labels={labels}
                    trailing={writer ? <QuickReleaseForm spaceKey={space.key} streamId={stream.id} releases={plannedOptions} /> : null}
                  />
                ) : null;
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('unplannedHeading', { count: overview.unplanned.length })}</CardTitle>
          <CardDescription>{t('unplannedIntro')}</CardDescription>
        </CardHeader>
        <CardBody>
          {overview.unplanned.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('nothingHere')}</p>
          ) : (
            <ul className="grid gap-2">
              {overview.unplanned.map((stream) => {
                const data = row(stream.id);
                return data ? (
                  <StreamRow
                    key={stream.id}
                    row={data}
                    labels={labels}
                    trailing={writer ? <QuickReleaseForm spaceKey={space.key} streamId={stream.id} releases={plannedOptions} /> : null}
                  />
                ) : null;
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {writer ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('newStreamHeading')}</CardTitle>
              <CardDescription>{t('newStreamIntro')}</CardDescription>
            </CardHeader>
            <CardBody>
              <NewStreamForm spaceKey={space.key} releases={plannedOptions} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('newReleaseHeading')}</CardTitle>
              <CardDescription>{t('newReleaseIntro')}</CardDescription>
            </CardHeader>
            <CardBody>
              <NewReleaseForm spaceKey={space.key} />
            </CardBody>
          </Card>
        </div>
      ) : null}

      {releases.some((release) => release.state === 'shipped') ? (
        <details className="rounded-(--radius-base) border border-border p-4 text-sm">
          <summary className="cursor-pointer font-medium">{t('shippedHeading')}</summary>
          <ul className="mt-3 grid gap-3">
            {overview.releases
              .filter((entry) => entry.release.state === 'shipped')
              .map((entry) => (
                <li key={entry.release.id} className="grid gap-1">
                  <span className="font-medium">
                    {entry.release.name}{' '}
                    <span className="text-xs font-normal text-muted-foreground">{entry.release.shippedAt?.toISOString().slice(0, 10)}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{entry.streams.map((stream) => stream.title).join(', ') || '—'}</span>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
