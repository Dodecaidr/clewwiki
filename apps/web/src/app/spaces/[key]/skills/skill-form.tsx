'use client';

import Link from 'next/link';
import { useActionState, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';

import { createSkillAction, updateSkillAction } from '@/app/spaces/skill-actions';
import type { SkillFormState } from '@/app/spaces/skill-actions';
import { renderPreviewAction } from '@/app/pages/actions';
import { BodyEditor } from '@/components/editor/body-editor';
import type { BodyEditorHandle } from '@/components/editor/body-editor';
import { useUnsavedChangesGuard } from '@/components/editor/use-unsaved-changes';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { generateSegment } from '@/lib/pages/slug';

const initialState: SkillFormState = {};

export interface SkillFormProps {
  mode: 'create' | 'edit';
  spaceKey: string;
  initial: {
    slug: string;
    name: string;
    description: string;
    version: string;
    tags: string;
    body: string;
  };
  cancelHref: string;
}

/**
 * The form behind a skill.
 *
 * The body is the page editor, not a second one: a skill body is Markdown of
 * exactly the kind a page holds, and a project that already learned one editor
 * should not have to learn another. What the form does *not* edit is the front
 * matter — `name`, `description`, `version` and `tags` are the fields above,
 * and the `SKILL.md` is assembled from them on the way out, so the file and the
 * listing can never disagree about what a skill is called.
 */
export function SkillForm({ mode, spaceKey, initial, cancelHref }: SkillFormProps) {
  const t = useTranslations('skills');
  const te = useTranslations('editor');
  const tc = useTranslations('common');

  const action = mode === 'create' ? createSkillAction : updateSkillAction;
  const [state, formAction, pending] = useActionState(action, initialState);

  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [body, setBody] = useState(initial.body);
  const [otherFieldsChanged, setOtherFieldsChanged] = useState(false);
  const bodyEditor = useRef<BodyEditorHandle | null>(null);

  const generatedSlug = name.trim() === '' ? '' : generateSegment(name);
  const dirty =
    name !== initial.name ||
    slug !== initial.slug ||
    body !== initial.body ||
    otherFieldsChanged;
  useUnsavedChangesGuard(dirty && !pending, te('unsavedChanges'));

  return (
    <div className="grid gap-5">
      {state.error === 'forbidden' ? <Alert tone="error">{t('errorForbidden')}</Alert> : null}
      {state.error === 'conflict' ? (
        <Alert tone="error">{state.message ?? t('errorConflict')}</Alert>
      ) : null}
      {state.error === 'not_found' ? <Alert tone="error">{t('errorNotFound')}</Alert> : null}
      {state.error === 'validation' ? (
        <Alert tone="error">{state.message ?? t('errorValidation')}</Alert>
      ) : null}
      {state.error === 'generic' ? <Alert tone="error">{t('errorGeneric')}</Alert> : null}

      <form
        action={formAction}
        className="grid gap-5"
        onChange={(event) => {
          const target = event.target as HTMLElement;
          if (target.id === 'skill-description' || target.id === 'skill-version' || target.id === 'skill-tags') {
            setOtherFieldsChanged(true);
          }
        }}
      >
        <input type="hidden" name="spaceKey" value={spaceKey} />
        {mode === 'edit' ? <input type="hidden" name="currentSlug" value={initial.slug} /> : null}

        <Field label={t('name')} htmlFor="skill-name" hint={t('nameHint')}>
          <Input
            id="skill-name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={100}
          />
        </Field>

        <Field label={t('description')} htmlFor="skill-description" hint={t('descriptionHint')}>
          <Input
            id="skill-description"
            name="description"
            defaultValue={initial.description}
            required
            maxLength={1024}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('version')} htmlFor="skill-version" hint={t('versionHint')}>
            <Input id="skill-version" name="version" defaultValue={initial.version} maxLength={40} />
          </Field>
          <Field label={t('tags')} htmlFor="skill-tags" hint={t('tagsHint')}>
            <Input
              id="skill-tags"
              name="tags"
              defaultValue={initial.tags}
              maxLength={400}
              className="font-mono text-xs"
            />
          </Field>
        </div>

        <Field label={t('slug')} htmlFor="skill-slug" hint={t('slugHint')}>
          <Input
            id="skill-slug"
            name="slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            maxLength={80}
            placeholder={generatedSlug || 'release-checks'}
            className="font-mono text-xs"
          />
        </Field>

        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('installPreview', { slug: (slug.trim() || generatedSlug) || 'release-checks' })}
        </p>

        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('body')}</p>
          <p className="text-xs text-muted-foreground">{t('bodyHint')}</p>
          <BodyEditor
            name="body"
            initialBody={initial.body}
            serverIssues={[]}
            onBodyChange={setBody}
            handleRef={bodyEditor}
            renderPreview={renderPreviewAction}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={pending}
            onClick={() => {
              flushSync(() => {
                bodyEditor.current?.flush();
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
