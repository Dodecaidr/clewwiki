import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { PageBody } from '@/components/page-body';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { renderMarkdown } from '@/lib/pages/markdown';
import { renderLabels } from '@/lib/pages/render-labels';
import { getPageById, listPages } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { getSpaceByKey } from '@/lib/spaces/service';
import { newSpacePageHref, spacePageHref, spaceRulesHref, spaceSkillsHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const session = await getSessionContext();
  if (!session) return { title: 'clewwiki' };
  const space = await getSpaceByKey(session.workspace.id, (await params).key);
  return { title: space?.name ?? 'clewwiki' };
}

/**
 * The space overview: the home page when one is chosen, otherwise the space's
 * description and what changed in it recently.
 */
export default async function SpaceOverview({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await getSpaceByKey(session.workspace.id, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('spaces');
  const tp = await getTranslations('pages');
  const trules = await getTranslations('rules');
  const tsk = await getTranslations('skills');
  const format = await getFormatter();

  /**
   * The two things an agent is told to read before it starts. They are on the
   * overview as well as in the sidebar because the overview is where a person
   * lands, and "where are this project's rules" is the first question a new
   * contributor — human or not — has.
   */
  const orientation = (
    <div className="flex flex-wrap gap-2">
      <Link
        href={spaceRulesHref(space.key)}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        {trules('title')}
      </Link>
      <Link
        href={spaceSkillsHref(space.key)}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        {tsk('title')}
      </Link>
    </div>
  );

  // A home page that has since been deleted is treated as no home page.
  const home = space.homePageId ? await getPageById(session.workspace.id, space.homePageId) : null;
  const homePage = home && home.spaceId === space.id ? home : null;

  if (homePage) {
    const html = await renderMarkdown(homePage.body, await renderLabels());
    return (
      <article className="grid gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <h1 className="text-2xl font-semibold tracking-tight">{homePage.title}</h1>
          <div className="flex flex-wrap gap-2">
            {orientation}
            <Link
              href={spacePageHref(space.key, homePage.id)}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('openHomePage')}
            </Link>
          </div>
        </header>
        {homePage.body.trim() === '' ? (
          <p className="text-sm text-muted-foreground">{tp('emptyBody')}</p>
        ) : (
          <PageBody html={html} />
        )}
      </article>
    );
  }

  const [descriptionHtml, recent] = await Promise.all([
    space.description.trim() === '' ? Promise.resolve('') : renderMarkdown(space.description),
    listPages(session.workspace.id, { spaceId: space.id, orderBy: 'updated', limit: 10 }),
  ]);

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{space.name}</h1>
        {descriptionHtml ? (
          <PageBody html={descriptionHtml} />
        ) : (
          <p className="max-w-2xl text-sm text-muted-foreground">{t('noDescription')}</p>
        )}
        {orientation}
      </div>

      {recent.length === 0 ? (
        <Card>
          <CardBody className="grid justify-items-start gap-4 text-sm">
            <p className="text-muted-foreground">{t('emptyIntro')}</p>
            <div className="flex flex-wrap items-center gap-4">
              {space.archivedAt ? null : (
                <Link href={newSpacePageHref(space.key)} className={buttonVariants({ size: 'sm' })}>
                  {tp('new')}
                </Link>
              )}
              <Link href="/guide#spaces" className="text-sm underline underline-offset-2 hover:text-foreground">
                {tp('whatIsThis')}
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{tp('recentHeading')}</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="grid gap-3 text-sm">
              {recent.map((page) => (
                <li key={page.id} className="grid gap-0.5">
                  <Link
                    href={spacePageHref(space.key, page.id)}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {page.title}
                  </Link>
                  <span className="font-mono text-xs text-muted-foreground">{page.path}</span>
                  <span className="text-xs text-muted-foreground">
                    {tp('kindLabel')}: {tp(`kind_${page.kind}`)} · {tp('updatedLabel')}:{' '}
                    {formatDateTime(format, page.updatedAt)}
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
