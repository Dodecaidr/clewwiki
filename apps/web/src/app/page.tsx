import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getSessionContext } from '@/lib/session';
import { listSpaceSummaries } from '@/lib/spaces/service';
import { spaceHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { hasAnyUser } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  // A fresh instance has no accounts, so the first visit goes to setup. This is
  // the only path by which an administrator account comes into existence.
  if (!(await hasAnyUser())) {
    redirect('/setup');
  }

  const session = await getSessionContext();
  const t = await getTranslations('home');

  if (!session) {
    return (
      <div className="grid gap-8">
        <div className="grid gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="max-w-2xl text-muted-foreground">{t('tagline')}</p>
        </div>
        <Card>
          <CardBody className="text-sm text-muted-foreground">
            <p>
              {t('signedOutHint')}{' '}
              <Link href="/login" className="underline underline-offset-2 hover:text-foreground">
                {t('signInLink')}
              </Link>
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  const format = await getFormatter();
  const showArchived = (await searchParams).archived === '1';
  const isAdmin = session.role === 'admin';
  const spaces = await listSpaceSummaries(session.workspace.id, {
    includeArchived: showArchived,
    spaceIds: session.spaceIds,
  });

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">{t('spacesHeading')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('spacesIntro', { workspace: session.workspace.name })}
          </p>
        </div>
        {isAdmin ? (
          <Link href="/spaces/new" className={buttonVariants({ size: 'sm' })}>
            {t('createSpace')}
          </Link>
        ) : null}
      </div>

      {spaces.length === 0 ? (
        <Card>
          <CardBody className="grid justify-items-start gap-3 text-sm text-muted-foreground">
            <p>{isAdmin ? t('spacesEmptyAdmin') : t('spacesEmptyEditor')}</p>
            <Link href="/guide#spaces" className="underline underline-offset-2 hover:text-foreground">
              {t('readGuide')}
            </Link>
          </CardBody>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {spaces.map((space) => (
            <li key={space.id}>
              <Card className="h-full">
                <CardBody className="grid gap-2">
                  <div className="flex items-start gap-3">
                    {space.icon ? (
                      <span aria-hidden className="text-2xl leading-none">
                        {space.icon}
                      </span>
                    ) : null}
                    <div className="grid min-w-0 gap-0.5">
                      <Link
                        href={spaceHref(space.key)}
                        className="truncate font-semibold underline-offset-2 hover:underline"
                      >
                        {space.name}
                      </Link>
                      <span className="font-mono text-xs text-muted-foreground">
                        {space.key}
                        {space.archivedAt ? ` · ${t('archivedBadge')}` : ''}
                      </span>
                    </div>
                  </div>
                  {space.description ? (
                    <p className="line-clamp-3 text-sm text-muted-foreground">{space.description}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {t('pageCount', { count: space.pageCount })}
                    {' · '}
                    {space.lastUpdatedAt
                      ? t('lastUpdated', {
                          at: formatDateTime(format, space.lastUpdatedAt) ?? '—',
                          name:
                            space.lastUpdatedBy?.name ??
                            (space.lastUpdatedBy?.type === 'agent' ? t('someAgent') : t('someone')),
                        })
                      : t('neverUpdated')}
                  </p>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-4 text-sm">
        <Link
          href={showArchived ? '/' : '/?archived=1'}
          className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {showArchived ? t('hideArchived') : t('showArchived')}
        </Link>
        <Link href="/tokens" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
          {t('manageTokens')}
        </Link>
        <Link href="/connect" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
          {t('connectAgent')}
        </Link>
        <Link href="/guide" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
          {t('readGuide')}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('apiHeading')}</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 text-sm">
          <p className="text-muted-foreground">{t('apiIntro')}</p>
          <dl className="grid gap-3">
            <div>
              <dt className="font-mono text-xs">GET /api/v1/health</dt>
              <dd className="text-muted-foreground">{t('apiHealth')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET /api/v1/me</dt>
              <dd className="text-muted-foreground">{t('apiMe')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET, POST /api/v1/spaces</dt>
              <dd className="text-muted-foreground">{t('apiSpaces')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET, POST /api/v1/pages?space=KEY</dt>
              <dd className="text-muted-foreground">{t('apiPages')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">POST /api/v1/pages/&#123;id&#125;/claims</dt>
              <dd className="text-muted-foreground">{t('apiClaims')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET /api/v1/claims?space=KEY</dt>
              <dd className="text-muted-foreground">{t('apiPresence')}</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">GET /api/v1/search?q=&amp;space=KEY</dt>
              <dd className="text-muted-foreground">{t('apiSearch')}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
