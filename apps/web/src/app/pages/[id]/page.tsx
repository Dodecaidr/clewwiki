import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { DeletePageButton } from './delete-button';
import { PageBody } from '@/components/page-body';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { renderMarkdown } from '@/lib/pages/markdown';
import { getPageById, listRevisions } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { assertSameWorkspace } from '@/lib/workspace';
import { cn, formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadPage(id: string) {
  const session = await getSessionContext();
  if (!session) return null;
  if (!UUID_PATTERN.test(id)) return null;

  const page = await getPageById(session.workspace.id, id);
  if (!page) return null;

  // The query already scoped to the workspace; this re-asserts it on the row
  // about to be rendered, so a change to the query cannot quietly widen what
  // this screen shows.
  assertSameWorkspace(session.workspace.id, page.workspaceId);
  return { session, page };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const loaded = await loadPage((await params).id);
  return { title: loaded?.page.title ?? 'clewwiki' };
}

export default async function PageView({ params }: Props) {
  const { id } = await params;
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const loaded = await loadPage(id);
  if (!loaded) {
    notFound();
  }

  const { page } = loaded;
  const t = await getTranslations('pages');

  const [html, linked, revisions] = await Promise.all([
    renderMarkdown(page.body),
    page.linkedPageId ? getPageById(session.workspace.id, page.linkedPageId) : Promise.resolve(null),
    listRevisions(session.workspace.id, page.id, 5),
  ]);

  return (
    <article className="grid gap-6">
      <header className="grid gap-3 border-b border-border pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
            <p className="font-mono text-xs text-muted-foreground">{page.path}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/pages/${page.id}/edit`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('edit')}
            </Link>

            {/* A details/summary menu: two links, and nothing that needs to
                load before the reader can use them. */}
            <details className="relative">
              <summary
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'cursor-pointer list-none',
                )}
              >
                {t('export')}
              </summary>
              <div className="absolute right-0 z-10 mt-1 grid w-40 gap-1 rounded-(--radius-base) border border-border bg-card p-1 text-sm shadow-sm">
                <a
                  className="rounded-(--radius-base) px-2 py-1.5 hover:bg-secondary"
                  href={`/api/v1/export/${page.id}?format=md`}
                >
                  {t('exportMarkdown')}
                </a>
                <a
                  className="rounded-(--radius-base) px-2 py-1.5 hover:bg-secondary"
                  href={`/api/v1/export/${page.id}?format=html`}
                >
                  {t('exportHtml')}
                </a>
              </div>
            </details>

            <DeletePageButton pageId={page.id} label={t('delete')} confirm={t('deleteConfirm')} />
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <div className="flex gap-1">
            <dt>{t('kindLabel')}:</dt>
            <dd className="font-medium text-foreground">{t(`kind_${page.kind}`)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('versionLabel')}:</dt>
            <dd className="font-medium text-foreground">{page.version}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('updatedLabel')}:</dt>
            <dd className="font-medium text-foreground">{formatDateTime(page.updatedAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('updatedByLabel')}:</dt>
            <dd className="font-medium text-foreground">
              {page.updatedByType === 'agent' ? t('actorAgent') : t('actorUser')}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('linkedLabel')}:</dt>
            <dd>
              {linked ? (
                <Link
                  href={`/pages/${linked.id}`}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  {linked.title}
                </Link>
              ) : (
                <span>{t('linkedNone')}</span>
              )}
            </dd>
          </div>
        </dl>

        {page.summary ? <p className="text-sm text-muted-foreground">{page.summary}</p> : null}
      </header>

      {page.body.trim() === '' ? (
        <p className="text-sm text-muted-foreground">{t('emptyBody')}</p>
      ) : (
        <PageBody html={html} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('historyHeading')}</CardTitle>
        </CardHeader>
        <CardBody>
          <ul className="grid gap-2 text-sm">
            {revisions.map((revision) => (
              <li key={revision.version} className="flex flex-wrap gap-x-3 text-muted-foreground">
                <span className="font-medium text-foreground">v{revision.version}</span>
                <span>{formatDateTime(revision.createdAt)}</span>
                <span>{revision.authorType === 'agent' ? t('actorAgent') : t('actorUser')}</span>
                <span className="font-mono text-xs">{revision.contentHash.slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </article>
  );
}
