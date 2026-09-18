import { describe, expect, it } from 'vitest';

import {
  buildSkillMarkdown,
  describeSkillFrontMatterIssue,
  isSkillSlug,
  isSkillTag,
  parseSkillFrontMatter,
} from '../src/skill';

describe('skill slugs and tags', () => {
  it('accepts lowercase words joined by single hyphens and nothing else', () => {
    for (const value of ['a', 'release-checks', 'db2-migrations', 'x'.repeat(80)]) {
      expect(isSkillSlug(value), value).toBe(true);
    }
    for (const value of [
      '',
      'Release',
      'release_checks',
      'release--checks',
      '-release',
      'release-',
      'a/b',
      '..',
      '.hidden',
      'release checks',
      'x'.repeat(81),
    ]) {
      expect(isSkillSlug(value), value).toBe(false);
    }
    expect(isSkillTag('ci')).toBe(true);
    expect(isSkillTag('CI')).toBe(false);
  });
});

describe('skill front matter', () => {
  it('leaves a body with no front matter alone', () => {
    const result = parseSkillFrontMatter('# Heading\n\nText.\n');
    expect(result.found).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.body).toBe('# Heading\n\nText.\n');
  });

  it('reads the fields this instance stores and hands back the body under them', () => {
    const result = parseSkillFrontMatter(
      '---\nname: Release checks\ndescription: Use before tagging a release.\nversion: 1.2.0\ntags: [release, ci]\n---\n\n# Release checks\n\nRun the suite.\n',
    );
    expect(result.issues).toEqual([]);
    expect(result.fields).toEqual({
      name: 'Release checks',
      description: 'Use before tagging a release.',
      version: '1.2.0',
      tags: ['release', 'ci'],
    });
    expect(result.body).toBe('# Release checks\n\nRun the suite.\n');
  });

  it('accepts a description holding a colon when it is quoted', () => {
    const result = parseSkillFrontMatter(
      '---\nname: x\ndescription: "Use when: the build fails"\n---\nBody\n',
    );
    expect(result.issues).toEqual([]);
    expect(result.fields.description).toBe('Use when: the build fails');
  });

  it('names the problem and its line for every way the front matter can be wrong', () => {
    const unterminated = parseSkillFrontMatter('---\nname: x\ndescription: y\nBody\n');
    expect(unterminated.issues[0]?.message).toContain('never closes');

    const missing = parseSkillFrontMatter('---\nname: x\n---\nBody\n');
    expect(missing.issues).toEqual([
      expect.objectContaining({ path: 'description', line: 1 }),
    ]);

    const empty = parseSkillFrontMatter('---\nname:\ndescription: y\n---\n');
    expect(empty.issues[0]).toMatchObject({ path: 'name', line: 2 });

    const unknown = parseSkillFrontMatter('---\nname: x\ndescription: y\nlicense: MIT\n---\n');
    expect(unknown.issues[0]).toMatchObject({ path: 'license', line: 4 });
    expect(unknown.issues[0]?.message).toContain('Unknown front matter key');

    const notAPair = parseSkillFrontMatter('---\nname: x\ndescription: y\nnonsense\n---\n');
    expect(notAPair.issues[0]).toMatchObject({ path: '', line: 4 });

    const nested = parseSkillFrontMatter('---\nname: x\ndescription: y\n  nested: z\n---\n');
    expect(nested.issues[0]?.message).toContain('Indented lines');

    const twice = parseSkillFrontMatter('---\nname: x\nname: z\ndescription: y\n---\n');
    expect(twice.issues[0]).toMatchObject({ path: 'name', line: 3 });

    expect(describeSkillFrontMatterIssue({ path: 'name', line: 2, message: 'must not be empty' })).toBe(
      'The SKILL.md front matter is not valid: "name" at line 2: must not be empty',
    );
  });

  it('reads a document written with CRLF line endings', () => {
    const result = parseSkillFrontMatter('---\r\nname: x\r\ndescription: y\r\n---\r\nBody\r\n');
    expect(result.issues).toEqual([]);
    expect(result.fields).toEqual({ name: 'x', description: 'y' });
    expect(result.body).toBe('Body\n');
  });
});

describe('building a SKILL.md', () => {
  it('rebuilds a file the parser reads back unchanged', () => {
    const markdown = buildSkillMarkdown({
      name: 'Release checks',
      description: 'Use before tagging a release.',
      version: '1.2.0',
      tags: ['release', 'ci'],
      body: '# Release checks\n\nRun the suite.\n',
    });
    expect(markdown.startsWith('---\nname: Release checks\n')).toBe(true);

    const round = parseSkillFrontMatter(markdown);
    expect(round.issues).toEqual([]);
    expect(round.fields).toEqual({
      name: 'Release checks',
      description: 'Use before tagging a release.',
      version: '1.2.0',
      tags: ['release', 'ci'],
    });
    expect(round.body).toBe('# Release checks\n\nRun the suite.\n');
  });

  it('quotes a value that would otherwise change what YAML reads', () => {
    const markdown = buildSkillMarkdown({
      name: 'x',
      description: 'Use when: the build fails # and only then',
      body: '',
    });
    expect(markdown).toContain('description: "Use when: the build fails # and only then"');
    expect(parseSkillFrontMatter(markdown).fields.description).toBe(
      'Use when: the build fails # and only then',
    );
  });

  it('leaves out the optional fields when there are none', () => {
    const markdown = buildSkillMarkdown({ name: 'x', description: 'y', version: null, body: 'Body' });
    // One blank line between the fence and the body, which is how the
    // convention's own examples read; the parser trims it back off.
    expect(markdown).toBe('---\nname: x\ndescription: y\n---\n\nBody\n');
  });
});
