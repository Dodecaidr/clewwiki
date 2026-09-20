import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { buttonVariants } from '@/components/ui/button';
import { Alert, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { canWrite } from '@/lib/roles';
import { lastSegment } from '@/lib/pages/paths';
import { getPageTree } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { normalizeSpaceKey } from '@/lib/spaces/keys';
import { flattenTree, subtreeIds } from '@/lib/spaces/tree';
import { spaceHref, spacePageHref, spacePageMoveHref } from '@/lib/spaces/urls';
import { findPage, findSpaceById, findSpaces } from '@/lib/spaces/visibility';
import { assertSameWorkspace } from '@/lib/workspace';

import { MovePageForm } from './move-form';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ key: string; id: string }>;
  searchParams: Promise<{ to?: string | string[] }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('movePage');
  return { title: t('title') };
}

/**
 * Moving a page to another space, in two steps that both work without a script:
 * choosing the space is a GET that comes back to this screen, and only then is
 * that space's tree read and offered as the place to put the page.
 */
export default async function MovePage({ params, searchParams }: Props) {
  const session = await getSessionContext();
  if (!session) redirect('/login');

  const { key, id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();

  const page = await findPage(session, id);
  if (!page) notFound();
  assertSameWorkspace(session.workspace.id, page.workspaceId);
  const space = await findSpaceById(session, page.spaceId);
  if (!space) notFound();

  // A viewer has no business on a screen that writes. The action behind it
  // would refuse them anyway; this saves them filling in a form to find out.
  if (!canWrite(session.role)) {
    redirect(spaceHref(space.key));
  }

  const { to } = await searchParams;
  const wanted = typeof to === 'string' ? normalizeSpaceKey(to) : '';
  if (key !== space.key) redirect(spacePageMoveHref(space.key, page.id, wanted || undefined));

  const t = await getTranslations('movePage');

  // Only spaces this person can see, and only ones that still take pages.
  const candidates = (await findSpaces(session)).filter((candidate) => candidate.id !== space.id);
  const target = candidates.find((candidate) => candidate.key === wanted) ?? null;

  const [sourceTree, targetTree] = await Promise.all([
    getPageTree(session.workspace.id, space.id),
    target ? getPageTree(session.workspace.id, target.id) : Promise.resolve([]),
  ]);
  const below = subtreeIds(sourceTree, page.id).size - 1;
  const backHref = spacePageHref(space.key, page.id);

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{page.title}</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-6">
          <p className="text-sm text-muted-foreground">
            {t('summary', { space: space.name, path: page.path, below })}
          </p>

          {candidates.length === 0 ? (
            <>
              <Alert tone="info">{t('noOtherSpace')}</Alert>
              <Link href={backHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {t('cancel')}
              </Link>
            </>
          ) : (
            <>
              {/* The hint sits under the row, not inside the field, so the
                  button lines up with the select rather than with the hint. */}
              <form method="get" className="grid gap-1.5">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                  <Field label={t('space')} htmlFor="to">
                    <Select id="to" name="to" defaultValue={target?.key ?? ''} required>
                      <option value="" disabled>
                        {t('spacePlaceholder')}
                      </option>
                      {candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.key}>
                          {`${candidate.name} (${candidate.key})`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <button type="submit" className={buttonVariants({ variant: 'outline' })}>
                    {target ? t('changeSpace') : t('chooseSpace')}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">{t('spaceHint')}</p>
              </form>

              {target ? (
                <MovePageForm
                  pageId={page.id}
                  spaceKey={target.key}
                  spaceName={target.name}
                  segment={lastSegment(page.path)}
                  parents={flattenTree(targetTree)}
                  cancelHref={backHref}
                />
              ) : (
                <Link href={backHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  {t('cancel')}
                </Link>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
