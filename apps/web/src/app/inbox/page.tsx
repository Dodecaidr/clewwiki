import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { inboxItemHref } from '@/lib/inbox/serialize';
import { getInbox } from '@/lib/inbox/service';
import { getSessionContext } from '@/lib/session';
import { formatDateTime } from '@/lib/utils';

import { markInboxReadAction } from './actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('inbox');
  return { title: t('title') };
}

export default async function InboxPage() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const t = await getTranslations('inbox');
  const format = await getFormatter();
  const renderedAt = new Date();
  const inbox = await getInbox({
    workspaceId: session.workspace.id,
    actor: { type: 'user', id: session.userId },
    spaceIds: session.spaceIds,
    limit: 50,
    now: renderedAt,
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        {inbox.unread > 0 ? (
          <form action={markInboxReadAction}>
            <input type="hidden" name="upTo" value={renderedAt.toISOString()} />
            <Button type="submit" variant="outline" size="sm">
              {t('markRead')}
            </Button>
          </form>
        ) : null}
      </div>

      {inbox.items.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-muted-foreground">{t('empty')}</CardBody>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {inbox.items.map((item) => (
            <li
              key={`${item.kind}:${item.id}`}
              className={`grid gap-1 rounded-(--radius-base) border px-4 py-3 ${
                item.unread ? 'border-foreground/30 bg-secondary' : 'border-border'
              }`}
            >
              <span className="text-xs text-muted-foreground">
                {item.unread ? <strong className="font-semibold text-foreground">{t('unread')} · </strong> : null}
                {/* Message keys cannot hold a dot: it would read as nesting. */}
                {t(
                  `kind_${item.kind.replace('.', '_')}${
                    item.kind === 'discussion.resolved' || item.kind === 'review.decided' ? `_${item.decision}` : ''
                  }`,
                  {
                    who: item.by?.label ?? '',
                    file: item.file?.name ?? '',
                    version: item.file?.version ?? item.changes?.version ?? 0,
                    count: item.changes?.count ?? 0,
                  },
                )}
                {item.by?.type === 'agent' ? ` · ${t('agent')}` : ''}
              </span>
              <Link href={inboxItemHref(item)} className="font-medium underline-offset-2 hover:underline">
                {item.title}
              </Link>
              {/* Rendered as text, never as markup: an excerpt is somebody's
                  stored words, not a piece of the interface. */}
              {item.excerpt ? <p className="text-sm text-muted-foreground">{item.excerpt}</p> : null}
              <span className="font-mono text-xs text-muted-foreground">
                {item.space.key} · {formatDateTime(format, item.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
