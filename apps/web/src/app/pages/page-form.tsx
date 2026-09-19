'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useFormatter, useTranslations } from 'next-intl';

import { createPageAction, renderPreviewAction, updatePageAction } from './actions';
import type { PageFormState } from './actions';
import { useEditLease } from './use-edit-lease';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/field';
import { BodyEditor } from '@/components/editor/body-editor';
import type { BodyEditorHandle, BodySession } from '@/components/editor/body-editor';
import { useLiveSession } from '@/components/editor/collab/use-session';
import { useUnsavedChangesGuard } from '@/components/editor/use-unsaved-changes';
import { lastSegment, slugifySegment } from '@/lib/pages/paths';
import { generateSegment } from '@/lib/pages/slug';
import { formatDateTime } from '@/lib/utils';

export interface PageFormParent {
  id: string;
  title: string;
  path: string;
  /** How deep the page sits in the tree, for indenting the picker. */
  depth: number;
}

export interface PageFormProps {
  mode: 'create' | 'edit';
  /** The space the page is created in; pages never change space. */
  spaceKey: string;
  parents: PageFormParent[];
  initial: {
    pageId?: string;
    baseContentHash?: string;
    title: string;
    /** The page's current last path segment when editing; empty when creating. */
    segment: string;
    parentId: string;
    kind: 'technical' | 'human';
    summary: string;
    body: string;
  };
  cancelHref: string;
}

const initialState: PageFormState = {};

/**
 * The path a page will get, as the server will build it: the parent's path, then
 * the typed segment or, failing that, the fallback. On create the fallback is
 * the segment generated from the title; on edit it is the page's current
 * segment. `invalid` when a typed segment has nothing a segment can be made of,
 * `null` when there is nothing to show yet. A taken generated path is numbered
 * by the server, which the preview does not try to predict.
 */
function previewPath(
  parents: PageFormParent[],
  parentId: string,
  segment: string,
  fallback: string,
): string | 'invalid' | null {
  const parent = parents.find((candidate) => candidate.id === parentId);
  let last: string;
  if (segment.trim() !== '') {
    last = slugifySegment(segment);
    if (last === '') return 'invalid';
  } else {
    last = fallback;
  }
  if (last === '') return null;
  return `${parent ? parent.path : ''}/${last}`;
}

/**
 * The page editor.
 *
 * The body is edited visually or as Markdown, and stored as Markdown either
 * way: the stored form is what agents read and what exports carry, so the
 * visual editor is a view onto it rather than a second format. A page opened
 * and saved without edits is handed back byte for byte.
 */
export function PageForm({ mode, spaceKey, parents, initial, cancelHref }: PageFormProps) {
  const t = useTranslations('editor');
  const tc = useTranslations('common');
  const format = useFormatter();

  const action = mode === 'create' ? createPageAction : updatePageAction;
  const [state, formAction, pending] = useActionState(action, initialState);

  // Editing a page means holding it. The lease is taken when this form mounts
  // and returned when it goes away, so two people cannot both be told they are
  // editing the same page.
  //
  // A page the visual editor can keep byte for byte is edited in a live session
  // instead: the session holds one lease for everybody in it, so several people
  // can be in the page at once and still contend with agents as one writer. The
  // exclusive lease remains for the pages that cannot — they are edited as
  // Markdown, by one person, as before.
  const live = useLiveSession(mode === 'edit' ? initial.pageId : undefined, initial.body);
  const solo = mode === 'edit' && live.mode === 'solo';
  const shared = mode === 'edit' && live.mode === 'session';
  const lease = useEditLease(solo ? initial.pageId : undefined);
  const snapshot = live.snapshot;
  const sessionReady =
    shared &&
    snapshot !== null &&
    snapshot.ready &&
    live.provider !== null &&
    live.parsed !== null &&
    live.applyMarkdown !== null &&
    live.markdown !== null;
  const sessionLive = sessionReady && snapshot.status === 'live';
  const blocked = solo
    ? lease.status === 'conflict' || lease.status === 'lost'
    : mode === 'edit' && !sessionLive;
  const bodySession: BodySession | undefined =
    sessionReady && live.provider && live.parsed && live.applyMarkdown && live.markdown
      ? {
          provider: live.provider,
          parsed: live.parsed,
          editable: sessionLive,
          alone: live.alone,
          applyMarkdown: live.applyMarkdown,
          markdown: live.markdown,
        }
      : undefined;
  const others = (snapshot?.participants ?? []).filter(
    (entry) => entry.client_id !== live.provider?.clientId,
  );

  const [body, setBody] = useState(initial.body);
  const [title, setTitle] = useState(initial.title);
  const [parentId, setParentId] = useState(initial.parentId);
  const [segment, setSegment] = useState(initial.segment);
  // An edit with the segment cleared keeps the page's current segment, which is
  // what the server does too; a new page falls back to its title.
  const generatedSegment = title.trim() === '' ? '' : generateSegment(title);
  const resultingPath = previewPath(
    parents,
    parentId,
    segment,
    mode === 'edit' ? initial.segment : generatedSegment,
  );
  const bodyEditor = useRef<BodyEditorHandle | null>(null);
  const [otherFieldsChanged, setOtherFieldsChanged] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const vectorRef = useRef<HTMLInputElement>(null);
  const lastEditAt = useRef(0);

  // Text typed into a session is saved for its author after a minute of quiet,
  // so that closing the tab costs a minute of work at most. Everybody's browser
  // would do it at the same moment, so only the first in the list does; a save
  // that changes nothing writes nothing, should two of them do it anyway.
  useEffect(() => {
    const provider = live.provider;
    if (!sessionLive || !provider) return;
    const timer = setInterval(() => {
      const state = provider.state;
      const first = [...state.participants].sort((a, b) => a.client_id.localeCompare(b.client_id))[0];
      if (!state.unsaved || first?.client_id !== provider.clientId) return;
      if (Date.now() - lastEditAt.current < 60_000) return;
      const markdown = bodyEditor.current?.flush();
      if (markdown !== undefined) void provider.save(markdown);
    }, 15_000);
    return () => clearInterval(timer);
  }, [sessionLive, live.provider]);

  const dirty =
    (shared ? (snapshot?.unsaved ?? false) : body !== initial.body) ||
    title !== initial.title ||
    segment !== initial.segment ||
    parentId !== initial.parentId ||
    otherFieldsChanged;
  useUnsavedChangesGuard(dirty && !pending, t('unsavedChanges'));

  return (
    <div className="grid gap-5">
      {state.error === 'forbidden' ? <Alert tone="error">{t('errorForbidden')}</Alert> : null}
      {state.error === 'conflict' ? (
        <Alert tone="error">{state.message ?? t('errorConflict')}</Alert>
      ) : null}
      {state.error === 'stale_base' ? <Alert tone="error">{t('errorStaleBase')}</Alert> : null}
      {state.error === 'validation' && !state.blockIssues ? (
        <Alert tone="error">{state.message ?? t('errorValidation')}</Alert>
      ) : null}
      {state.error === 'validation' && state.blockIssues ? (
        <Alert tone="error">{t('errorBlocks')}</Alert>
      ) : null}
      {state.error === 'not_found' ? <Alert tone="error">{t('errorNotFound')}</Alert> : null}
      {state.error === 'generic' ? <Alert tone="error">{t('errorGeneric')}</Alert> : null}

      {solo && lease.status === 'acquiring' ? (
        <Alert>{t('claimAcquiring')}</Alert>
      ) : null}
      {solo && lease.status === 'held' ? (
        <Alert tone="success">{t('claimHeld')}</Alert>
      ) : null}
      {solo && lease.status === 'conflict' ? (
        <Alert tone="error">
          {t('claimHeldByOther', {
            name: lease.heldBy ?? t('claimSomeoneElse'),
            since: formatDateTime(format, lease.heldSince) ?? '—',
          })}{' '}
          <Link href={cancelHref} className="underline underline-offset-2">
            {t('claimReadOnly')}
          </Link>
        </Alert>
      ) : null}
      {solo && lease.status === 'lost' ? (
        <Alert tone="error">{t('claimLost')}</Alert>
      ) : null}
      {solo && lease.status === 'error' ? (
        <Alert tone="error">{t('claimError')}</Alert>
      ) : null}

      {mode === 'edit' && (live.mode === 'checking' || (shared && !sessionReady && snapshot?.status !== 'reset')) ? (
        <Alert>{t('sessionJoining')}</Alert>
      ) : null}
      {sessionLive ? (
        <Alert tone="success">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{others.length === 0 ? t('sessionLiveAlone') : t('sessionLiveWith')}</span>
            {others.map((entry) => (
              <span key={entry.client_id} className="inline-flex items-center gap-1.5 text-xs font-medium">
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: entry.colour }}
                />
                {entry.name}
              </span>
            ))}
            {snapshot.lastSavedBy ? (
              <span className="text-xs text-muted-foreground">
                {snapshot.unsaved
                  ? t('sessionUnsavedSince', { name: snapshot.lastSavedBy })
                  : t('sessionSavedBy', { name: snapshot.lastSavedBy })}
              </span>
            ) : null}
          </span>
        </Alert>
      ) : null}
      {sessionReady && snapshot.status === 'paused' ? (
        <Alert tone={snapshot.heldBy ? 'error' : 'info'}>
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {snapshot.heldBy ? t('sessionPausedHeld', { name: snapshot.heldBy }) : t('sessionPausedIdle')}
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => void live.provider?.resume()}>
              {t('sessionResume')}
            </Button>
          </span>
        </Alert>
      ) : null}
      {shared && snapshot?.status === 'paused' && !snapshot.ready ? (
        <Alert tone="error">
          {snapshot.heldBy ? t('sessionPausedHeld', { name: snapshot.heldBy }) : t('sessionPausedIdle')}{' '}
          <Link href={cancelHref} className="underline underline-offset-2">
            {t('claimReadOnly')}
          </Link>
        </Alert>
      ) : null}
      {shared && snapshot?.status === 'offline' ? <Alert tone="error">{t('sessionOffline')}</Alert> : null}
      {shared && snapshot?.status === 'reset' ? (
        <Alert tone="error">
          {t('sessionReset')}{' '}
          <a href="" className="underline underline-offset-2">
            {t('sessionReload')}
          </a>
        </Alert>
      ) : null}

      <form
        ref={formRef}
        action={formAction}
        className="grid gap-5"
        onChange={(event) => {
          const target = event.target as HTMLElement;
          if (target.id === 'summary' || target.id === 'kind') setOtherFieldsChanged(true);
        }}
      >
        {mode === 'create' ? <input type="hidden" name="spaceKey" value={spaceKey} /> : null}
        {initial.pageId ? <input type="hidden" name="pageId" value={initial.pageId} /> : null}
        {initial.baseContentHash ? (
          <input type="hidden" name="baseContentHash" value={initial.baseContentHash} />
        ) : null}
        {/* Carries the lease into the save. Empty when the browser could not
            take one, in which case the action takes one of its own. */}
        {solo ? <input type="hidden" name="claimId" value={lease.claimId ?? ''} /> : null}
        {/* A save from inside a session names the browser's connection to it and
            the document the body was read from; both are filled in as it is sent. */}
        {shared ? <input type="hidden" name="collabClient" value={live.provider?.clientId ?? ''} /> : null}
        {shared ? <input ref={vectorRef} type="hidden" name="collabStateVector" defaultValue="" /> : null}

        <Field label={t('title')} htmlFor="title">
          <Input
            id="title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={300}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('parent')} htmlFor="parentId" hint={t('parentHint')}>
            <Select
              id="parentId"
              name="parentId"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
            >
              <option value="">{t('parentNone')}</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {/* Indented by depth, so the picker reads as the tree it is. */}
                  {`${'\u00a0\u00a0'.repeat(parent.depth)}${parent.title} (${lastSegment(parent.path)})`}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('kind')} htmlFor="kind" hint={t('kindHint')}>
            <Select id="kind" name="kind" defaultValue={initial.kind}>
              <option value="technical">{t('kindTechnical')}</option>
              <option value="human">{t('kindHuman')}</option>
            </Select>
          </Field>
        </div>

        <Field label={t('segment')} htmlFor="segment" hint={t('segmentHint')}>
          <Input
            id="segment"
            name="segment"
            value={segment}
            onChange={(event) => setSegment(event.target.value)}
            maxLength={80}
            placeholder={generatedSegment || 'auth'}
            className="font-mono text-xs"
          />
        </Field>

        <p className="text-xs text-muted-foreground" aria-live="polite">
          {resultingPath === 'invalid'
            ? t('resultingPathUnknown')
            : resultingPath === null
              ? null
              : t.rich('resultingPath', {
                  space: spaceKey,
                  path: resultingPath,
                  code: (chunks) => <code className="font-mono text-foreground">{chunks}</code>,
                })}
        </p>

        <Field label={t('summary')} htmlFor="summary" hint={t('summaryHint')}>
          <Input id="summary" name="summary" defaultValue={initial.summary} maxLength={2000} />
        </Field>

        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('body')}</p>
          {mode === 'edit' && !solo && !bodySession ? (
            // Nothing to type into until the session says what the page is: an
            // editor opened on the form's copy would be editing a different
            // document from everybody else's.
            <p className="rounded-(--radius-base) border border-input bg-card p-4 text-sm text-muted-foreground">
              {t('loadingEditor')}
            </p>
          ) : (
            <BodyEditor
              name="body"
              initialBody={bodySession && snapshot?.base ? snapshot.base.body : initial.body}
              serverIssues={state.blockIssues ?? []}
              onBodyChange={(next) => {
                lastEditAt.current = Date.now();
                setBody(next);
              }}
              handleRef={bodyEditor}
              renderPreview={renderPreviewAction}
              session={bodySession}
              imageUploadEndpoint={
                initial.pageId
                  ? `/api/v1/pages/${initial.pageId}/images`
                  : `/api/v1/spaces/${encodeURIComponent(spaceKey)}/images`
              }
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={pending || blocked}
            onClick={(event) => {
              // The visual editor reports changes after a short pause; the
              // save must carry what is on screen, so it is read out now.
              flushSync(() => {
                bodyEditor.current?.flush();
              });
              const provider = live.provider;
              if (!shared || !provider) return;
              // In a session the server has to have every edit the body was
              // read from before it is told the body is saved, and sending them
              // takes a moment: the form is submitted once they have gone.
              event.preventDefault();
              void provider.drain().then(() => {
                if (vectorRef.current) vectorRef.current.value = provider.stateVector();
                formRef.current?.requestSubmit();
              });
            }}
          >
            {pending ? tc('loading') : mode === 'create' ? t('create') : t('save')}
          </Button>
          <Link
            href={cancelHref}
            className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {tc('cancel')}
          </Link>
        </div>
      </form>
    </div>
  );
}
