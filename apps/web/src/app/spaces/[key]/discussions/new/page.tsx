import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { OpenDiscussionForm } from '../open-form';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { readDiscussionPolicy } from '@/lib/discussions/retention';
import { getPageById } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { getSpaceByKey } from '@/lib/spaces/service';
import { spaceDiscussionsHref } from '@/lib/spaces/urls';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string }>; searchParams: Promise<{ page?: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('discussions');
  return { title: t('createTitle') };
}

/**
 * Opening a discussion. The `page` query parameter prefills what the thread is
 * about, which is how the button on a page view carries its context across.
 */
export default async function NewDiscussionPage({ params, searchParams }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await getSpaceByKey(session.workspace.id, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('discussions');
  const policy = readDiscussionPolicy(space.settings);

  const requested = (await searchParams).page;
  // A page from another space, or one that has been deleted, simply does not
  // prefill: the thread is still worth opening.
  const about = requested ? await getPageById(session.workspace.id, requested) : null;
  const page = about && about.spaceId === space.id && about.deletedAt === null ? about : null;

  if (space.archivedAt !== null) {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('createTitle')}</h1>
        <Alert tone="info">{t('archivedNoNew')}</Alert>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('createTitle')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('createIntro')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('createFormHeading')}</CardTitle>
          <CardDescription>
            {t('retentionSummary', {
              idleDays: policy.idleDays,
              retentionDays: policy.retentionDays,
            })}
          </CardDescription>
        </CardHeader>
        <CardBody>
          <OpenDiscussionForm
            spaceKey={space.key}
            pageId={page?.id ?? null}
            pageTitle={page?.title ?? null}
            cancelHref={spaceDiscussionsHref(space.key)}
          />
        </CardBody>
      </Card>
    </div>
  );
}
