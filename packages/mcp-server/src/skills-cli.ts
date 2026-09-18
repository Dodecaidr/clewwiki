import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { ClewwikiToolError } from './errors.ts';
import { assertSecureBaseUrl, ClewwikiRestClient } from './rest-client.ts';
import type { FetchLike } from './rest-client.ts';
import { MCP_SERVER_VERSION } from './version.ts';

/**
 * `clewwiki-mcp skills` — putting a project's skills on the machine an agent
 * runs on, in one command.
 *
 * This is the half of the feature a person performs. The MCP tools let an agent
 * *read* a space's skills; agent hosts, however, load skills from directories
 * on disk (`~/.claude/skills/<slug>/SKILL.md` and the project-local equivalents),
 * which no tool call can write to. So the package that people already run as
 * their MCP server also carries the command that fetches those files.
 *
 * Three rules govern the writing, and they are the reason this is not a
 * `curl | sh`:
 *
 * - **Nothing is executed.** A skill body is text written by someone else. It is
 *   fetched and written to a file, never interpreted, and the command prints
 *   what it wrote rather than acting on it.
 * - **Nothing is written outside the target directory.** A slug is validated
 *   against the same lowercase-hyphen pattern the server enforces, the joined
 *   path is resolved and compared with the target directory, and any component
 *   that is a symbolic link is refused rather than followed — a link is exactly
 *   how a path that passes a string check still lands somewhere else.
 * - **Nothing is overwritten blindly.** Each written skill leaves a small
 *   manifest beside it recording the hash of what was written. A `SKILL.md`
 *   that does not match its manifest — edited by hand, or never written by this
 *   command — is left alone and reported, unless `--force` says otherwise.
 */

export const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_SLUG_LENGTH = 80;

/** The file an agent host reads, and the record this command keeps beside it. */
export const SKILL_FILENAME = 'SKILL.md';
export const MANIFEST_FILENAME = '.clewwiki-skill.json';

/** Where agent hosts look for locally installed skills, by convention. */
export const DEFAULT_SKILLS_DIR = path.join('~', '.claude', 'skills');

export interface SkillsCliIo {
  out(text: string): void;
  err(text: string): void;
  home(): string;
}

export const processIo: SkillsCliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  home: () => homedir(),
};

export const SKILLS_USAGE = `clewwiki-mcp skills ${MCP_SERVER_VERSION}

Install a clewwiki space's skills on this machine, or list them.

  clewwiki-mcp skills list    --space KEY
  clewwiki-mcp skills install --space KEY [--dir DIR] [--only a,b] [--force]

Options:

  --space KEY   The space key, as wiki.list_spaces reports it (for example SH).
  --dir DIR     Where to write. Default ${DEFAULT_SKILLS_DIR}; agent hosts read
                skills from directories like this one.
  --only a,b    Install just these slugs instead of every skill in the space.
  --force       Overwrite a SKILL.md this command did not write, or one that was
                edited after it did. Without it, such a file is left alone.

Environment:

  CLEWWIKI_URL     Base URL of the instance, for example https://wiki.example.com
  CLEWWIKI_TOKEN   An agent token with the pages:read scope

Skill bodies are stored text written by other people. They are written to disk
as files and never executed by this command.
`;

/* ------------------------------------------------------------------ */
/* Argument parsing                                                    */
/* ------------------------------------------------------------------ */

export interface SkillsCommand {
  action: 'list' | 'install' | 'help';
  space: string;
  dir?: string;
  only?: string[];
  force: boolean;
}

export class SkillsCliError extends Error {}

const FLAGS_WITH_VALUES = new Set(['--space', '--dir', '--only']);

export function parseSkillsArgs(args: readonly string[]): SkillsCommand {
  const [action, ...rest] = args;
  if (action === undefined || action === '--help' || action === '-h' || action === 'help') {
    return { action: 'help', space: '', force: false };
  }
  if (action !== 'list' && action !== 'install') {
    throw new SkillsCliError(`unknown skills command "${action}". Run "clewwiki-mcp skills --help".`);
  }

  const command: SkillsCommand = { action, space: '', force: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--force') {
      command.force = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { action: 'help', space: '', force: false };
    if (!FLAGS_WITH_VALUES.has(arg)) {
      throw new SkillsCliError(`unknown option ${arg}. Run "clewwiki-mcp skills --help".`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new SkillsCliError(`${arg} needs a value`);
    }
    index += 1;
    if (arg === '--space') command.space = value.trim().toUpperCase();
    else if (arg === '--dir') command.dir = value;
    else command.only = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  }

  if (command.space === '') {
    throw new SkillsCliError('--space is required: the key of the space whose skills to read');
  }
  if (!/^[A-Z0-9]{2,10}$/.test(command.space)) {
    throw new SkillsCliError(`"${command.space}" is not a space key: 2 to 10 letters or digits`);
  }
  return command;
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export function expandHome(dir: string, home: string): string {
  if (dir === '~') return home;
  if (dir.startsWith('~/') || dir.startsWith(`~${path.sep}`)) return path.join(home, dir.slice(2));
  return dir;
}

/**
 * The directory one skill is written into, or a refusal.
 *
 * The slug is checked against the pattern first, then the join is verified: the
 * resolved path must be exactly one component below the resolved target. Both
 * halves are needed — the pattern stops `../etc` before it becomes a path, and
 * the comparison stops anything the pattern would have let through.
 */
export function resolveSkillDirectory(baseDir: string, slug: string): string {
  if (slug.length === 0 || slug.length > MAX_SKILL_SLUG_LENGTH || !SKILL_SLUG_PATTERN.test(slug)) {
    throw new SkillsCliError(
      `refusing to write skill "${slug}": a slug is lowercase words joined by single hyphens, at most ${MAX_SKILL_SLUG_LENGTH} characters`,
    );
  }
  const base = path.resolve(baseDir);
  const target = path.resolve(base, slug);
  const relative = path.relative(base, target);
  if (relative !== slug || relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SkillsCliError(`refusing to write skill "${slug}": it would land outside ${base}`);
  }
  return target;
}

/** Refuses a path that exists as a symbolic link. Missing is fine. */
async function assertNotSymlink(target: string, what: string): Promise<void> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new SkillsCliError(`refusing to write ${what}: ${target} is a symbolic link`);
    }
  } catch (error) {
    if (error instanceof SkillsCliError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Manifest {
  source?: string;
  space?: string;
  slug?: string;
  sha256?: string;
  written_at?: string;
}

async function readManifest(directory: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(path.join(directory, MANIFEST_FILENAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Manifest) : null;
  } catch {
    return null;
  }
}

/** Writes a file, refusing to follow a symbolic link at the final component. */
async function writeFileNoFollow(target: string, contents: string): Promise<void> {
  const handle = await open(
    target,
    // eslint-disable-next-line no-bitwise
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* The commands                                                        */
/* ------------------------------------------------------------------ */

interface SkillListEntry {
  slug: string;
  name: string;
  description: string;
  version: string | null;
  tags: string[];
  updated_at: string;
}

export type InstallOutcome = 'written' | 'unchanged' | 'kept' | 'refused';

export interface InstalledSkill {
  slug: string;
  outcome: InstallOutcome;
  file: string;
  reason?: string;
}

export interface SkillsClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  allowInsecure?: boolean;
  fetch?: FetchLike;
}

export function createSkillsClient(options: SkillsClientOptions): ClewwikiRestClient {
  assertSecureBaseUrl(options.baseUrl, options.allowInsecure ?? false);
  return new ClewwikiRestClient({
    baseUrl: options.baseUrl,
    token: options.token,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
  });
}

export async function listSpaceSkills(
  client: ClewwikiRestClient,
  space: string,
): Promise<SkillListEntry[]> {
  const result = await client.request<{ skills?: SkillListEntry[] }>({
    method: 'GET',
    path: `/spaces/${encodeURIComponent(space)}/skills`,
  });
  return result.skills ?? [];
}

export interface InstallOptions {
  space: string;
  directory: string;
  only?: readonly string[];
  force?: boolean;
  /** Named in the manifest so a file can be traced back to its instance. */
  source: string;
}

/**
 * Fetches a space's skills and writes each one as `<dir>/<slug>/SKILL.md`.
 *
 * Returns one outcome per skill rather than throwing on the first refusal: a
 * person installing twelve skills wants the eleven that worked and a clear line
 * about the twelfth, not an aborted run.
 */
export async function installSkills(
  client: ClewwikiRestClient,
  options: InstallOptions,
): Promise<InstalledSkill[]> {
  const listed = await listSpaceSkills(client, options.space);
  const wanted = options.only
    ? listed.filter((skill) => options.only?.includes(skill.slug))
    : listed;

  if (options.only) {
    for (const slug of options.only) {
      if (!listed.some((skill) => skill.slug === slug)) {
        throw new SkillsCliError(`no skill "${slug}" in space ${options.space}`);
      }
    }
  }

  const results: InstalledSkill[] = [];
  for (const entry of wanted) {
    let directory: string;
    try {
      directory = resolveSkillDirectory(options.directory, entry.slug);
    } catch (error) {
      results.push({
        slug: entry.slug,
        outcome: 'refused',
        file: '',
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const file = path.join(directory, SKILL_FILENAME);

    const full = await client.request<{ skill_md?: string }>({
      method: 'GET',
      path: `/spaces/${encodeURIComponent(options.space)}/skills/${encodeURIComponent(entry.slug)}`,
    });
    const contents = full.skill_md;
    if (typeof contents !== 'string') {
      throw new ClewwikiToolError('INTERNAL', `The instance returned no SKILL.md for ${entry.slug}`, {
        slug: entry.slug,
      });
    }

    try {
      await assertNotSymlink(directory, `skill ${entry.slug}`);
      await assertNotSymlink(file, `skill ${entry.slug}`);

      let existing: string | null = null;
      try {
        existing = await readFile(file, 'utf8');
      } catch {
        existing = null;
      }

      if (existing !== null && !options.force) {
        const manifest = await readManifest(directory);
        const ours = manifest?.sha256 === sha256(existing);
        if (!ours) {
          results.push({
            slug: entry.slug,
            outcome: 'kept',
            file,
            reason: 'the file was not written by this command, or was edited afterwards',
          });
          continue;
        }
        if (existing === contents) {
          results.push({ slug: entry.slug, outcome: 'unchanged', file });
          continue;
        }
      }

      await mkdir(directory, { recursive: true });
      await writeFileNoFollow(file, contents);
      await writeFileNoFollow(
        path.join(directory, MANIFEST_FILENAME),
        `${JSON.stringify(
          {
            source: options.source,
            space: options.space,
            slug: entry.slug,
            sha256: sha256(contents),
            written_at: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      results.push({ slug: entry.slug, outcome: 'written', file });
    } catch (error) {
      results.push({
        slug: entry.slug,
        outcome: 'refused',
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function readTimeout(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.CLEWWIKI_TIMEOUT_MS;
  if (!raw || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SkillsCliError('CLEWWIKI_TIMEOUT_MS must be a positive number of milliseconds');
  }
  return parsed;
}

/**
 * Runs `clewwiki-mcp skills …` and answers with the process exit status.
 *
 * Everything the command says goes through `io`, so the tests drive it exactly
 * as a shell does and read back what a person would see.
 */
export async function runSkillsCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: SkillsCliIo = processIo,
): Promise<number> {
  let command: SkillsCommand;
  try {
    command = parseSkillsArgs(args);
  } catch (error) {
    io.err(`clewwiki-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (command.action === 'help') {
    io.out(SKILLS_USAGE);
    return 0;
  }

  const baseUrl = env.CLEWWIKI_URL?.trim();
  if (!baseUrl) {
    io.err(
      'clewwiki-mcp: CLEWWIKI_URL is not set. It is the base URL of your clewwiki instance, for example https://wiki.example.com\n',
    );
    return 1;
  }
  const token = env.CLEWWIKI_TOKEN?.trim();
  if (!token) {
    io.err("clewwiki-mcp: CLEWWIKI_TOKEN is not set. Issue an agent token from your instance's /tokens page.\n");
    return 1;
  }

  let client: ClewwikiRestClient;
  try {
    client = createSkillsClient({
      baseUrl,
      token,
      timeoutMs: readTimeout(env),
      allowInsecure: env.CLEWWIKI_ALLOW_INSECURE_URL === 'true',
    });
  } catch (error) {
    io.err(`clewwiki-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    if (command.action === 'list') {
      const skills = await listSpaceSkills(client, command.space);
      if (skills.length === 0) {
        io.out(`No skills in space ${command.space}.\n`);
        return 0;
      }
      io.out(`${skills.length} skill(s) in space ${command.space}:\n`);
      for (const skill of skills) {
        const version = skill.version ? ` (${skill.version})` : '';
        const tags = skill.tags.length > 0 ? `  [${skill.tags.join(', ')}]` : '';
        io.out(`  ${skill.slug}${version} — ${skill.name}${tags}\n    ${skill.description}\n`);
      }
      return 0;
    }

    const directory = path.resolve(expandHome(command.dir ?? DEFAULT_SKILLS_DIR, io.home()));
    const results = await installSkills(client, {
      space: command.space,
      directory,
      only: command.only,
      force: command.force,
      source: client.baseUrl,
    });

    if (results.length === 0) {
      io.out(`No skills in space ${command.space}; nothing written.\n`);
      return 0;
    }

    let refused = 0;
    for (const result of results) {
      if (result.outcome === 'written') io.out(`wrote     ${result.file}\n`);
      else if (result.outcome === 'unchanged') io.out(`unchanged ${result.file}\n`);
      else if (result.outcome === 'kept') {
        refused += 1;
        io.err(`kept      ${result.file} — ${result.reason}; pass --force to overwrite\n`);
      } else {
        refused += 1;
        io.err(`refused   ${result.slug} — ${result.reason}\n`);
      }
    }
    const written = results.filter((result) => result.outcome === 'written').length;
    io.out(`${written} written, ${results.length - written - refused} unchanged, ${refused} left alone, into ${directory}\n`);
    return refused > 0 ? 2 : 0;
  } catch (error) {
    io.err(`clewwiki-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
