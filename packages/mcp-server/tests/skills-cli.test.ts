import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeRest } from './helpers/fake-rest.ts';
import type { FakeRest } from './helpers/fake-rest.ts';
import {
  parseSkillsArgs,
  resolveSkillDirectory,
  runSkillsCommand,
  SkillsCliError,
} from '../src/skills-cli.ts';
import type { SkillsCliIo } from '../src/skills-cli.ts';

const TOKEN = 'skills-cli-token';

/** Collects what a person would see, so a run can be asserted on as output. */
function recorder(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: SkillsCliIo = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    home: () => home,
  };
  return { io, out, err, get stdout() { return out.join(''); }, get stderr() { return err.join(''); } };
}

describe('skills argument parsing', () => {
  it('reads the install command the documentation prints', () => {
    expect(parseSkillsArgs(['install', '--space', 'sh', '--dir', '~/.claude/skills', '--only', 'a,b'])).toEqual({
      action: 'install',
      space: 'SH',
      dir: '~/.claude/skills',
      only: ['a', 'b'],
      force: false,
    });
    expect(parseSkillsArgs(['list', '--space', 'MAIN'])).toMatchObject({ action: 'list', space: 'MAIN' });
    expect(parseSkillsArgs([]).action).toBe('help');
  });

  it('refuses a missing space, an unknown option and a flag with no value', () => {
    expect(() => parseSkillsArgs(['install'])).toThrow(SkillsCliError);
    expect(() => parseSkillsArgs(['install', '--space', 'MAIN', '--wat'])).toThrow(SkillsCliError);
    expect(() => parseSkillsArgs(['install', '--space'])).toThrow(SkillsCliError);
    expect(() => parseSkillsArgs(['install', '--space', 'not a key'])).toThrow(SkillsCliError);
    expect(() => parseSkillsArgs(['fly', '--space', 'MAIN'])).toThrow(SkillsCliError);
  });
});

describe('skill target paths', () => {
  it('writes one directory below the target and nowhere else', () => {
    expect(resolveSkillDirectory('/tmp/skills', 'release-checks')).toBe('/tmp/skills/release-checks');
  });

  it('refuses every slug that would escape the target directory', () => {
    for (const slug of [
      '..',
      '../evil',
      '../../etc',
      'a/b',
      '/etc/passwd',
      './x',
      'x/../../y',
      '.hidden',
      'UPPER',
      'has space',
      'trailing-',
      '',
      'x'.repeat(81),
    ]) {
      expect(() => resolveSkillDirectory('/tmp/skills', slug), slug).toThrow(SkillsCliError);
    }
  });
});

describe('clewwiki-mcp skills', () => {
  let rest: FakeRest;
  let home: string;
  let dir: string;

  beforeAll(async () => {
    rest = await startFakeRest({ token: TOKEN, scopes: ['pages:read'] });
    home = await mkdtemp(path.join(tmpdir(), 'clewwiki-skills-'));
    dir = path.join(home, '.claude', 'skills');
  });

  afterAll(async () => {
    await rest.close();
    await rm(home, { recursive: true, force: true });
  });

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { CLEWWIKI_URL: rest.url, CLEWWIKI_TOKEN: TOKEN, ...extra };
  }

  it("lists a space's skills without writing anything", async () => {
    const io = recorder(home);
    const status = await runSkillsCommand(['list', '--space', 'MAIN'], env(), io.io);
    expect(status).toBe(0);
    expect(io.stdout).toContain('release-checks');
    expect(io.stdout).toContain('Use before tagging a release.');
    expect(io.stdout).toContain('db-migrations');
  });

  it('writes <dir>/<slug>/SKILL.md for every skill and prints what it wrote', async () => {
    const io = recorder(home);
    const status = await runSkillsCommand(['install', '--space', 'MAIN'], env(), io.io);
    expect(status).toBe(0);

    const file = path.join(dir, 'release-checks', 'SKILL.md');
    const contents = await readFile(file, 'utf8');
    expect(contents).toMatch(/^---\nname: Release checks\n/);
    expect(contents).toContain('description: Use before tagging a release.');
    expect(contents).toContain('Run the suite, then tag.');
    expect(io.stdout).toContain(file);
    expect(io.stdout).toContain('2 written');

    await expect(readFile(path.join(dir, 'db-migrations', 'SKILL.md'), 'utf8')).resolves.toContain(
      'Generate, then review the SQL.',
    );
  });

  it('installs one named skill with --only', async () => {
    const target = path.join(home, 'only');
    const io = recorder(home);
    const status = await runSkillsCommand(
      ['install', '--space', 'MAIN', '--dir', target, '--only', 'db-migrations'],
      env(),
      io.io,
    );
    expect(status).toBe(0);
    await expect(readFile(path.join(target, 'db-migrations', 'SKILL.md'), 'utf8')).resolves.toContain(
      'Migrations',
    );
    await expect(readFile(path.join(target, 'release-checks', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('says so when --only names a skill the space does not have', async () => {
    const io = recorder(home);
    const status = await runSkillsCommand(
      ['install', '--space', 'MAIN', '--dir', path.join(home, 'missing'), '--only', 'nope'],
      env(),
      io.io,
    );
    expect(status).toBe(1);
    expect(io.stderr).toContain('no skill "nope" in space MAIN');
  });

  it('reports a second run as unchanged rather than rewriting the files', async () => {
    const io = recorder(home);
    const status = await runSkillsCommand(['install', '--space', 'MAIN'], env(), io.io);
    expect(status).toBe(0);
    expect(io.stdout).toContain('unchanged');
    expect(io.stdout).toContain('0 written');
  });

  it('keeps a SKILL.md it did not write, and overwrites it only with --force', async () => {
    const target = path.join(home, 'handwritten');
    await mkdir(path.join(target, 'release-checks'), { recursive: true });
    const file = path.join(target, 'release-checks', 'SKILL.md');
    await writeFile(file, '---\nname: mine\ndescription: hand written\n---\nDo not clobber me.\n', 'utf8');

    const kept = recorder(home);
    const status = await runSkillsCommand(
      ['install', '--space', 'MAIN', '--dir', target, '--only', 'release-checks'],
      env(),
      kept.io,
    );
    expect(status).toBe(2);
    expect(kept.stderr).toContain('--force');
    await expect(readFile(file, 'utf8')).resolves.toContain('Do not clobber me.');

    const forced = recorder(home);
    expect(
      await runSkillsCommand(
        ['install', '--space', 'MAIN', '--dir', target, '--only', 'release-checks', '--force'],
        env(),
        forced.io,
      ),
    ).toBe(0);
    await expect(readFile(file, 'utf8')).resolves.toContain('Run the suite, then tag.');
  });

  it('also keeps a file it wrote but somebody has edited since', async () => {
    const target = path.join(home, 'edited');
    expect(
      await runSkillsCommand(
        ['install', '--space', 'MAIN', '--dir', target, '--only', 'release-checks'],
        env(),
        recorder(home).io,
      ),
    ).toBe(0);
    const file = path.join(target, 'release-checks', 'SKILL.md');
    await writeFile(file, 'edited by a person\n', 'utf8');

    const io = recorder(home);
    expect(
      await runSkillsCommand(
        ['install', '--space', 'MAIN', '--dir', target, '--only', 'release-checks'],
        env(),
        io.io,
      ),
    ).toBe(2);
    expect(io.stderr).toContain('edited afterwards');
    await expect(readFile(file, 'utf8')).resolves.toBe('edited by a person\n');
  });

  it('refuses to follow a symbolic link out of the target directory', async () => {
    const target = path.join(home, 'linked');
    const elsewhere = path.join(home, 'elsewhere');
    await mkdir(target, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, path.join(target, 'release-checks'), 'dir');

    const io = recorder(home);
    const status = await runSkillsCommand(
      ['install', '--space', 'MAIN', '--dir', target, '--only', 'release-checks'],
      env(),
      io.io,
    );
    expect(status).toBe(2);
    expect(io.stderr).toContain('symbolic link');
    await expect(readFile(path.join(elsewhere, 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('refuses to run without a URL or a token, and refuses an http URL off this machine', async () => {
    const noUrl = recorder(home);
    expect(await runSkillsCommand(['list', '--space', 'MAIN'], { CLEWWIKI_TOKEN: TOKEN }, noUrl.io)).toBe(1);
    expect(noUrl.stderr).toContain('CLEWWIKI_URL');

    const noToken = recorder(home);
    expect(await runSkillsCommand(['list', '--space', 'MAIN'], { CLEWWIKI_URL: rest.url }, noToken.io)).toBe(1);
    expect(noToken.stderr).toContain('CLEWWIKI_TOKEN');

    const insecure = recorder(home);
    expect(
      await runSkillsCommand(
        ['list', '--space', 'MAIN'],
        { CLEWWIKI_URL: 'http://wiki.example.com', CLEWWIKI_TOKEN: TOKEN },
        insecure.io,
      ),
    ).toBe(1);
    expect(insecure.stderr).toContain('unencrypted');
  });

  it("passes the instance's refusal through when the token cannot read", async () => {
    const io = recorder(home);
    const status = await runSkillsCommand(
      ['list', '--space', 'MAIN'],
      { CLEWWIKI_URL: rest.url, CLEWWIKI_TOKEN: 'wrong-token' },
      io.io,
    );
    expect(status).toBe(1);
    expect(io.stderr).toContain('Invalid or expired token');
  });

  it('prints its own usage and nothing else for --help', async () => {
    const io = recorder(home);
    expect(await runSkillsCommand(['--help'], {}, io.io)).toBe(0);
    expect(io.stdout).toContain('clewwiki-mcp skills install --space KEY');
    expect(io.stderr).toBe('');
  });
});
