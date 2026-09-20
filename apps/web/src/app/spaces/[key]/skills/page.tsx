import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { CopyBlock } from '@/components/copy-block';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { canWrite } from '@/lib/roles';
import { getAuthBaseUrl } from '@/lib/env';
import { getSessionContext } from '@/lib/session';
import { buildSkillsInstallCommand } from '@/lib/skills/install';
import { listSkills, listSkillTags } from '@/lib/skills/service';
import { newSpaceSkillHref, spaceSkillHref, spaceSkillsHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';
import { findSpaceByKey } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string }>; searchParams: Promise<{ tag?: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('skills');
  return { title: t('title') };
}

/**
 * A space's skills registry: the instruction packages this project publishes
 * for the agents that work on it, and the one command that puts them on a
 * machine.
 */
export default async function SpaceSkillsPage({ params, searchParams }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }
  const space = await findSpaceByKey(session, (await params).key);
  if (!space) {
    notFound();
  }

  const t = await getTranslations('skills');
  const format = await getFormatter();

  const tag = (await searchParams).tag?.trim().toLowerCase() || undefined;
  const [entries, tags] = await Promise.all([
    listSkills(session.workspace.id, space.id, { tag }),
    listSkillTags(session.workspace.id, space.id),
  ]);

  const installCommand = buildSkillsInstallCommand({
    baseUrl: getAuthBaseUrl(),
    spaceKey: space.key,
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        {space.archivedAt || !canWrite(session.role) ? null : (
          <Link href={newSpaceSkillHref(space.key)} className={buttonVariants({ size: 'sm' })}>
            {t('new')}
          </Link>
        )}
      </div>

      {entries.length > 0 || tag ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('installHeading')}</CardTitle>
            <CardDescription>{t('installIntro')}</CardDescription>
          </CardHeader>
          <CardBody>
            <CopyBlock code={installCommand} wrap />
          </CardBody>
        </Card>
      ) : null}

      {tags.length > 0 ? (
        <nav aria-label={t('tagsLabel')} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('tagsLabel')}:</span>
          <Link
            href={spaceSkillsHref(space.key)}
            className={`rounded-(--radius-base) border px-2 py-0.5 ${
              tag ? 'border-border hover:bg-secondary' : 'border-primary bg-primary text-primary-foreground'
            }`}
          >
            {t('tagAll')}
          </Link>
          {tags.map((entry) => (
            <Link
              key={entry}
              href={`${spaceSkillsHref(space.key)}?tag=${encodeURIComponent(entry)}`}
              className={`rounded-(--radius-base) border px-2 py-0.5 font-mono ${
                tag === entry
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:bg-secondary'
              }`}
            >
              {entry}
            </Link>
          ))}
        </nav>
      ) : null}

      {entries.length === 0 ? (
        <Card>
          <CardBody className="grid justify-items-start gap-4 text-sm">
            <p className="text-muted-foreground">{tag ? t('emptyForTag', { tag }) : t('empty')}</p>
            <div className="flex flex-wrap items-center gap-4">
              {space.archivedAt || !canWrite(session.role) ? null : (
                <Link href={newSpaceSkillHref(space.key)} className={buttonVariants({ size: 'sm' })}>
                  {t('new')}
                </Link>
              )}
              <Link
                href="/guide#rules-and-skills"
                className="text-sm underline underline-offset-2 hover:text-foreground"
              >
                {t('whatIsThis')}
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {entries.map((skill) => (
            <li key={skill.slug}>
              <Card>
                <CardBody className="grid gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      href={spaceSkillHref(space.key, skill.slug)}
                      className="text-base font-semibold underline-offset-2 hover:underline"
                    >
                      {skill.name}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">
                      {skill.slug}
                      {skill.version ? ` · ${skill.version}` : ''}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{skill.description}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {skill.tags.map((entry) => (
                      <span
                        key={entry}
                        className="rounded-(--radius-base) border border-border px-2 py-0.5 font-mono"
                      >
                        {entry}
                      </span>
                    ))}
                    <span>
                      {t('updatedLabel')}: {formatDateTime(format, skill.updatedAt)}
                    </span>
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
