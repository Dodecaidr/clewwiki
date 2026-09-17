import { redirect } from 'next/navigation';
import { createTranslator } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ConnectWizard } from './connect-wizard';
import type { HostSetup } from './connect-wizard';
import { locales } from '@/i18n/locale';
import type { Locale } from '@/i18n/locale';
import {
  AGENT_HOSTS,
  buildConnectSnippets,
  buildOnboardingPrompt,
  buildTestCommand,
} from '@/lib/connect/snippets';
import type { ConnectOptions } from '@/lib/connect/snippets';
import { getAuthBaseUrl, isMcpHttpEnabled } from '@/lib/env';
import { getSessionContext } from '@/lib/session';
import enMessages from '../../../messages/en.json';
import ruMessages from '../../../messages/ru.json';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('connect');
  return { title: t('title') };
}

const promptMessages: Record<Locale, typeof enMessages> = { en: enMessages, ru: ruMessages };

/**
 * "Connect an agent": copyable commands and an onboarding prompt.
 *
 * Everything is computed here from two pieces of instance configuration — the
 * public URL and whether `/mcp` is mounted. The page never asks for, receives
 * or renders a token; every snippet names the variable the token lives in.
 */
export default async function ConnectPage() {
  const session = await getSessionContext();
  if (!session) {
    redirect('/login');
  }

  const options: ConnectOptions = {
    baseUrl: getAuthBaseUrl(),
    httpEnabled: isMcpHttpEnabled(),
  };

  const translators = Object.fromEntries(
    locales.map((locale) => [
      locale,
      createTranslator({
        locale,
        messages: promptMessages[locale],
        namespace: 'connectPrompt',
      }),
    ]),
  ) as Record<Locale, ReturnType<typeof createTranslator<typeof enMessages, 'connectPrompt'>>>;

  const hosts: HostSetup[] = AGENT_HOSTS.map((host) => ({
    host,
    snippets: buildConnectSnippets(host, options),
    prompts: Object.fromEntries(
      locales.map((locale) => [
        locale,
        buildOnboardingPrompt(
          (key, values) => translators[locale](key as 'body', values),
          host,
          options,
        ),
      ]),
    ) as Record<Locale, string>,
  }));

  return (
    <ConnectWizard
      baseUrl={options.baseUrl}
      httpEnabled={options.httpEnabled}
      hosts={hosts}
      testCommand={buildTestCommand(options)}
      isAdmin={session.role === 'admin'}
    />
  );
}
