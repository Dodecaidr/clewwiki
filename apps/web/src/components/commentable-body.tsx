'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { openCommentAction } from '@/app/spaces/comment-actions';
import type { CommentFormState } from '@/app/spaces/comment-actions';
import { PageBody } from '@/components/page-body';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';

interface Row {
  index: number;
  top: number;
}

interface Composing {
  index: number;
  excerpt: string;
  /** The last successful post when the sheet was opened; a newer one closes it. */
  openedAfter: number | undefined;
}

const initialState: CommentFormState = {};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Brings a thread, or a paragraph, into view and hands it the focus. */
export function revealElement(element: HTMLElement | null): void {
  if (!element) return;
  element.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  element.focus({ preventScroll: true });
}

/**
 * A page body with a gutter of comment buttons, one per paragraph.
 *
 * The body is server-rendered HTML this component does not own, so nothing is
 * inserted into it. The server marked the elements a comment can attach to
 * (`data-block`); this measures where they are and draws the buttons beside
 * them, in a gutter of their own. A paragraph that already has comments shows
 * their number all the time and leads to the thread; the rest show a button
 * while the pointer is over them or the button has the focus.
 *
 * The form is a sheet at the bottom of the window rather than something opened
 * between two paragraphs: it cannot shift the text the reader is commenting on.
 */
export function CommentableBody({
  html,
  pageId,
  version,
  threadsByBlock,
}: {
  html: string;
  pageId: string;
  version: number;
  /** Unresolved thread ids per block index, oldest first. */
  threadsByBlock: Record<string, string[]>;
}) {
  const t = useTranslations('comments');
  const tc = useTranslations('common');
  const wrapper = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [draft, setComposing] = useState<Composing | null>(null);
  const [state, action, pending] = useActionState(openCommentAction, initialState);
  // Closed by the post succeeding, derived rather than set from an effect.
  const composing = draft && draft.openedAfter === state.savedAt ? draft : null;

  const measure = useCallback(() => {
    const root = wrapper.current;
    if (!root) return;
    const origin = root.getBoundingClientRect().top;
    setRows(
      Array.from(root.querySelectorAll<HTMLElement>('[data-block]')).map((element) => ({
        index: Number(element.dataset.block),
        top: element.getBoundingClientRect().top - origin,
      })),
    );
  }, []);

  // Diagrams render after mount and fonts arrive late; both move paragraphs.
  useEffect(() => {
    measure();
    const root = wrapper.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [html, measure]);

  // The paragraph being commented on is outlined for as long as the sheet is open.
  useEffect(() => {
    const root = wrapper.current;
    if (!root || !composing) return;
    const target = root.querySelector<HTMLElement>(`[data-block="${composing.index}"]`);
    target?.classList.add('comment-target');
    return () => target?.classList.remove('comment-target');
  }, [composing]);

  const blockAt = (target: EventTarget | null): number | null => {
    const element = target instanceof Element ? target.closest<HTMLElement>('[data-block]') : null;
    return element ? Number(element.dataset.block) : null;
  };

  const startComposing = (index: number) => {
    const element = wrapper.current?.querySelector<HTMLElement>(`[data-block="${index}"]`);
    const text = (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
    setComposing({
      index,
      excerpt: text.length > 160 ? `${text.slice(0, 159)}…` : text,
      openedAfter: state.savedAt,
    });
  };

  return (
    <div
      ref={wrapper}
      className="relative pr-9"
      onMouseOver={(event) => setHovered(blockAt(event.target))}
      onMouseLeave={() => setHovered(null)}
    >
      <PageBody html={html} />

      <div className="absolute inset-y-0 right-0 w-8" aria-label={t('gutterLabel')} role="group">
        {rows.map((row) => {
          const threads = threadsByBlock[String(row.index)] ?? [];
          const visible = threads.length > 0 || hovered === row.index || composing?.index === row.index;
          return (
            <button
              key={row.index}
              type="button"
              style={{ top: row.top }}
              // Only paragraphs that carry comments are tab stops: a page has
              // hundreds of paragraphs, and a keyboard user comments on the
              // page from the form below, quoting what they mean.
              tabIndex={threads.length > 0 ? 0 : -1}
              onMouseEnter={() => setHovered(row.index)}
              onClick={() =>
                threads.length > 0
                  ? revealElement(document.getElementById(`thread-${threads[0]}`))
                  : startComposing(row.index)
              }
              aria-label={
                threads.length > 0 ? t('gutterOpenThreads', { count: threads.length }) : t('gutterAdd')
              }
              title={threads.length > 0 ? t('gutterOpenThreads', { count: threads.length }) : t('gutterAdd')}
              className={`absolute right-0 flex h-6 min-w-6 items-center justify-center rounded-(--radius-base) border px-1 text-xs tabular-nums transition-opacity focus-visible:opacity-100 motion-reduce:transition-none ${
                threads.length > 0
                  ? 'border-warning bg-warning/15 font-medium'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              } ${visible ? 'opacity-100' : 'opacity-0'}`}
            >
              {threads.length > 0 ? threads.length : '+'}
            </button>
          );
        })}
      </div>

      {composing ? (
        <form
          action={action}
          aria-label={t('composeLabel')}
          className="fixed inset-x-4 bottom-4 z-20 mx-auto grid max-w-xl gap-3 rounded-(--radius-base) border border-border bg-card p-4 shadow-lg"
        >
          <input type="hidden" name="pageId" value={pageId} />
          <input type="hidden" name="version" value={version} />
          <input type="hidden" name="blockIndex" value={composing.index} />
          <p className="text-xs text-muted-foreground">{t('composeAbout')}</p>
          <blockquote className="border-l-2 border-warning pl-3 text-sm">{composing.excerpt}</blockquote>
          {state.error ? (
            <Alert tone="error">
              {state.error === 'rate_limited' ? t('errorRateLimited') : (state.message ?? t('errorGeneric'))}
            </Alert>
          ) : null}
          <label className="sr-only" htmlFor="comment-compose">
            {t('bodyLabel')}
          </label>
          <textarea
            id="comment-compose"
            name="body"
            required
            rows={3}
            autoFocus
            placeholder={t('bodyPlaceholder')}
            className="w-full rounded-(--radius-base) border border-input bg-background px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? tc('loading') : t('submit')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setComposing(null)}>
              {tc('cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
