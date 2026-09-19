import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ImportForm } from './import-form';
import { getImportMaxUploadMb } from '@/lib/env';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listImports } from '@/lib/imports/service';
import { getSessionContext } from '@/lib/session';
import { spaceImportHref, spaceImportRunHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('imports');
  return { title: t('title') };
}

/**
 * Bringing documentation in from somewhere else.
 *
 * The page is deliberately two things at once: the form that starts an import,
 * and the list of the ones already run. An import is not instantaneous and it
 * is not automatic — it waits for a review — so a person who started one
 * yesterday needs somewhere to come back to.
 */
export default async function SpaceImportPage({ params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await findSpaceByKey(session, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('imports');
  const format = await getFormatter();

  if (session.role !== 'admin' && session.role !== 'editor') {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <Alert tone="info">{t('editorOnly')}</Alert>
      </div>
    );
  }

  if (space.archivedAt !== null) {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <Alert tone="info">{t('archived')}</Alert>
      </div>
    );
  }

  const previous = await listImports(session.workspace.id, { spaceId: space.id, limit: 10 });

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('stagedNotice')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('formHeading')}</CardTitle>
          <CardDescription>{t('formIntro')}</CardDescription>
        </CardHeader>
        <CardBody>
          <ImportForm
            spaceKey={space.key}
            reviewBase={spaceImportHref(space.key)}
            uploadLimitMb={getImportMaxUploadMb()}
          />
        </CardBody>
      </Card>

      {previous.length === 0 ? null : (
        <Card>
          <CardHeader>
            <CardTitle>{t('previousHeading')}</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="grid gap-3 text-sm">
              {previous.map((record) => (
                <li key={record.id} className="grid gap-0.5">
                  <Link
                    href={spaceImportRunHref(space.key, record.id)}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {t(`source_${record.source}`)} · {t(`status_${record.status}`)}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(format, record.createdAt)}
                    {typeof record.stats['parsed'] === 'number'
                      ? ` · ${t('parsedCount', { count: record.stats['parsed'] })}`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
