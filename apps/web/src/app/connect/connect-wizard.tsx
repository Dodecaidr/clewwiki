'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { CopyBlock } from '@/components/copy-block';
import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { locales } from '@/i18n/locale';
import type { Locale } from '@/i18n/locale';
import type { AgentHost, ConnectSnippet } from '@/lib/connect/snippets';
import { cn } from '@/lib/utils';

export interface HostSetup {
  host: AgentHost;
  snippets: ConnectSnippet[];
  /** The onboarding prompt for this host, in each language the page offers. */
  prompts: Record<Locale, string>;
}

const RECOMMENDED_SCOPES = ['identity:read', 'pages:read', 'pages:write'] as const;

function code(chunks: ReactNode) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{chunks}</code>;
}

function strong(chunks: ReactNode) {
  return <strong className="font-semibold">{chunks}</strong>;
}

function StepHeader({ number, title, description }: { number: number; title: string; description?: ReactNode }) {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs"
        >
          {number}
        </span>
        {title}
      </CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
  );
}

function ToggleGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  renderLabel,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  renderLabel: (value: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={cn(
            'rounded-(--radius-base) border px-3 py-1.5 text-sm transition-colors',
            option === value
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border hover:bg-secondary',
          )}
        >
          {renderLabel(option)}
        </button>
      ))}
    </div>
  );
}

export function ConnectWizard({
  baseUrl,
  httpEnabled,
  hosts,
  testCommand,
  isAdmin,
}: {
  baseUrl: string;
  httpEnabled: boolean;
  hosts: HostSetup[];
  testCommand: string;
  isAdmin: boolean;
}) {
  const t = useTranslations('connect');
  const [host, setHost] = useState<AgentHost>('claude-code');
  const [promptLocale, setPromptLocale] = useState<Locale>('en');

  const setup = hosts.find((entry) => entry.host === host) ?? hosts[0];
  if (!setup) return null;

  const operatorSnippet = setup.snippets.find((snippet) => snippet.id === 'operator-enable-http');
  const hostSnippets = setup.snippets.filter((snippet) => snippet.id !== 'operator-enable-http');

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        <p className="text-xs text-muted-foreground">
          {t.rich('instanceUrl', { url: baseUrl, code })}
        </p>
      </div>

      <Alert tone="error" className="grid gap-1">
        <p className="font-medium">{t('warningTitle')}</p>
        <p>{t.rich('warningBody', { code })}</p>
      </Alert>

      <Card>
        <StepHeader number={1} title={t('step1Title')} description={t('step1Intro')} />
        <CardBody className="grid gap-3 text-sm">
          <p>
            {t.rich(isAdmin ? 'step1Admin' : 'step1Editor', {
              link: (chunks) => (
                <Link href="/tokens" className="underline underline-offset-2">
                  {chunks}
                </Link>
              ),
            })}
          </p>
          <div className="grid gap-1">
            <p className="font-medium">{t('step1Scopes')}</p>
            <ul className="flex flex-wrap gap-2">
              {RECOMMENDED_SCOPES.map((scope) => (
                <li key={scope} className="rounded-(--radius-base) border border-border px-2 py-0.5 font-mono text-xs">
                  {scope}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t('step1ScopesHint')}</p>
          </div>
          <p className="text-muted-foreground">{t.rich('step1Env', { code, strong })}</p>
          <p className="text-xs text-muted-foreground">{t('step1NeverAsked')}</p>
        </CardBody>
      </Card>

      <Card>
        <StepHeader number={2} title={t('step2Title')} description={t('step2Intro')} />
        <CardBody>
          <ToggleGroup
            label={t('step2Title')}
            options={hosts.map((entry) => entry.host)}
            value={host}
            onChange={setHost}
            renderLabel={(value) => t(`host.${value}`)}
          />
        </CardBody>
      </Card>

      <Card>
        <StepHeader number={3} title={t('step3Title')} description={t(`hostIntro.${host}`)} />
        <CardBody className="grid gap-5 text-sm">
          {!httpEnabled ? (
            <Alert className="grid gap-2">
              <p>{t.rich('httpDisabled', { code })}</p>
              {operatorSnippet ? (
                <CopyBlock code={operatorSnippet.code} label={t('snippet.operator-enable-http.title')} />
              ) : null}
            </Alert>
          ) : null}

          {hostSnippets.map((snippet) => (
            <div key={snippet.id} className="grid gap-1.5">
              <CopyBlock code={snippet.code} label={t(`snippet.${snippet.id}.title`)} />
              <p className="text-xs text-muted-foreground">
                {t.rich(`snippet.${snippet.id}.note`, { code })}
              </p>
            </div>
          ))}

          <div className="grid gap-1.5 border-t border-border pt-4">
            <p className="font-medium">{t('testTitle')}</p>
            <p className="text-xs text-muted-foreground">{t.rich('testHint', { code })}</p>
            <CopyBlock code={testCommand} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <StepHeader number={4} title={t('step4Title')} description={t('step4Intro')} />
        <CardBody className="grid gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">{t('promptLanguage')}</span>
            <ToggleGroup
              label={t('promptLanguage')}
              options={locales}
              value={promptLocale}
              onChange={setPromptLocale}
              renderLabel={(value) => t(`promptLocale.${value}`)}
            />
          </div>
          <div lang={promptLocale}>
            <CopyBlock code={setup.prompts[promptLocale]} wrap />
          </div>
          <p className="text-xs text-muted-foreground">{t('step4Note')}</p>
        </CardBody>
      </Card>
    </div>
  );
}
