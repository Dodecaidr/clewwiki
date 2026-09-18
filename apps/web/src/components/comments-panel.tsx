import { getFormatter, getTranslations } from 'next-intl/server';

import {
  DeleteCommentButton,
  JumpToBlock,
  PageCommentForm,
  ReplyForm,
  ResolveButton,
} from '@/components/comment-thread-forms';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import type { CommentRecord, CommentThread } from '@/lib/comments/service';
import { formatDateTime } from '@/lib/utils';

interface Viewer {
  userId: string;
  isAdmin: boolean;
}

async function Message({ comment, viewer }: { comment: CommentRecord; viewer: Viewer }) {
  const t = await getTranslations('comments');
  const format = await getFormatter();
  const own = comment.authorType === 'user' && comment.authorId === viewer.userId;
  return (
    <div className="grid gap-1">
      {/* A div, not a paragraph: the delete control is a form, and a form cannot sit inside a <p>. */}
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{comment.authorLabel}</span>
        {comment.authorType === 'agent' ? (
          <span className="rounded-(--radius-base) border border-border px-1">{t('agentBadge')}</span>
        ) : null}
        <span>{formatDateTime(format, comment.createdAt)}</span>
        {own || viewer.isAdmin ? <DeleteCommentButton commentId={comment.id} /> : null}
      </div>
      {/* The words of a person or an agent, shown as typed: never rendered as
          Markdown and never treated as part of the page. */}
      <p className="whitespace-pre-wrap break-words text-sm">{comment.body}</p>
    </div>
  );
}

async function Thread({ thread, viewer }: { thread: CommentThread; viewer: Viewer }) {
  const t = await getTranslations('comments');
  const { root, anchor } = thread;
  const resolved = root.resolvedAt !== null;

  return (
    <li
      id={`thread-${root.id}`}
      className="grid gap-3 rounded-(--radius-base) border border-border p-4 focus:outline-2 focus:outline-ring"
    >
      {anchor.state === 'page' ? (
        <p className="text-xs text-muted-foreground">{t('anchorPage')}</p>
      ) : (
        <div className="grid gap-1">
          <blockquote
            className={`border-l-2 pl-3 text-sm ${
              anchor.state === 'outdated'
                ? 'border-border text-muted-foreground line-through decoration-muted-foreground/40'
                : 'border-warning'
            }`}
          >
            {anchor.quote}
          </blockquote>
          {anchor.state === 'outdated' ? (
            <p className="text-xs text-muted-foreground">
              {anchor.version === null
                ? t('anchorOutdated')
                : t('anchorOutdatedSince', { version: anchor.version })}
            </p>
          ) : (
            <p>
              <JumpToBlock blockIndex={anchor.blockIndex} label={t('jumpToParagraph')} />
            </p>
          )}
        </div>
      )}

      <Message comment={root} viewer={viewer} />
      {thread.replies.length > 0 ? (
        <div className="grid gap-3 border-l border-border pl-4">
          {thread.replies.map((reply) => (
            <Message key={reply.id} comment={reply} viewer={viewer} />
          ))}
        </div>
      ) : null}

      {resolved ? (
        <p className="text-xs text-muted-foreground">
          {t('resolvedBy', { name: root.resolvedByLabel ?? '—' })}
        </p>
      ) : (
        <ReplyForm threadId={root.id} />
      )}
      <ResolveButton threadId={root.id} resolved={resolved} />
    </li>
  );
}

/**
 * The comment threads of a page, under its text.
 *
 * Unresolved threads are open; resolved ones are one click away, because a
 * resolved thread is the record of what a reviewer asked for and what was done.
 */
export async function CommentsPanel({
  pageId,
  version,
  open,
  resolved,
  viewer,
  canComment,
}: {
  pageId: string;
  version: number;
  open: CommentThread[];
  resolved: CommentThread[];
  viewer: Viewer;
  canComment: boolean;
}) {
  const t = await getTranslations('comments');

  return (
    <Card id="comments">
      <CardHeader>
        <CardTitle>{t('heading', { count: open.length })}</CardTitle>
        <p className="text-xs text-muted-foreground">{t('intro')}</p>
      </CardHeader>
      <CardBody className="grid gap-5">
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="grid gap-3">
            {open.map((thread) => (
              <Thread key={thread.root.id} thread={thread} viewer={viewer} />
            ))}
          </ul>
        )}

        {canComment ? <PageCommentForm pageId={pageId} version={version} /> : null}

        {resolved.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t('resolvedHeading', { count: resolved.length })}
            </summary>
            <ul className="mt-3 grid gap-3">
              {resolved.map((thread) => (
                <Thread key={thread.root.id} thread={thread} viewer={viewer} />
              ))}
            </ul>
          </details>
        ) : null}
      </CardBody>
    </Card>
  );
}
