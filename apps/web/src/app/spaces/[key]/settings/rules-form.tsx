'use client';

import { useActionState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { createRulesPageAction, setRulesPageAction } from '@/app/spaces/actions';
import type { SpaceFormState } from '@/app/spaces/actions';
import type { SpaceFormPage } from './space-form';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';

const initialState: SpaceFormState = {};

/**
 * Designating the space's rules page, or creating one from the starter
 * template.
 *
 * Two forms rather than one control with a magic "create a new page" option:
 * choosing an existing page and writing a new one are different acts with
 * different consequences, and a picker that silently creates a page is the kind
 * of surprise an administrator only notices afterwards.
 */
export function RulesForm({
  spaceKey,
  pages,
  rulesPageId,
  hasRules,
}: {
  spaceKey: string;
  pages: SpaceFormPage[];
  rulesPageId: string;
  hasRules: boolean;
}) {
  const t = useTranslations('rules');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [state, action, pending] = useActionState(setRulesPageAction, initialState);
  const [createState, createAction, creating] = useActionState(createRulesPageAction, initialState);

  const failure = state.error ?? createState.error;

  return (
    <div className="grid gap-5">
      {state.saved ? <Alert tone="success">{t('saved')}</Alert> : null}
      {failure === 'forbidden' ? <Alert tone="error">{t('adminOnly')}</Alert> : null}
      {failure && failure !== 'forbidden' ? (
        <Alert tone="error">{state.message ?? createState.message ?? t('errorGeneric')}</Alert>
      ) : null}

      <form action={action} className="grid gap-4">
        <input type="hidden" name="spaceKey" value={spaceKey} />
        <Field label={t('pickLabel')} htmlFor="space-rules" hint={t('pickHint')}>
          <Select id="space-rules" name="rulesPageId" defaultValue={rulesPageId}>
            <option value="">{t('pickNone')}</option>
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {`${'  '.repeat(page.depth)}${page.title}`}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? tc('loading') : t('save')}
          </Button>
        </div>
      </form>

      {hasRules ? null : (
        <form action={createAction} className="grid gap-2 border-t border-border pt-4">
          <input type="hidden" name="spaceKey" value={spaceKey} />
          {/* The template is written in the language the administrator is
              reading the interface in; the page is editable afterwards. */}
          <input type="hidden" name="locale" value={locale} />
          <p className="text-sm font-medium">{t('createHeading')}</p>
          <p className="text-xs text-muted-foreground">{t('createIntro')}</p>
          <div>
            <Button type="submit" variant="outline" disabled={creating}>
              {creating ? tc('loading') : t('createFromTemplate')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
