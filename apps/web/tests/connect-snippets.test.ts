import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import ru from '../messages/ru.json';
import {
  AGENT_HOSTS,
  buildConnectSnippets,
  buildOnboardingPrompt,
  buildTestCommand,
  primarySnippet,
} from '@/lib/connect/snippets';
import type { ConnectOptions, PromptTranslator } from '@/lib/connect/snippets';
import { generateAgentToken } from '@/lib/agent-token-crypto';

const URL_ = 'https://wiki.example.com';
const enabled: ConnectOptions = { baseUrl: `${URL_}/`, httpEnabled: true };
const disabled: ConnectOptions = { baseUrl: URL_, httpEnabled: false };

function translator(locale: 'en' | 'ru'): PromptTranslator {
  const t = createTranslator({
    locale,
    messages: locale === 'en' ? en : ru,
    namespace: 'connectPrompt',
  });
  return (key, values) => t(key as 'body', values);
}

/** Every string a person could copy from the page for these options. */
function everything(options: ConnectOptions): string[] {
  return AGENT_HOSTS.flatMap((host) => [
    ...buildConnectSnippets(host, options).map((snippet) => snippet.code),
    buildOnboardingPrompt(translator('en'), host, options),
    buildOnboardingPrompt(translator('ru'), host, options),
  ]).concat(buildTestCommand(options));
}

describe('connection snippets', () => {
  it('fills in the instance URL without a doubled slash', () => {
    for (const code of everything(enabled)) {
      expect(code).not.toContain('example.com//');
    }
    expect(primarySnippet('claude-code', enabled).code).toBe(
      `claude mcp add --transport http clewwiki ${URL_}/mcp --header "Authorization: Bearer $CLEWWIKI_TOKEN"`,
    );
    expect(buildTestCommand(enabled)).toBe(
      `curl -H "Authorization: Bearer $CLEWWIKI_TOKEN" ${URL_}/api/v1/me`,
    );
  });

  it('uses the stdio commands described in the docs', () => {
    const codes = buildConnectSnippets('claude-code', enabled).map((snippet) => snippet.code);
    expect(codes).toContain(
      `claude mcp add clewwiki -e CLEWWIKI_URL=${URL_} -e CLEWWIKI_TOKEN=$CLEWWIKI_TOKEN -- npx -y @clewwiki/mcp-server`,
    );
    expect(codes.some((code) => code.includes('-- node /path/to/clewwiki/packages/mcp-server/dist/bin.js'))).toBe(true);

    const cursor = JSON.parse(primarySnippet('cursor', disabled).code) as {
      mcpServers: { clewwiki: { env: Record<string, string> } };
    };
    expect(cursor.mcpServers.clewwiki.env.CLEWWIKI_URL).toBe(URL_);

    const codex = primarySnippet('codex', disabled).code;
    expect(codex).toContain('[mcp_servers.clewwiki]');
    expect(codex).toContain(`CLEWWIKI_URL = "${URL_}"`);
  });

  it('every host refers to the token only through the CLEWWIKI_TOKEN variable', () => {
    for (const options of [enabled, disabled]) {
      for (const host of AGENT_HOSTS) {
        for (const snippet of buildConnectSnippets(host, options)) {
          if (snippet.id === 'operator-enable-http') continue;
          expect(snippet.code).toContain('CLEWWIKI_TOKEN');
        }
      }
    }
  });

  it('omits every HTTP variant when MCP over HTTP is disabled', () => {
    for (const host of AGENT_HOSTS) {
      const snippets = buildConnectSnippets(host, disabled);
      const hostSnippets = snippets.filter((snippet) => snippet.id !== 'operator-enable-http');
      expect(hostSnippets.length).toBeGreaterThan(0);
      expect(hostSnippets.every((snippet) => snippet.transport === 'stdio')).toBe(true);
      expect(hostSnippets.some((snippet) => snippet.code.includes(`${URL_}/mcp`))).toBe(false);
      expect(snippets.find((snippet) => snippet.id === 'operator-enable-http')?.code).toBe(
        'MCP_HTTP_ENABLED=true',
      );
      expect(primarySnippet(host, disabled).transport).toBe('stdio');
    }
  });

  it('offers HTTP first when it is enabled', () => {
    for (const host of AGENT_HOSTS) {
      expect(primarySnippet(host, enabled).transport).toBe('http');
      expect(
        buildConnectSnippets(host, enabled).some((snippet) => snippet.id === 'operator-enable-http'),
      ).toBe(false);
    }
  });

  it('never interpolates a real token, even one sitting in the environment', () => {
    const real = generateAgentToken().token;
    const previous = process.env.CLEWWIKI_TOKEN;
    process.env.CLEWWIKI_TOKEN = real;
    try {
      for (const code of [...everything(enabled), ...everything(disabled)]) {
        expect(code).not.toContain(real);
        expect(code).not.toMatch(/cww_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      }
    } finally {
      if (previous === undefined) delete process.env.CLEWWIKI_TOKEN;
      else process.env.CLEWWIKI_TOKEN = previous;
    }
  });
});

describe('onboarding prompt', () => {
  it.each(['en', 'ru'] as const)('is filled in for %s', (locale) => {
    const prompt = buildOnboardingPrompt(translator(locale), 'claude-code', enabled);
    expect(prompt).toContain(URL_);
    expect(prompt).toContain('`clewwiki`');
    expect(prompt).toContain(primarySnippet('claude-code', enabled).code);
    expect(prompt).toContain('`CLEWWIKI_TOKEN`');
    for (const tool of [
      'wiki.list_spaces',
      'wiki.search',
      'wiki.list_pages',
      'wiki.get_page',
      'wiki.create_page',
      'link_to_page_id',
      'wiki.claim',
      'wiki.write_page',
      'base_content_hash',
      'wiki.renew_claim',
      'wiki.release_claim',
      'STALE_BASE',
      'wiki.post_note',
      'wiki.get_presence',
    ]) {
      expect(prompt).toContain(tool);
    }
    // No placeholder was left unfilled.
    expect(prompt).not.toMatch(/\{(url|server|command|tokenVar)\}/);
  });

  it('includes the stdio command when HTTP is disabled', () => {
    const prompt = buildOnboardingPrompt(translator('en'), 'claude-code', disabled);
    expect(prompt).toContain('npx -y @clewwiki/mcp-server');
    expect(prompt).not.toContain('--transport http');
  });
});
