import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { DeleteSkillButton } from './delete-skill-button';
import { CopyBlock } from '@/components/copy-block';
import { PageBody } from '@/components/page-body';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getAuthBaseUrl } from '@/lib/env';
import { renderMarkdown } from '@/lib/pages/markdown';
import { renderLabels } from '@/lib/pages/render-labels';
import { getSessionContext } from '@/lib/session';
import { buildSkillsInstallCommand, skillInstallPath } from '@/lib/skills/install';
import { skillMarkdown } from '@/lib/skills/serialize';
import { getSkillBySlug } from '@/lib/skills/service';
import { spaceSkillEditHref, spaceSkillsHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const session = await getSessionContext();
  if (!session) return { title: 'clewwiki' };
  const { key, slug } = await params;
  const space = await findSpaceByKey(session, key);
  if (!space) return { title: 'clewwiki' };
  const skill = await getSkillBySlug(session.workspace.id, space.id, slug);
  return { title: skill?.name ?? 'clewwiki' };
}

/**
 * One skill: what it is, the instructions in it, and the two ways to take it
 * away with you — the assembled `SKILL.md` to paste, or the command that writes
 * it where an agent host will find it.
 */
export default async function SkillPage({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const { key, slug } = await params;
  const space = await findSpaceByKey(session, key);
  if (!space) {
    notFound();
  }
  const skill = await getSkillBySlug(session.workspace.id, space.id, slug);
  if (!skill) {
    notFound();
  }

  const t = await getTranslations('skills');
  const tp = await getTranslations('pages');
  const format = await getFormatter();

  const html = await renderMarkdown(skill.body, await renderLabels());
  const markdown = skillMarkdown(skill);
  const command = buildSkillsInstallCommand({
    baseUrl: getAuthBaseUrl(),
    spaceKey: space.key,
    slug: skill.slug,
  });

  return (
    <article className="grid gap-5">
      <header className="grid gap-3 border-b border-border pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{skill.name}</h1>
            <p className="font-mono text-xs text-muted-foreground">
              {skill.slug}
              {skill.version ? ` · ${skill.version}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={spaceSkillsHref(space.key)}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              {t('backToList')}
            </Link>
            <Link
              href={spaceSkillEditHref(space.key, skill.slug)}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {tp('edit')}
            </Link>
          </div>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{skill.description}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {skill.tags.map((tag) => (
            <Link
              key={tag}
              href={`${spaceSkillsHref(space.key)}?tag=${encodeURIComponent(tag)}`}
              className="rounded-(--radius-base) border border-border px-2 py-0.5 font-mono hover:bg-secondary"
            >
              {tag}
            </Link>
          ))}
          <span>
            {t('updatedLabel')}: {formatDateTime(format, skill.updatedAt)}
          </span>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t('installHeading')}</CardTitle>
          <CardDescription>
            {t('installOneIntro', { path: skillInstallPath(skill.slug) })}
          </CardDescription>
        </CardHeader>
        <CardBody className="grid gap-4">
          <CopyBlock code={command} wrap />
          <CopyBlock code={markdown} label={t('copySkillMd')} wrap />
        </CardBody>
      </Card>

      {skill.body.trim() === '' ? (
        <p className="text-sm text-muted-foreground">{t('emptyBody')}</p>
      ) : (
        <PageBody html={html} />
      )}

      {session.role === 'admin' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('deleteHeading')}</CardTitle>
            <CardDescription>{t('deleteIntro')}</CardDescription>
          </CardHeader>
          <CardBody>
            <DeleteSkillButton
              spaceKey={space.key}
              slug={skill.slug}
              label={t('delete')}
              confirm={t('deleteConfirm')}
            />
          </CardBody>
        </Card>
      ) : null}
    </article>
  );
}
