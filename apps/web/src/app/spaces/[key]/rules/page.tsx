import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { CopyBlock } from '@/components/copy-block';
import { PageBody } from '@/components/page-body';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getAuthBaseUrl } from '@/lib/env';
import { renderMarkdown } from '@/lib/pages/markdown';
import { renderLabels } from '@/lib/pages/render-labels';
import { getPageById } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { getSpaceByKey } from '@/lib/spaces/service';
import { spacePageEditHref, spacePageHref, spaceSettingsHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('rules');
  return { title: t('title') };
}

/**
 * The working rules of a space, as a page of their own.
 *
 * The address exists whether or not a page has been designated, so the sidebar
 * always has somewhere to point and a reader who follows it is told what is
 * missing rather than meeting a 404. What is shown is the designated page's
 * body, rendered like any other page — this view reads it, it does not own it.
 */
export default async function SpaceRulesPage({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await getSpaceByKey(session.workspace.id, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('rules');
  const tp = await getTranslations('pages');
  const format = await getFormatter();

  const designated = space.rulesPageId
    ? await getPageById(session.workspace.id, space.rulesPageId)
    : null;
  const page = designated && designated.spaceId === space.id ? designated : null;

  const agentCall = `wiki.get_rules { "space": "${space.key}" }`;
  const restCall = `curl -H "Authorization: Bearer $CLEWWIKI_TOKEN" ${getAuthBaseUrl()}/api/v1/spaces/${space.key}/rules`;

  if (!page) {
    return (
      <div className="grid gap-6">
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t('emptyHeading')}</CardTitle>
            <CardDescription>{t('emptyIntro')}</CardDescription>
          </CardHeader>
          <CardBody className="grid justify-items-start gap-3 text-sm">
            {session.role === 'admin' ? (
              <Link
                href={`${spaceSettingsHref(space.key)}#rules`}
                className={buttonVariants({ size: 'sm' })}
              >
                {t('setUp')}
              </Link>
            ) : (
              <p className="text-muted-foreground">{t('emptyEditor')}</p>
            )}
          </CardBody>
        </Card>
      </div>
    );
  }

  const html = await renderMarkdown(page.body, await renderLabels());

  return (
    <article className="grid gap-5">
      <header className="grid gap-3 border-b border-border pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
            <p className="text-xs text-muted-foreground">
              {t('updatedAt', { at: formatDateTime(format, page.updatedAt) ?? '—' })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={spacePageHref(space.key, page.id)}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('openPage')}
            </Link>
            <Link
              href={spacePageEditHref(space.key, page.id)}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {tp('edit')}
            </Link>
          </div>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
      </header>

      {page.body.trim() === '' ? (
        <p className="text-sm text-muted-foreground">{t('emptyBody')}</p>
      ) : (
        <PageBody html={html} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('howAgentsReadIt')}</CardTitle>
          <CardDescription>{t('howAgentsReadItIntro')}</CardDescription>
        </CardHeader>
        <CardBody className="grid gap-4">
          <CopyBlock code={agentCall} label={t('mcpLabel')} />
          <CopyBlock code={restCall} label={t('restLabel')} wrap />
        </CardBody>
      </Card>
    </article>
  );
}
