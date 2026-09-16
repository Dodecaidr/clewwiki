import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import Link from 'next/link';

import { PageForm } from '../../page-form';
import { buttonVariants } from '@/components/ui/button';
import { Alert, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { getActiveClaimsForPage } from '@/lib/claims/service';
import { getPageById, listPages } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';
import { assertSameWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('editor');
  return { title: t('editTitle') };
}

export default async function EditPage({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    notFound();
  }

  const page = await getPageById(session.workspace.id, id);
  if (!page) {
    notFound();
  }
  assertSameWorkspace(session.workspace.id, page.workspaceId);

  const t = await getTranslations('editor');
  const [candidates, activeClaims] = await Promise.all([
    listPages(session.workspace.id, { limit: 500 }),
    getActiveClaimsForPage(session.workspace.id, page.id),
  ]);

  // Whoever holds the page decides whether this screen is an editor at all.
  // The form takes its own lease when it mounts and would find this out a
  // moment later anyway; deciding here means the author is told before typing
  // rather than after.
  const heldByOther = activeClaims.find(
    (claim) => claim.holderType !== 'user' || claim.holderId !== session.userId,
  );

  if (heldByOther) {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('editTitle')}</h1>
        <Alert tone="error">
          {t('claimHeldByOther', {
            name: heldByOther.holderLabel,
            since: formatDateTime(heldByOther.createdAt) ?? '—',
          })}
        </Alert>
        <Card>
          <CardHeader>
            <CardTitle>{page.title}</CardTitle>
          </CardHeader>
          <CardBody className="grid justify-items-start gap-4">
            <p className="text-sm text-muted-foreground">{t('claimBlockedHint')}</p>
            <Link
              href={`/pages/${page.id}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('claimReadOnly')}
            </Link>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('editTitle')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{page.title}</CardTitle>
        </CardHeader>
        <CardBody>
          <PageForm
            mode="edit"
            cancelHref={`/pages/${page.id}`}
            parents={candidates
              // A page cannot be its own parent, and the subtree check that
              // catches a deeper cycle lives in the service.
              .filter((candidate) => candidate.id !== page.id)
              .map((candidate) => ({
                id: candidate.id,
                title: candidate.title,
                path: candidate.path,
              }))}
            initial={{
              pageId: page.id,
              // Carried through the form so the save is refused if someone
              // else writes to the page while it is open.
              baseContentHash: page.contentHash,
              title: page.title,
              path: page.path,
              parentId: page.parentId ?? '',
              kind: page.kind,
              summary: page.summary ?? '',
              body: page.body,
            }}
          />
        </CardBody>
      </Card>
    </div>
  );
}
