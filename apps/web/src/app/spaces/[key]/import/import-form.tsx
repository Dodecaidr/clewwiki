'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Alert } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

/**
 * Choosing a source and handing it over.
 *
 * Confluence is a form of fields; the other three are a file. Within Confluence
 * there are two shapes: a Cloud site, which always needs an account e-mail and
 * an API token, and a Server or Data Center, where the credential is a personal
 * access token, or a username and password, or nothing at all for a space that
 * is open to anonymous reading — so both fields are optional there.
 *
 * The credential
 * fields are `type="password"` and `autoComplete="off"`, and they are sent once
 * — the component never puts them in component state that outlives the submit,
 * and the server never writes them down. The hint under them says so, because a
 * person typing an API token into a form deserves to be told what happens to it.
 */

export type ImportSource = 'confluence' | 'notion' | 'markdown' | 'pdf';

/** Which Confluence: Atlassian's cloud, or a Server or Data Center of your own. */
export type ConfluenceDeployment = 'cloud' | 'datacenter';

const DEPLOYMENTS: ConfluenceDeployment[] = ['cloud', 'datacenter'];

const SOURCES: ImportSource[] = ['confluence', 'notion', 'markdown', 'pdf'];

const ACCEPT: Record<Exclude<ImportSource, 'confluence'>, string> = {
  notion: '.zip,application/zip',
  markdown: '.zip,application/zip',
  pdf: '.pdf,application/pdf',
};

export interface ImportFormProps {
  spaceKey: string;
  /** The instance's upload limit, shown next to the file field. */
  uploadLimitMb: number;
  /** Where a started import is reviewed; the id is appended. */
  reviewBase: string;
}

export function ImportForm({ spaceKey, reviewBase, uploadLimitMb }: ImportFormProps) {
  const t = useTranslations('imports');
  const router = useRouter();
  const [source, setSource] = useState<ImportSource>('confluence');
  const [deployment, setDeployment] = useState<ConfluenceDeployment>('cloud');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);

    try {
      const endpoint = `/api/v1/spaces/${encodeURIComponent(spaceKey)}/imports`;
      const response =
        source === 'confluence'
          ? await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                source: 'confluence',
                deployment,
                base_url: valueOf(form, 'base_url'),
                space_key: valueOf(form, 'space_key'),
                email: valueOf(form, 'email'),
                api_token: valueOf(form, 'api_token'),
              }),
            })
          : await fetch(endpoint, { method: 'POST', body: uploadBody(form, source) });

      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(messageOf(body) ?? t('errorGeneric'));
        return;
      }
      const id = idOf(body);
      if (id === null) {
        setError(t('errorGeneric'));
        return;
      }
      // The credential fields are cleared before anything navigates, so a
      // back button cannot bring a token back onto the screen.
      form.reset();
      router.push(`${reviewBase}/${id}`);
    } catch {
      setError(t('errorGeneric'));
    } finally {
      setPending(false);
    }
  }

  const cloud = deployment === 'cloud';

  return (
    <form onSubmit={submit} className="grid gap-5">
      <Field label={t('sourceLabel')} htmlFor="import-source" hint={t(`source_${source}_hint`)}>
        <Select
          id="import-source"
          name="source"
          value={source}
          onChange={(event) => setSource(event.target.value as ImportSource)}
        >
          {SOURCES.map((value) => (
            <option key={value} value={value}>
              {t(`source_${value}`)}
            </option>
          ))}
        </Select>
      </Field>

      {source === 'confluence' ? (
        <>
          <Field
            label={t('deploymentLabel')}
            htmlFor="deployment"
            hint={t(`deployment_${deployment}_hint`)}
          >
            <Select
              id="deployment"
              name="deployment"
              value={deployment}
              onChange={(event) => setDeployment(event.target.value as ConfluenceDeployment)}
            >
              {DEPLOYMENTS.map((value) => (
                <option key={value} value={value}>
                  {t(`deployment_${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('baseUrl')}
            htmlFor="base_url"
            hint={cloud ? t('baseUrlHint') : t('baseUrlHintDataCenter')}
          >
            <Input
              id="base_url"
              name="base_url"
              required
              placeholder={cloud ? 'https://example.atlassian.net' : 'https://wiki.example.com/confluence'}
            />
          </Field>
          <Field label={t('confluenceSpaceKey')} htmlFor="space_key" hint={t('confluenceSpaceKeyHint')}>
            <Input id="space_key" name="space_key" required placeholder="ENG" />
          </Field>
          <Field
            label={cloud ? t('email') : t('username')}
            htmlFor="email"
            hint={cloud ? t('emailHint') : t('usernameHint')}
          >
            <Input
              id="email"
              name="email"
              type={cloud ? 'email' : 'text'}
              required={cloud}
              autoComplete="off"
            />
          </Field>
          <Field
            label={cloud ? t('apiToken') : t('accessToken')}
            htmlFor="api_token"
            hint={cloud ? t('apiTokenHint') : t('accessTokenHint')}
          >
            <Input id="api_token" name="api_token" type="password" required={cloud} autoComplete="off" />
          </Field>
          <Alert tone="info">{t('credentialsNotice')}</Alert>
          {cloud ? null : <Alert tone="info">{t('dataCenterNotice')}</Alert>}
        </>
      ) : (
        <>
          <Field label={t('file')} htmlFor="file" hint={t(`file_${source}_hint`, { limit: uploadLimitMb })}>
            <Input id="file" name="file" type="file" required accept={ACCEPT[source]} />
          </Field>
          {source === 'pdf' ? (
            <>
              <Field label={t('split')} htmlFor="split" hint={t('splitHint')}>
                <Select id="split" name="split" defaultValue="single">
                  <option value="single">{t('splitSingle')}</option>
                  <option value="h1">{t('splitH1')}</option>
                </Select>
              </Field>
              <Alert tone="info">{t('pdfNotice')}</Alert>
            </>
          ) : null}
        </>
      )}

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t('reading') : t('start')}
        </Button>
        {pending ? <span className="text-sm text-muted-foreground">{t('readingHint')}</span> : null}
      </div>
    </form>
  );
}

function valueOf(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement || field instanceof HTMLSelectElement ? field.value : '';
}

function uploadBody(form: HTMLFormElement, source: ImportSource): FormData {
  const data = new FormData();
  data.set('source', source);
  const field = form.elements.namedItem('file');
  const file = field instanceof HTMLInputElement ? field.files?.[0] : undefined;
  if (file) data.set('file', file);
  if (source === 'pdf') data.set('split', valueOf(form, 'split'));
  return data;
}

function messageOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : null;
}

function idOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}
