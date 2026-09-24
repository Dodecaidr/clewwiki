import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ImportReview } from './review';
import type { ReviewItem } from './review';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { listImportItems, previewImport } from '@/lib/imports/service';
import { getSessionContext } from '@/lib/session';
import { spaceImportHref, spaceImportRunHref, spacePageHref } from '@/lib/spaces/urls';
import { findPage, findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string; id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('imports');
  return { title: t('reviewTitle') };
}

/**
 * One import.
 *
 * The same address serves three states, because they are three stages of one
 * thing: the review while it waits, a note while it runs, and the result once
 * it has been applied — every page created, with a link, and everything skipped
 * with the reason it was skipped.
 */
export default async function ImportRunPage({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const { key, id } = await params;
  const space = await findSpaceByKey(session, key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('imports');

  if (session.role !== 'admin' && session.role !== 'editor') {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('reviewTitle')}</h1>
        <Alert tone="info">{t('editorOnly')}</Alert>
      </div>
    );
  }

  const preview = await previewImport(session.workspace.id, id).catch(() => null);
  if (!preview || preview.import.spaceId !== space.id) {
    notFound();
  }

  const header = (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t('reviewTitle')}</h1>
      <p className="text-sm text-muted-foreground">
        {t(`source_${preview.import.source}`)} · {t(`status_${preview.import.status}`)}
      </p>
      <Link
        href={spaceImportHref(space.key)}
        className="justify-self-start text-sm underline underline-offset-2"
      >
        {t('backToImports')}
      </Link>
    </div>
  );

  if (preview.import.status === 'failed') {
    return (
      <div className="grid gap-6">
        {header}
        <Alert tone="error">{preview.import.error ?? t('errorGeneric')}</Alert>
      </div>
    );
  }

  if (preview.import.status === 'running' || preview.import.status === 'pending') {
    return (
      <div className="grid gap-6">
        {header}
        <Alert tone="info">{t('running')}</Alert>
      </div>
    );
  }

  if (preview.import.status === 'cancelled') {
    return (
      <div className="grid gap-6">
        {header}
        <Alert tone="info">{t('cancelled')}</Alert>
      </div>
    );
  }

  if (preview.import.status === 'applied') {
    const items = await listImportItems(preview.import.id);
    const created = items.filter((item) => item.createdPageId !== null);
    const skipped = items.filter((item) => item.createdPageId === null);
    const titles = new Map<string, string>();
    for (const item of created) {
      const page = item.createdPageId ? await findPage(session, item.createdPageId) : null;
      if (page) titles.set(item.id, page.title);
    }

    return (
      <div className="grid gap-6">
        {header}
        <Card>
          <CardHeader>
            <CardTitle>{t('resultCreated', { count: created.length })}</CardTitle>
          </CardHeader>
          <CardBody>
            {created.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('resultNothing')}</p>
            ) : (
              <ul className="grid gap-2 text-sm">
                {created.map((item) => (
                  <li key={item.id} className="grid gap-0.5">
                    <Link
                      href={spacePageHref(space.key, item.createdPageId ?? '')}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {titles.get(item.id) ?? item.title}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">{item.targetPath}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {skipped.length === 0 ? null : (
          <Card>
            <CardHeader>
              <CardTitle>{t('resultSkipped', { count: skipped.length })}</CardTitle>
              <CardDescription>{t('resultSkippedIntro')}</CardDescription>
            </CardHeader>
            <CardBody>
              <ul className="grid gap-2 text-sm">
                {skipped.map((item) => (
                  <li key={item.id} className="grid gap-0.5">
                    <span className="font-medium">{item.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">{item.targetPath}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.decision === 'skip' ? t('skipReasonDecision') : t('skipReasonBlocked')}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Link href={`/spaces/${encodeURIComponent(space.key)}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('backToSpace')}
        </Link>
      </div>
    );
  }

  // `needs_review`: the tree, the warnings, and the decisions.
  const depths = new Map<string, number>();
  const items: ReviewItem[] = preview.items.map((item) => {
    const depth = item.parentSourceId === null ? 0 : (depths.get(item.parentSourceId) ?? 0) + 1;
    depths.set(item.sourceId, depth);
    return {
      id: item.id,
      sourceId: item.sourceId,
      parentSourceId: item.parentSourceId,
      title: item.title,
      targetPath: item.targetPath,
      decision: item.decision,
      warnings: item.warnings,
      markdown: item.preview,
      conflictPageId: item.conflictPageId,
      claimedBy: item.claimedBy,
      depth,
    };
  });

  return (
    <div className="grid gap-6">
      {header}
      <Alert tone="info">
        {t('reviewIntro', {
          parsed: preview.items.length,
          conflicts: preview.counts.conflicts,
          warnings: preview.items.reduce((total, item) => total + item.warnings.length, 0),
          images: Number(preview.import.stats['images'] ?? 0),
          files: Number(preview.import.stats['files'] ?? 0),
          versions: Number(preview.import.stats['file_versions'] ?? 0),
        })}
      </Alert>
      {preview.import.source === 'pdf' ? <Alert tone="info">{t('pdfNotice')}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('treeHeading')}</CardTitle>
          <CardDescription>{t('treeIntro')}</CardDescription>
        </CardHeader>
        <CardBody>
          <ImportReview
            importId={preview.import.id}
            items={items}
            resultHref={spaceImportRunHref(space.key, preview.import.id)}
          />
        </CardBody>
      </Card>
    </div>
  );
}
