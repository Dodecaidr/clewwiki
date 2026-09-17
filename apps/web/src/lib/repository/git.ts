import 'server-only';

import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { RepositorySettings } from '@clewwiki/db';

import { areFileRepositoriesAllowed, getReposDir, getRepositoryToken } from '../env';
import { PageServiceError } from '../pages/errors';
import { isSafeRef, isSafeRepoPath } from './settings';

const run = promisify(execFile);

/**
 * Read-only access to a space's source repository.
 *
 * Three rules shape everything here.
 *
 * 1. **No working tree.** The server keeps a bare clone and reads blobs with
 *    `git show <ref>:<path>`. Nothing from the repository is ever written out
 *    as a file the operating system could be asked to run, and no build,
 *    install or hook script is executed at any point. Repository content is
 *    data — the same rule the application applies to page bodies.
 * 2. **No shell.** Every git invocation is an argument array handed to
 *    `execFile`. Refs and paths are validated against a narrow pattern before
 *    they get there, so neither a crafted branch name nor a crafted file path
 *    can turn into an option or a second command.
 * 3. **Credentials come from the process environment.** The space setting
 *    names an environment variable; the token is passed to git through
 *    `GIT_CONFIG_*` environment entries rather than in the URL or in `argv`,
 *    where `ps` would show it to every account on the host.
 */

/** How long a single git invocation may take before it is abandoned. */
const GIT_TIMEOUT_MS = 60_000;

/** Ceiling on the output of one git invocation: 64 MB. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Largest single file the indexer will read. */
export const MAX_SOURCE_BYTES = 1_000_000;

export interface GitEnvironment {
  [key: string]: string;
}

/**
 * The environment every git subprocess runs in.
 *
 * System and per-user configuration are switched off so that whatever the host
 * account happens to have in `~/.gitconfig` — a pager, an alias, a credential
 * helper — cannot change what these commands do. `core.hooksPath` is pointed
 * at nothing as a second line of defence; the commands used here do not run
 * hooks in the first place.
 */
/**
 * The configuration key that carries the credential, scoped to the origin of
 * an `https://` repository URL — or null when no credential may be sent.
 *
 * Two rules. A credential only ever travels over TLS, so an `http://`, `ssh:`
 * or `file://` URL gets none. And the header is bound to the repository's own
 * origin (`http.<origin>/.extraHeader`) rather than set for every request git
 * makes, so a redirect to another host does not carry it along.
 */
export function credentialConfigKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
  return `http.${parsed.origin}/.extraHeader`;
}

export function gitEnvironment(settings: RepositorySettings): GitEnvironment {
  const entries: Array<[string, string]> = [['core.hooksPath', '/dev/null']];

  const token = getRepositoryToken(settings.auth_token_env);
  const credentialKey = credentialConfigKey(settings.url);
  if (token !== null && credentialKey !== null) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    entries.push([credentialKey, `Authorization: Basic ${basic}`]);
  }

  const env: GitEnvironment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: String(entries.length),
    // The transports git may use at all, for the clone itself and for anything
    // it would follow from there. `ext::` and `git://` are never on the list.
    GIT_ALLOW_PROTOCOL: areFileRepositoriesAllowed() ? 'https:http:ssh:file' : 'https:http:ssh',
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * git's own message, with anything that looks like a credential removed.
 *
 * A failed fetch quotes the remote URL, and an operator who typed a token into
 * the URL field would otherwise find it in an API response.
 */
function sanitizeGitError(error: unknown): string {
  const raw =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : error instanceof Error
        ? error.message
        : String(error);
  return raw
    .replace(/\/\/[^@\s/]+@/g, '//***@')
    .replace(/Authorization: [^\s]+/gi, 'Authorization: ***')
    .split('\n')
    .slice(0, 4)
    .join(' ')
    .trim()
    .slice(0, 400);
}

/**
 * A repository failure as the API reports it: a fixed message and nothing
 * else.
 *
 * git's own stderr is written by whoever runs the remote — an arbitrary server
 * the URL points at — and an API response is read by agents. So that text goes
 * to the server log, where an operator can read it, and never into `details`,
 * where it would be one more string a remote party gets to put in front of a
 * model.
 */
function repositoryError(message: string, error: unknown): PageServiceError {
  console.error(`[repository] ${message}: ${sanitizeGitError(error)}`);
  return new PageServiceError('repository_unavailable', message);
}

async function git(
  args: readonly string[],
  settings: RepositorySettings,
  cwd?: string,
  maxBuffer: number = GIT_MAX_BUFFER,
): Promise<string> {
  const { stdout } = await run('git', [...args], {
    cwd,
    // A deliberately minimal environment rather than the process's own: git
    // inherits only what it needs, so nothing else this process holds — a
    // database URL, an auth secret — is visible to a subprocess.
    env: gitEnvironment(settings) as NodeJS.ProcessEnv,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    encoding: 'utf8',
    windowsHide: true,
  });
  return stdout;
}

/* ------------------------------------------------------------------ */
/* Per-space serialisation                                             */
/* ------------------------------------------------------------------ */

const locks = new Map<string, Promise<unknown>>();

/**
 * Serialises work on one space's clone.
 *
 * Two concurrent `check` calls would otherwise fetch into the same directory
 * at the same time, and git's answer to that is a lock file error rather than
 * a merge. The queue is per space — the unit that owns a repository — so one
 * project's slow fetch does not hold up another's.
 */
export async function withRepositoryLock<T>(
  spaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(spaceId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Keep the chain alive even when a link rejects, or the next caller inherits
  // an unhandled rejection that has nothing to do with it.
  locks.set(
    spaceId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/* ------------------------------------------------------------------ */
/* The mirror                                                          */
/* ------------------------------------------------------------------ */

/**
 * One mirror per space, named by the space id. Mirrors kept per workspace
 * before `0004_spaces` are named by the workspace id and are simply no longer
 * read; the first check in a space clones afresh.
 */
export function repositoryDirectory(spaceId: string): string {
  return path.join(getReposDir(), `${spaceId}.git`);
}

async function currentRemote(
  dir: string,
  settings: RepositorySettings,
): Promise<string | null> {
  try {
    return (await git(['config', '--get', 'remote.origin.url'], settings, dir)).trim();
  } catch {
    return null;
  }
}

/**
 * Makes sure the space's mirror exists and is up to date.
 *
 * A clone whose origin no longer matches the configured URL is discarded
 * rather than re-pointed: the two repositories share no history, and a stale
 * object database would answer questions about the wrong code.
 */
export async function syncRepository(
  spaceId: string,
  settings: RepositorySettings,
): Promise<string> {
  const dir = repositoryDirectory(spaceId);

  try {
    await mkdir(getReposDir(), { recursive: true });
  } catch (error) {
    throw repositoryError('The repository directory could not be created', error);
  }

  const remote = await currentRemote(dir, settings);

  if (remote !== null && remote !== settings.url) {
    await rm(dir, { recursive: true, force: true });
  }

  if (remote === null || remote !== settings.url) {
    try {
      // `--mirror` rather than `--bare`: a plain bare clone is created with no
      // fetch refspec at all, so the branches in it would never move again. A
      // mirror is also exactly what this is — a read-only copy of every ref,
      // with no working tree and nothing to check out.
      await git(['clone', '--mirror', '--quiet', '--', settings.url, dir], settings);
    } catch (error) {
      throw repositoryError('The repository could not be cloned', error);
    }
    return dir;
  }

  try {
    await git(['fetch', '--prune', '--quiet', 'origin'], settings, dir);
  } catch (error) {
    throw repositoryError('The repository could not be fetched', error);
  }
  return dir;
}

/** Resolves a ref to the commit it names, inside the space's mirror. */
export async function resolveCommit(
  dir: string,
  ref: string,
  settings: RepositorySettings,
): Promise<string> {
  if (!isSafeRef(ref)) {
    throw new PageServiceError('validation', `Unsupported ref: ${ref}`);
  }
  try {
    const stdout = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], settings, dir);
    const commit = stdout.trim();
    if (commit === '') throw new Error('empty');
    return commit;
  } catch (error) {
    console.error(`[repository] ref ${ref} could not be resolved: ${sanitizeGitError(error)}`);
    throw new PageServiceError('not_found', `Ref not found in the repository: ${ref}`);
  }
}

export interface TreeEntry {
  path: string;
  /** Blob size in bytes, as git records it. */
  size: number;
}

/**
 * Every blob in the tree at `commit`, with its size, NUL-separated so spaces
 * are safe. Sizes come from the object database, so an oversized file can be
 * skipped before a single byte of it is read.
 */
export async function listTree(
  dir: string,
  commit: string,
  settings: RepositorySettings,
): Promise<TreeEntry[]> {
  try {
    const stdout = await git(['ls-tree', '-r', '-z', '-l', commit], settings, dir);
    const entries: TreeEntry[] = [];
    for (const record of stdout.split('\0')) {
      // `<mode> SP <type> SP <object> SP+ <size> TAB <path>`
      const tab = record.indexOf('\t');
      if (tab <= 0) continue;
      const fields = record.slice(0, tab).trim().split(/\s+/);
      if (fields[1] !== 'blob') continue;
      const size = Number.parseInt(fields[3] ?? '', 10);
      entries.push({ path: record.slice(tab + 1), size: Number.isFinite(size) ? size : Number.MAX_SAFE_INTEGER });
    }
    return entries;
  } catch (error) {
    throw repositoryError('The repository tree could not be listed', error);
  }
}

/**
 * One file's contents at `commit`, or null when it is not in that tree or is
 * larger than `MAX_SOURCE_BYTES`.
 *
 * The output buffer is capped just above that limit, so an oversized blob is
 * abandoned while it is being read rather than buffered whole and measured
 * afterwards. The bytes are returned to the caller and handed to a parser.
 * They are never written to disk, never interpolated into a command, and never
 * evaluated.
 */
export async function readBlob(
  dir: string,
  commit: string,
  filePath: string,
  settings: RepositorySettings,
): Promise<string | null> {
  if (!isSafeRepoPath(filePath)) {
    throw new PageServiceError('validation', `Unsupported repository path: ${filePath}`);
  }
  try {
    const source = await git(['show', `${commit}:${filePath}`], settings, dir, MAX_SOURCE_BYTES + 1);
    return source.length > MAX_SOURCE_BYTES ? null : source;
  } catch {
    return null;
  }
}

export interface ConnectionProbe {
  ok: boolean;
  /** The commit `default_ref` resolves to, when the probe succeeded. */
  commit?: string;
  /** How many refs the remote advertises — a cheap sign of life. */
  refs?: number;
  error?: string;
}

/**
 * The "Test connection" button.
 *
 * `ls-remote` needs neither a clone nor disk space, so an administrator can
 * find out whether the URL, the ref and the token work before the first check
 * runs and before anything is written under `REPOS_DIR`.
 */
export async function probeRepository(
  settings: RepositorySettings,
): Promise<ConnectionProbe> {
  if (!isSafeRef(settings.default_ref)) {
    return { ok: false, error: `Unsupported ref: ${settings.default_ref}` };
  }
  try {
    const stdout = await git(['ls-remote', '--quiet', '--', settings.url], settings);
    const lines = stdout.split('\n').filter((line) => line.trim() !== '');
    const wanted = lines.find((line) => {
      const name = line.split('\t')[1] ?? '';
      return (
        name === `refs/heads/${settings.default_ref}` ||
        name === `refs/tags/${settings.default_ref}` ||
        line.startsWith(settings.default_ref)
      );
    });
    return {
      ok: true,
      refs: lines.length,
      ...(wanted ? { commit: wanted.split('\t')[0]?.slice(0, 12) } : {}),
    };
  } catch (error) {
    return { ok: false, error: sanitizeGitError(error) };
  }
}
