import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ComposeMessage, DeleteDiscussionButton, ResolveForm } from './thread-forms';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { isLocale } from '@/i18n/locale';
import type { Locale } from '@/i18n/locale';
import { buttonVariants } from '@/components/ui/button';
import { Alert, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { decisionsParentTemplate } from '@/lib/discussions/decision-page';
import { readDiscussionPolicy } from '@/lib/discussions/retention';
import { getDiscussionThread, wasClosedForInactivity } from '@/lib/discussions/service';
import { getPageById } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { getSpaceById } from '@/lib/spaces/service';
import { spaceDiscussionsHref, spaceHref, spacePageHref } from '@/lib/spaces/urls';
import { formatDateTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ key: string; id: string }> };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const session = await getSessionContext();
  if (!session) return { title: 'clewwiki' };
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return { title: 'clewwiki' };
  const thread = await getDiscussionThread(session.workspace.id, id);
  return { title: thread?.discussion.title ?? 'clewwiki' };
}

/**
 * One thread.
 *
 * Message bodies are rendered as the text somebody typed — `whitespace-pre-wrap`
 * and nothing else — not as Markdown. A discussion is where agents write to each
 * other, so it is the last place that should turn what one of them wrote into
 * markup the page then executes for a reader; and a note is a note.
 *
 * There are no live updates and the page says so. A discussion moves at the
 * speed of the work it is about; reload to see new messages.
 */
export default async function DiscussionThreadPage({ params }: Props) {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const { key, id } = await params;
  if (!UUID_PATTERN.test(id)) {
    notFound();
  }

  const thread = await getDiscussionThread(session.workspace.id, id);
  if (!thread) {
    notFound();
  }

  const space = await getSpaceById(session.workspace.id, thread.discussion.spaceId);
  if (!space) {
    notFound();
  }
  if (key !== space.key) {
    redirect(`${spaceDiscussionsHref(space.key)}/${thread.discussion.id}`);
  }

  const t = await getTranslations('discussions');
  const format = await getFormatter();
  const active = await getLocale();
  const locale: Locale = isLocale(active) ? active : 'en';
  const policy = readDiscussionPolicy(space.settings);

  const about = thread.discussion.pageId
    ? await getPageById(session.workspace.id, thread.discussion.pageId)
    : null;
  const decisionPage = thread.discussion.decisionPageId
    ? await getPageById(session.workspace.id, thread.discussion.decisionPageId)
    : null;
  const decisionsParent = policy.decisionsPageId
    ? await getPageById(session.workspace.id, policy.decisionsPageId)
    : null;

  const isOpener =
    thread.discussion.openedByType === 'user' &&
    thread.discussion.openedById === session.userId;
  const mayDelete = session.role === 'admin' || isOpener;
  const closedIdle = wasClosedForInactivity(thread.discussion);

  return (
    <article className="grid gap-6">
      <header className="grid gap-3 border-b border-border pb-5">
        <Breadcrumbs
          label={t('breadcrumbLabel')}
          items={[
            { label: space.name, href: spaceHref(space.key) },
            { label: t('title'), href: spaceDiscussionsHref(space.key) },
            { label: thread.discussion.title },
          ]}
        />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{thread.discussion.title}</h1>
          <span
            className={`rounded-(--radius-base) border px-2 py-0.5 text-xs ${
              thread.discussion.status === 'open'
                ? 'border-primary text-foreground'
                : 'border-border text-muted-foreground'
            }`}
          >
            {thread.discussion.status === 'open' ? t('statusOpen') : t('statusResolved')}
          </span>
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <div className="flex gap-1">
            <dt>{t('openedByLabel')}:</dt>
            <dd className="font-medium text-foreground">{thread.discussion.openedByLabel}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('openedAtLabel')}:</dt>
            <dd>{formatDateTime(format, thread.discussion.createdAt)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('messagesLabel')}:</dt>
            <dd>{thread.discussion.messageCount}</dd>
          </div>
          {about ? (
            <div className="flex gap-1">
              <dt>{t('aboutLabel')}:</dt>
              <dd>
                <Link
                  href={spacePageHref(space.key, about.id)}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  {about.title}
                </Link>
                {thread.discussion.sectionId ? ` · ${thread.discussion.sectionId}` : ''}
              </dd>
            </div>
          ) : null}
        </dl>

        <p className="rounded-(--radius-base) border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {thread.discussion.status === 'open'
            ? t('closesAt', { at: formatDateTime(format, thread.discussion.expiresAt) ?? '—' })
            : t('deletedAt', { at: formatDateTime(format, thread.discussion.expiresAt) ?? '—' })}
          {' · '}
          {t('noLiveUpdates')}
        </p>

        {closedIdle ? <Alert tone="info">{t('closedForInactivityNote')}</Alert> : null}

        {decisionPage ? (
          <Alert tone="success">
            {t('decisionWritten')}{' '}
            <Link
              href={spacePageHref(space.key, decisionPage.id)}
              className="underline underline-offset-2"
            >
              {decisionPage.title}
            </Link>
          </Alert>
        ) : null}
      </header>

      <ul className="grid gap-3">
        {thread.messages.map((message) => (
          <li key={message.id}>
            <Card>
              <CardBody className="grid gap-2">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-(--radius-base) border border-border px-2 py-0.5 font-medium text-foreground">
                    {message.authorLabel}
                  </span>
                  <span className="rounded-(--radius-base) bg-secondary px-2 py-0.5">
                    {message.authorType === 'agent' ? t('badgeAgent') : t('badgePerson')}
                  </span>
                  <span>{formatDateTime(format, message.createdAt)}</span>
                </p>
                {/* Somebody else's words, shown as their words. Never rendered
                    as Markdown and never folded into a page. */}
                <p className="whitespace-pre-wrap text-sm">{message.body}</p>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>

      {thread.discussion.status === 'open' && space.archivedAt === null ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('replyHeading')}</CardTitle>
            </CardHeader>
            <CardBody>
              <ComposeMessage discussionId={thread.discussion.id} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('resolveHeading')}</CardTitle>
            </CardHeader>
            <CardBody>
              <ResolveForm
                discussionId={thread.discussion.id}
                title={thread.discussion.title}
                decisionsParentTitle={
                  decisionsParent?.title ?? decisionsParentTemplate(locale).title
                }
              />
            </CardBody>
          </Card>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <Link
          href={spaceDiscussionsHref(space.key)}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('backToList')}
        </Link>
        {mayDelete ? <DeleteDiscussionButton discussionId={thread.discussion.id} /> : null}
      </div>
    </article>
  );
}
