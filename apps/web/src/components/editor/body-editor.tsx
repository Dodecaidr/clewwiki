'use client';

import type { BlockIssue } from '@clewwiki/content/blocks';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import {
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';

import type { MarkdownStore } from './collab/use-session';
import type { SessionProvider } from './collab/provider';
import type { ParsedMarkdown } from './markdown-bridge';
import type { VisualEditorHandle } from './visual-editor';
import { PageBody } from '@/components/page-body';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The page body field: a visual editor and a Markdown tab over one stored
 * Markdown string.
 *
 * The Markdown string is the only state that matters. The visual tab is
 * opened from it and hands it back; the Markdown tab is a text area on it; the
 * hidden form field carries it to the server. Switching tabs converts through
 * that string, so nothing typed in one tab can be lost in the other.
 */

const VisualEditor = dynamic(() => import('./visual-editor'), {
  ssr: false,
  loading: () => <EditorLoading />,
});

function EditorLoading() {
  const t = useTranslations('editor');
  return <p className="p-4 text-sm text-muted-foreground">{t('loadingEditor')}</p>;
}

export type EditorMode = 'visual' | 'markdown';

/**
 * A live session to edit the body in. The shared document is then the truth:
 * the visual tab edits it directly, and text typed in the Markdown tab is
 * written into it before anything else reads it.
 */
export interface BodySession {
  provider: SessionProvider;
  parsed: ParsedMarkdown;
  /** False while the session is paused: what is typed could not be sent. */
  editable: boolean;
  /** True when nobody else is in the session. */
  alone: boolean;
  applyMarkdown: (markdown: string) => void;
  markdown: MarkdownStore;
}

const NO_STORE: MarkdownStore = { subscribe: () => () => undefined, getSnapshot: () => '' };

export interface BodyEditorHandle {
  /** Brings the hidden field up to date with the visual editor right now. */
  flush: () => string;
}

export function BodyEditor({
  name,
  initialBody,
  serverIssues,
  onBodyChange,
  handleRef,
  renderPreview,
  session,
  imageUploadEndpoint,
}: {
  name: string;
  initialBody: string;
  /** Chart and diagram blocks the server refused on the last save. */
  serverIssues: BlockIssue[];
  onBodyChange: (body: string) => void;
  handleRef: React.RefObject<BodyEditorHandle | null>;
  renderPreview: (markdown: string) => Promise<string>;
  session?: BodySession;
  /** Where the visual editor sends image files; the page's endpoint, or its space's for a new page. */
  imageUploadEndpoint?: string;
}) {
  const t = useTranslations('editor');
  const hintId = useId();
  const issuesId = useId();
  const [mode, setMode] = useState<EditorMode>('visual');
  const [body, setBody] = useState(initialBody);
  const [notice, setNotice] = useState<'unsafe' | null>(null);
  const [rawBlocks, setRawBlocks] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState('');
  const [rendering, startRendering] = useTransition();
  // Remounts the visual editor when the Markdown it was opened from changes.
  const [visualKey, setVisualKey] = useState(0);
  const visualRef = useRef<VisualEditorHandle | null>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);

  // With somebody else in the session the Markdown tab shows the shared
  // document and cannot be typed in: a text area has no way to merge what two
  // people type, and the visual tab does.
  const sharedMarkdown = useSyncExternalStore(
    (session?.markdown ?? NO_STORE).subscribe,
    (session?.markdown ?? NO_STORE).getSnapshot,
    () => '',
  );
  const markdownLocked = session !== undefined && (!session.alone || !session.editable);
  const bodyRef = useRef(body);
  useEffect(() => {
    bodyRef.current = body;
  }, [body]);
  // Somebody joined while this person was typing Markdown: what they typed goes
  // into the shared document first, and only then does the tab lock.
  useEffect(() => {
    if (session && markdownLocked && mode === 'markdown') session.applyMarkdown(bodyRef.current);
    // Only the moment of locking matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdownLocked]);
  const shownBody = markdownLocked && mode === 'markdown' ? sharedMarkdown : body;
  const deferredBody = useDeferredValue(shownBody);
  const [liveIssues, setLiveIssues] = useState<BlockIssue[]>([]);
  // After an edit the server's list is out of date; the live check replaces it.
  const issues = deferredBody === initialBody && serverIssues.length > 0 ? serverIssues : liveIssues;

  useEffect(() => {
    let cancelled = false;
    // The same check the server runs on save, loaded on demand so the Markdown
    // parser is not part of the page's first load.
    const timer = setTimeout(() => {
      void import('@clewwiki/content/blocks').then(({ validateContentBlocks }) => {
        if (!cancelled) setLiveIssues(validateContentBlocks(deferredBody));
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deferredBody]);

  const update = (next: string) => {
    setBody(next);
    onBodyChange(next);
  };

  useEffect(() => {
    handleRef.current = {
      flush: () => {
        // In a session, Markdown typed by hand becomes part of the shared
        // document before it is saved, or the next person in would be shown the
        // text from before it.
        if (session && mode === 'markdown' && !markdownLocked) session.applyMarkdown(body);
        const current =
          mode === 'visual' && visualRef.current
            ? visualRef.current.getMarkdown()
            : markdownLocked
              ? sharedMarkdown
              : body;
        if (hiddenRef.current) hiddenRef.current.value = JSON.stringify(current);
        if (current !== body) update(current);
        return current;
      },
    };
  });

  useEffect(() => {
    if (!showPreview || mode !== 'markdown') return;
    startRendering(async () => {
      setPreview(await renderPreview(body));
    });
  }, [showPreview, body, mode, renderPreview]);

  const switchTo = (next: EditorMode) => {
    if (next === mode) return;
    if (mode === 'visual' && visualRef.current) {
      update(visualRef.current.getMarkdown());
    }
    if (next === 'visual') {
      if (session && !markdownLocked) session.applyMarkdown(body);
      setNotice(null);
      setVisualKey((key) => key + 1);
    }
    setMode(next);
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={t('tabsLabel')} className="inline-flex rounded-(--radius-base) border border-border p-0.5">
          {(['visual', 'markdown'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => switchTo(value)}
              className={cn(
                'rounded-(--radius-base) px-3 py-1 text-sm',
                mode === value ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {value === 'visual' ? t('tabVisual') : t('tabMarkdown')}
            </button>
          ))}
        </div>
        {mode === 'markdown' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={showPreview}
            onClick={() => setShowPreview((value) => !value)}
          >
            {showPreview ? t('hidePreview') : t('showPreview')}
          </Button>
        ) : null}
      </div>

      {/* JSON-encoded: a browser rewrites line breaks in submitted fields to
          CRLF, and the stored Markdown must arrive byte for byte. */}
      <input ref={hiddenRef} type="hidden" name={name} value={JSON.stringify(body)} />
      <input type="hidden" name={`${name}Encoding`} value="json" />

      {notice === 'unsafe' ? <Alert>{t('modeUnsafe')}</Alert> : null}
      {mode === 'markdown' && markdownLocked ? <Alert>{t('markdownLocked')}</Alert> : null}
      {mode === 'visual' && rawBlocks > 0 ? <Alert>{t('rawBlocksNotice', { count: rawBlocks })}</Alert> : null}

      {mode === 'visual' ? (
        <div className="overflow-hidden rounded-(--radius-base) border border-input bg-card">
          <VisualEditor
            key={visualKey}
            markdown={body}
            handleRef={visualRef}
            onChange={update}
            onReady={({ rawBlocks: count }) => setRawBlocks(count)}
            onUnsafe={() => {
              setNotice('unsafe');
              setMode('markdown');
            }}
            session={
              session
                ? { provider: session.provider, parsed: session.parsed, editable: session.editable }
                : undefined
            }
            imageUploadEndpoint={imageUploadEndpoint}
            ariaLabel={t('body')}
            describedBy={`${hintId}${issues.length > 0 ? ` ${issuesId}` : ''}`}
          />
        </div>
      ) : (
        <textarea
          id="body"
          aria-label={t('body')}
          aria-describedby={`${hintId}${issues.length > 0 ? ` ${issuesId}` : ''}`}
          aria-invalid={issues.length > 0}
          value={shownBody}
          readOnly={markdownLocked}
          onChange={(event) => update(event.target.value)}
          spellCheck={false}
          className={cn(
            'min-h-96 w-full rounded-(--radius-base) border border-input bg-card p-3',
            'font-mono text-sm leading-relaxed',
          )}
        />
      )}

      <p id={hintId} className="text-xs text-muted-foreground">
        {mode === 'visual' ? t('bodyHintVisual') : t('bodyHintMarkdown')}
      </p>

      {issues.length > 0 ? (
        <div id={issuesId} role="alert" className="rounded-(--radius-base) border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          <p className="font-medium">{t('blockIssuesTitle')}</p>
          <ul className="mt-1 grid list-disc gap-1 pl-5">
            {issues.flatMap((issue) =>
              issue.errors.slice(0, 5).map((error, index) => (
                <li key={`${issue.block_index}-${index}`}>
                  {t('blockIssue', {
                    kind: issue.language === 'chart' ? t('blockKindChart') : t('blockKindMermaid'),
                    index: issue.block_index + 1,
                    line: issue.line,
                  })}{' '}
                  {error.path ? <code className="font-mono text-xs">{error.path}</code> : null}
                  {error.path ? ' — ' : null}
                  {error.message}
                </li>
              )),
            )}
          </ul>
        </div>
      ) : null}

      {mode === 'markdown' && showPreview ? (
        <div className="rounded-(--radius-base) border border-border bg-card p-4">
          {rendering && preview === '' ? (
            <p className="text-sm text-muted-foreground">{t('previewLoading')}</p>
          ) : (
            <PageBody html={preview} />
          )}
        </div>
      ) : null}
    </div>
  );
}
