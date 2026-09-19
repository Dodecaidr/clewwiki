import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { SkillForm } from '../skill-form';
import { Alert } from '@/components/ui/card';
import { getSessionContext } from '@/lib/session';
import { spaceSkillsHref } from '@/lib/spaces/urls';
import { findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('skills');
  return { title: t('createTitle') };
}

/** Writing a new skill: the fields of its front matter, then its instructions. */
export default async function NewSkillPage({ params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await findSpaceByKey(session, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('skills');

  if (space.archivedAt !== null) {
    return (
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('createTitle')}</h1>
        <Alert tone="info">{t('archivedNoNewSkills')}</Alert>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('createTitle')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('createIntro')}</p>
      </div>
      <SkillForm
        mode="create"
        spaceKey={space.key}
        initial={{ slug: '', name: '', description: '', version: '', tags: '', body: '' }}
        cancelHref={spaceSkillsHref(space.key)}
      />
    </div>
  );
}
