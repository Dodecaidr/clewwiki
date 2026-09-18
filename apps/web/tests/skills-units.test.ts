import { describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import ru from '../messages/ru.json';
import { isPageServiceError } from '@/lib/pages/errors';
import {
  buildSkillsInstallCommand,
  buildSkillsListCommand,
  DEFAULT_SKILLS_DIR,
  skillInstallPath,
  skillsInstallInvocation,
} from '@/lib/skills/install';
import { assertSkillSlug, normalizeSkillInput } from '@/lib/skills/validate';
import { rulesTemplate } from '@/lib/spaces/rules';
import { locales } from '@/i18n/locale';

const URL_ = 'https://wiki.example.com';

function refusal(run: () => unknown): { code: string; message: string; details?: Record<string, unknown> } {
  try {
    run();
  } catch (error) {
    if (isPageServiceError(error)) {
      return { code: error.code, message: error.message, details: error.details };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the install command', () => {
  it('names the space, the instance and the token variable, and never a token', () => {
    const command = buildSkillsInstallCommand({ baseUrl: `${URL_}/`, spaceKey: 'SH' });
    expect(command).toBe(
      `CLEWWIKI_URL=${URL_} CLEWWIKI_TOKEN=$CLEWWIKI_TOKEN npx -y @clewwiki/mcp-server skills install --space SH`,
    );
    expect(command).not.toContain('example.com//');

    expect(buildSkillsInstallCommand({ baseUrl: URL_, spaceKey: 'SH', slug: 'release-checks' })).toContain(
      '--only release-checks',
    );
    expect(
      buildSkillsInstallCommand({ baseUrl: URL_, spaceKey: 'SH', dir: '.claude/skills' }),
    ).toContain('--dir .claude/skills');

    expect(buildSkillsListCommand({ baseUrl: URL_, spaceKey: 'SH' })).toContain('skills list --space SH');
    expect(skillsInstallInvocation({ spaceKey: 'SH' })).toBe('clewwiki-mcp skills install --space SH');
  });

  it('says where a skill lands', () => {
    expect(DEFAULT_SKILLS_DIR).toBe('~/.claude/skills');
    expect(skillInstallPath('release-checks')).toBe('~/.claude/skills/release-checks/SKILL.md');
    expect(skillInstallPath('x', '/tmp/skills/')).toBe('/tmp/skills/x/SKILL.md');
  });
});

describe('skill input', () => {
  it('trims, lowercases tags and drops duplicates', () => {
    const normalized = normalizeSkillInput(
      {
        name: '  Release checks ',
        description: ' Use before tagging a release. ',
        version: ' 1.2.0 ',
        tags: ['Release', 'release', ' ci '],
        body: '# Body\n',
      },
      { partial: false },
    );
    expect(normalized).toEqual({
      name: 'Release checks',
      description: 'Use before tagging a release.',
      version: '1.2.0',
      tags: ['release', 'ci'],
      body: '# Body\n',
    });
  });

  it('takes the fields out of a SKILL.md and stores the body without them', () => {
    const normalized = normalizeSkillInput(
      { body: '---\nname: From front matter\ndescription: And its description.\n---\n\n# Body\n' },
      { partial: false },
    );
    expect(normalized.name).toBe('From front matter');
    expect(normalized.description).toBe('And its description.');
    expect(normalized.body).toBe('# Body\n');
  });

  it('lets an explicit field win over the front matter', () => {
    const normalized = normalizeSkillInput(
      {
        name: 'Explicit',
        body: '---\nname: From front matter\ndescription: d\n---\nBody\n',
      },
      { partial: false },
    );
    expect(normalized.name).toBe('Explicit');
    expect(normalized.description).toBe('d');
  });

  it('refuses front matter that does not parse, naming the field and the line', () => {
    const failure = refusal(() =>
      normalizeSkillInput({ body: '---\nname: x\nlicense: MIT\n---\n' }, { partial: false }),
    );
    expect(failure.code).toBe('validation');
    expect(failure.details).toMatchObject({ front_matter: true });
    expect(failure.details?.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'license' })]),
    );
  });

  it('measures the body in bytes, so a Cyrillic body cannot slip past the limit', () => {
    // 200 000 Cyrillic characters are 400 000 bytes: under a character limit,
    // over the byte one.
    const failure = refusal(() =>
      normalizeSkillInput({ name: 'x', description: 'y', body: 'я'.repeat(200_000) }, { partial: false }),
    );
    expect(failure.details?.limit_bytes).toBe(262_144);
  });

  it('refuses a multi-line description and a tag that is not a word', () => {
    expect(refusal(() => normalizeSkillInput({ description: 'a\nb' }, { partial: true })).message).toContain(
      'one line',
    );
    expect(refusal(() => normalizeSkillInput({ tags: ['Not A Tag'] }, { partial: true })).message).toContain(
      'not a usable tag',
    );
  });

  it('requires a name and a description on a create and neither on a patch', () => {
    expect(refusal(() => normalizeSkillInput({}, { partial: false })).message).toContain('name');
    expect(normalizeSkillInput({}, { partial: true })).toEqual({});
  });

  it('holds a slug to what a directory name may be', () => {
    expect(assertSkillSlug(' Release-Checks ')).toBe('release-checks');
    for (const slug of ['../escape', 'a/b', '.hidden', 'has space', 'trailing-', '']) {
      expect(refusal(() => assertSkillSlug(slug)).code, slug).toBe('validation');
    }
  });
});

describe('the rules starter template', () => {
  it('ships in every locale the interface has', () => {
    for (const locale of locales) {
      const template = rulesTemplate(locale);
      expect(template.title.trim().length, locale).toBeGreaterThan(0);
      expect(template.body.length, locale).toBeGreaterThan(200);
    }
  });

  it('carries the five headings the rules are meant to answer, in both languages', () => {
    expect(rulesTemplate('en').body).toContain('## Stack and versions');
    expect(rulesTemplate('en').body).toContain('## What agents must not do');
    expect(rulesTemplate('en').body).toContain('## Where decisions live');
    expect(rulesTemplate('en').body).toContain('## Review expectations');
    expect(rulesTemplate('ru').body).toContain('## Стек и версии');
    expect(rulesTemplate('ru').body).toContain('## Чего агентам делать нельзя');
  });

  it('states no fact about anybody: every bullet is a placeholder', () => {
    for (const locale of locales) {
      const bullets = rulesTemplate(locale)
        .body.split('\n')
        .filter((line) => line.startsWith('- '));
      expect(bullets.length, locale).toBeGreaterThan(5);
      for (const bullet of bullets) {
        expect(bullet, `${locale}: ${bullet}`).toContain('<!--');
      }
    }
  });
});

describe('the onboarding prompt', () => {
  it.each(['en', 'ru'] as const)('tells an agent to read the rules and the skills first (%s)', (locale) => {
    const body = (locale === 'en' ? en : ru).connectPrompt.body;
    expect(body).toContain('wiki.get_rules');
    expect(body).toContain('wiki.list_skills');
    expect(body).toContain('wiki.get_skill');
    // Before the writing loop, not after it.
    expect(body.indexOf('wiki.get_rules')).toBeLessThan(body.indexOf('wiki.claim'));

    const steps = body.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(steps.map((line) => Number.parseInt(line, 10))).toEqual(
      steps.map((_line, index) => index + 1),
    );
  });
});
