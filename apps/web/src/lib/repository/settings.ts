import { z } from 'zod';

import type { WorkspaceRepositorySettings, WorkspaceSettings } from '@clewwiki/db';

import { areFileRepositoriesAllowed, REPOSITORY_TOKEN_ENV_PATTERN } from '../env';
import { PageServiceError } from '../pages/errors';

/**
 * The workspace's link to a source repository.
 *
 * It lives in the workspace's `settings` JSON rather than in a table of its
 * own for the reason `docs/architecture.md` gives: it is policy, it is read
 * with the workspace row, and nothing queries it on its own. If a second
 * repository per workspace ever becomes a requirement it graduates to a table
 * then, with a migration, rather than pre-emptively now.
 */

/**
 * Schemes the server will clone from.
 *
 * A repository URL is administrator input that reaches a subprocess, so the
 * list is short. `https:` is the supported transport and the only one a
 * credential is ever sent over. `http:` and `ssh:` are accepted without one
 * (the container image ships no SSH client, so `ssh:` works only outside it).
 * `git:` is refused — unauthenticated and unencrypted — and so is everything
 * else in git's transport surface, `ext::` included.
 *
 * `file:` reads any repository the application's user can see on the host, so
 * it is accepted only when the operator set `ALLOW_FILE_REPOSITORIES=true`.
 * The integration tests do; a production instance normally does not need to.
 */
const NETWORK_PROTOCOLS = new Set(['https:', 'http:', 'ssh:']);

/** `git@host:org/repo.git`, which is not a URL but is what people paste. */
const SCP_LIKE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9._\-/~]+$/;

/** git's `<transport>::<address>` syntax, which is how `ext::` runs a command. */
const TRANSPORT_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*::/;

/**
 * Why a repository URL is refused, or null when it is acceptable.
 *
 * The checks read the operator flag at call time rather than at import, so a
 * setting stored while `file://` was allowed stops resolving once it is not.
 */
export function repositoryUrlProblem(value: string): string | null {
  if (value.startsWith('-')) return 'A repository URL cannot start with "-"';
  if (TRANSPORT_PREFIX.test(value)) return 'Transport prefixes such as ext:: are not supported';
  if (SCP_LIKE.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Unsupported repository URL';
  }

  // git reads a host that starts with a dash as an option to ssh.
  if (url.hostname.startsWith('-')) return 'Unsupported repository URL';

  if (url.protocol === 'file:') {
    if (!areFileRepositoriesAllowed()) {
      return 'file:// repositories are disabled on this instance (ALLOW_FILE_REPOSITORIES)';
    }
  } else if (!NETWORK_PROTOCOLS.has(url.protocol)) {
    return 'Use an https:// repository URL';
  }

  // A credential typed into the URL would be stored in the workspace settings,
  // copied into the audit log and shown back in the form. The token belongs in
  // the environment, named by the access token variable.
  if (url.password !== '') return 'Remove the credentials from the URL; use the access token variable';
  if (url.username !== '' && url.protocol !== 'ssh:') {
    return 'Remove the credentials from the URL; use the access token variable';
  }
  return null;
}

/**
 * A ref this server is willing to hand to git.
 *
 * Deliberately narrower than `git check-ref-format`: no leading dash (which
 * git would read as an option), no whitespace, no `..`, and a hex commit id is
 * covered by the same pattern.
 */
export const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._\-/]{0,199}$/;

/** A repository-relative path. No absolute paths, no traversal, no NUL. */
export const REPO_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9 ._\-/+@]{0,511}$/;

export function isSafeRef(value: string): boolean {
  return REF_PATTERN.test(value) && !value.includes('..');
}

export function isSafeRepoPath(value: string): boolean {
  return REPO_PATH_PATTERN.test(value) && !value.includes('..') && !value.includes('//');
}

export const repositorySettingsSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .superRefine((value, context) => {
      const problem = repositoryUrlProblem(value);
      if (problem !== null) context.addIssue({ code: 'custom', message: problem });
    }),
  default_ref: z.string().trim().min(1).max(200).refine(isSafeRef, 'Unsupported ref'),
  // The *name* of an environment variable, never its value — and only a name
  // in the namespace set aside for repository credentials.
  auth_token_env: z
    .string()
    .trim()
    .regex(
      REPOSITORY_TOKEN_ENV_PATTERN,
      'Must be CLEWWIKI_GIT_TOKEN or CLEWWIKI_GIT_TOKEN_<NAME> (A–Z, 0–9)',
    )
    .optional(),
});

export type RepositorySettingsInput = z.infer<typeof repositorySettingsSchema>;

export function readRepositorySettings(
  settings: WorkspaceSettings | null | undefined,
): WorkspaceRepositorySettings | null {
  const candidate = settings?.repository;
  if (!candidate) return null;
  const parsed = repositorySettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The same read, but for a caller that cannot proceed without a repository.
 * A workspace with none configured is a `validation` failure rather than a
 * server error: the fix is an administrator filling in the setting.
 */
export function requireRepositorySettings(
  settings: WorkspaceSettings | null | undefined,
): WorkspaceRepositorySettings {
  const repository = readRepositorySettings(settings);
  if (!repository) {
    throw new PageServiceError(
      'validation',
      'This workspace has no source repository configured',
    );
  }
  return repository;
}
