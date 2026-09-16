'use client';

import { useActionState } from 'react';

import { saveRepositoryAction, testRepositoryAction } from './actions';
import type { RepositoryFormState } from './actions';
import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

const initialState: RepositoryFormState = {};

export interface RepositoryFormLabels {
  url: string;
  urlHint: string;
  ref: string;
  refHint: string;
  tokenEnv: string;
  tokenEnvHint: string;
  save: string;
  test: string;
  saved: string;
  testOk: string;
  testFailed: string;
  errorForbidden: string;
  errorValidation: string;
}

/**
 * One form with two submit buttons: save the setting, or test it first.
 *
 * Testing before saving is the useful order — an operator pasting a URL and a
 * branch wants to know the token works before every anchor in the workspace
 * starts being checked against it.
 */
export function RepositoryForm({
  labels,
  initial,
}: {
  labels: RepositoryFormLabels;
  initial: { url: string; defaultRef: string; authTokenEnv: string };
}) {
  const [saveState, saveAction, saving] = useActionState(saveRepositoryAction, initialState);
  const [testState, testAction, testing] = useActionState(testRepositoryAction, initialState);

  const error = saveState.error ?? testState.error;
  const message = saveState.message ?? testState.message;

  return (
    <form className="grid gap-4">
      <Field label={labels.url} htmlFor="repository-url" hint={labels.urlHint}>
        <Input
          id="repository-url"
          name="url"
          defaultValue={initial.url}
          required
          maxLength={2000}
          autoComplete="off"
        />
      </Field>
      <Field label={labels.ref} htmlFor="repository-ref" hint={labels.refHint}>
        <Input
          id="repository-ref"
          name="default_ref"
          defaultValue={initial.defaultRef || 'main'}
          required
          maxLength={200}
          autoComplete="off"
        />
      </Field>
      <Field label={labels.tokenEnv} htmlFor="repository-token-env" hint={labels.tokenEnvHint}>
        <Input
          id="repository-token-env"
          name="auth_token_env"
          defaultValue={initial.authTokenEnv}
          maxLength={64}
          autoComplete="off"
          placeholder="GIT_ACCESS_TOKEN"
        />
      </Field>

      {error ? (
        <Alert tone="error">
          {error === 'forbidden'
            ? labels.errorForbidden
            : (message ?? labels.errorValidation)}
        </Alert>
      ) : null}

      {saveState.saved ? <Alert tone="success">{labels.saved}</Alert> : null}

      {testState.probe ? (
        testState.probe.ok ? (
          <Alert tone="success">
            {labels.testOk} {testState.probe.refs ?? 0}
            {testState.probe.commit ? ` · ${testState.probe.commit}` : ''}
          </Alert>
        ) : (
          <Alert tone="error">
            {labels.testFailed} {testState.probe.error ?? ''}
          </Alert>
        )
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" formAction={saveAction} disabled={saving}>
          {labels.save}
        </Button>
        <Button type="submit" variant="outline" formAction={testAction} disabled={testing}>
          {labels.test}
        </Button>
      </div>
    </form>
  );
}
