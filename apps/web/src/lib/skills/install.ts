import { MCP_PACKAGE, TOKEN_ENV_VAR, normalizeBaseUrl } from '../connect/snippets';

/**
 * The command a person runs to put a space's skills on their machine.
 *
 * Built here, once, so that the `/connect` page, a skill's own page and the
 * `install` hints in the REST response all print the same string. Like every
 * other snippet in this application it refers to the token by the name of the
 * environment variable it lives in and never by value — there is no argument
 * through which one could be interpolated.
 */

/** The binary name the MCP package installs. `npx` runs it by package name. */
export const SKILLS_CLI_NAME = 'clewwiki-mcp';

/** Where agent hosts look for locally installed skills, by convention. */
export const DEFAULT_SKILLS_DIR = '~/.claude/skills';

export interface SkillsInstallOptions {
  baseUrl: string;
  spaceKey: string;
  /** Install just this one skill instead of the whole space. */
  slug?: string;
  /** A directory other than the default. */
  dir?: string;
}

function tail(options: SkillsInstallOptions): string {
  const parts = ['skills', 'install', '--space', options.spaceKey];
  if (options.slug) parts.push('--only', options.slug);
  if (options.dir) parts.push('--dir', options.dir);
  return parts.join(' ');
}

/** The full one-line command, environment variables included. */
export function buildSkillsInstallCommand(options: SkillsInstallOptions): string {
  const url = normalizeBaseUrl(options.baseUrl);
  return `CLEWWIKI_URL=${url} ${TOKEN_ENV_VAR}=$${TOKEN_ENV_VAR} npx -y ${MCP_PACKAGE} ${tail(options)}`;
}

/** The same command as the installed binary would be typed. */
export function skillsInstallInvocation(options: Omit<SkillsInstallOptions, 'baseUrl'>): string {
  return `${SKILLS_CLI_NAME} ${tail({ ...options, baseUrl: '' })}`;
}

/** Listing without writing anything, for checking what a space offers. */
export function buildSkillsListCommand(options: Pick<SkillsInstallOptions, 'baseUrl' | 'spaceKey'>): string {
  const url = normalizeBaseUrl(options.baseUrl);
  return `CLEWWIKI_URL=${url} ${TOKEN_ENV_VAR}=$${TOKEN_ENV_VAR} npx -y ${MCP_PACKAGE} skills list --space ${options.spaceKey}`;
}

/** Where `skills install` writes one skill, for the `install` hints. */
export function skillInstallPath(slug: string, dir: string = DEFAULT_SKILLS_DIR): string {
  return `${dir.replace(/\/+$/, '')}/${slug}/SKILL.md`;
}
