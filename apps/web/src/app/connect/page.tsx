import { redirect } from 'next/navigation';
import { createTranslator } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { ConnectWizard } from './connect-wizard';
import type { HostSetup, SkillsSetup } from './connect-wizard';
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
import { buildSkillsInstallCommand, buildSkillsListCommand } from '@/lib/skills/install';
import enMessages from '../../../messages/en.json';
import ruMessages from '../../../messages/ru.json';
import { findSpaces } from '@/lib/spaces/visibility';

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

  // The install command has to name a space, and a command with a placeholder
  // in it is one a person has to think about before running. So the keys the
  // reader can actually reach are offered, and `KEY` is only the fallback for
  // a workspace with no spaces yet.
  const spaces = await findSpaces(session);
  const spaceKeys = spaces.map((space) => space.key);
  const keysForCommands = spaceKeys.length > 0 ? spaceKeys : ['KEY'];
  const skills: SkillsSetup = {
    spaceKeys,
    install: Object.fromEntries(
      keysForCommands.map((key) => [
        key,
        buildSkillsInstallCommand({ baseUrl: options.baseUrl, spaceKey: key }),
      ]),
    ),
    list: Object.fromEntries(
      keysForCommands.map((key) => [
        key,
        buildSkillsListCommand({ baseUrl: options.baseUrl, spaceKey: key }),
      ]),
    ),
  };

  return (
    <ConnectWizard
      baseUrl={options.baseUrl}
      httpEnabled={options.httpEnabled}
      hosts={hosts}
      testCommand={buildTestCommand(options)}
      skills={skills}
      isAdmin={session.role === 'admin'}
    />
  );
}
