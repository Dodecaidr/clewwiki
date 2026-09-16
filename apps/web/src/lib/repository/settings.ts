import { z } from 'zod';

import type { WorkspaceRepositorySettings, WorkspaceSettings } from '@clewwiki/db';

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
 * `file://` is allowed deliberately: it is how the integration tests build a
 * repository, and how a self-hosted instance points at a checkout on the same
 * machine. Everything else — `ext::`, `--upload-pack=…` and the rest of git's
 * transport surface — is refused, because a URL is operator input that reaches
 * a subprocess.
 */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:', 'file:']);

/** `git@host:org/repo.git`, which is not a URL but is what people paste. */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._\-/~]+$/;

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
    .refine((value) => {
      if (SCP_LIKE.test(value)) return true;
      try {
        return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
      } catch {
        return false;
      }
    }, 'Unsupported repository URL'),
  default_ref: z.string().trim().min(1).max(200).refine(isSafeRef, 'Unsupported ref'),
  // The *name* of an environment variable, never its value.
  auth_token_env: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'Must be an environment variable name')
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
