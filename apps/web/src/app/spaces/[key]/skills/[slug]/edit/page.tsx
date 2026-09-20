import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { SkillForm } from '../../skill-form';
import { canWrite } from '@/lib/roles';
import { getSessionContext } from '@/lib/session';
import { getSkillBySlug } from '@/lib/skills/service';
import { spaceHref, spaceSkillHref } from '@/lib/spaces/urls';
import { findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string; slug: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('skills');
  return { title: t('editTitle') };
}

/** Editing a skill. The same form as creating one, with the fields filled in. */
export default async function EditSkillPage({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const { key, slug } = await params;
  const space = await findSpaceByKey(session, key);
  if (!space) {
    notFound();
  }

  // A viewer has no business on a screen that writes. The action behind it
  // would refuse them anyway; this saves them filling in a form to find out.
  if (!canWrite(session.role)) {
    redirect(spaceHref(space.key));
  }
  const skill = await getSkillBySlug(session.workspace.id, space.id, slug);
  if (!skill) {
    notFound();
  }

  const t = await getTranslations('skills');

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('editTitle')}</h1>
        <p className="font-mono text-xs text-muted-foreground">{skill.slug}</p>
      </div>
      <SkillForm
        mode="edit"
        spaceKey={space.key}
        initial={{
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          version: skill.version ?? '',
          tags: skill.tags.join(', '),
          body: skill.body,
        }}
        cancelHref={spaceSkillHref(space.key, skill.slug)}
      />
    </div>
  );
}
