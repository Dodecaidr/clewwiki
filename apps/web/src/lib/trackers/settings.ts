import type { TrackerSettings, Workspace } from '@clewwiki/db';

import { TRACKER_TOKEN_ENV_PATTERN } from '../env';

/**
 * The issue trackers an organization is linked to: what they are called, where
 * they live, which `KEY-123` prefixes are theirs, and which environment variable
 * holds the token a server-side read uses. Kept in the organization's settings
 * JSON — policy read with the row, never queried on its own.
 */

export type { TrackerSettings };

export const MAX_TRACKERS = 10;

export class TrackerSettingsError extends Error {
  constructor(readonly field: 'name' | 'base_url' | 'projects' | 'url_template' | 'token_env' | 'kind' | 'tooMany') {
    super(field);
    this.name = 'TrackerSettingsError';
  }
}

export function readTrackers(workspace: Pick<Workspace, 'settings'>): TrackerSettings[] {
  const list = workspace.settings.trackers;
  return Array.isArray(list) ? list : [];
}

/** A project prefix as trackers write them: a letter, then letters, digits or underscores. */
const PROJECT = /^[A-Z][A-Z0-9_]{0,19}$/;

export interface TrackerInput {
  kind: string;
  name: string;
  baseUrl: string;
  projects: string;
  urlTemplate?: string;
  tokenEnv?: string;
}

/** Validates what an administrator typed into a tracker the settings can keep. */
export function normalizeTracker(input: TrackerInput, id: string): TrackerSettings {
  if (input.kind !== 'youtrack' && input.kind !== 'jira' && input.kind !== 'other') {
    throw new TrackerSettingsError('kind');
  }
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name === '' || name.length > 60) throw new TrackerSettingsError('name');

  let url: URL;
  try {
    url = new URL(input.baseUrl.trim());
  } catch {
    throw new TrackerSettingsError('base_url');
  }
  // Credentials typed into the address would be stored and shown back; the
  // token belongs in the environment.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TrackerSettingsError('base_url');
  }
  const baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '');

  const projects = [
    ...new Set(
      input.projects
        .split(/[\s,;]+/)
        .map((project) => project.trim().toUpperCase())
        .filter((project) => project !== ''),
    ),
  ];
  if (projects.length === 0 || projects.length > 50 || !projects.every((project) => PROJECT.test(project))) {
    throw new TrackerSettingsError('projects');
  }

  let urlTemplate: string | undefined;
  if (input.kind === 'other') {
    urlTemplate = (input.urlTemplate ?? '').trim();
    let templateUrl: URL;
    try {
      templateUrl = new URL(urlTemplate.replace(/\{(key|project|number)\}/g, 'X'));
    } catch {
      throw new TrackerSettingsError('url_template');
    }
    if (templateUrl.protocol !== 'https:' || !/\{(key|number)\}/.test(urlTemplate)) {
      throw new TrackerSettingsError('url_template');
    }
  }

  const tokenEnv = (input.tokenEnv ?? '').trim();
  if (tokenEnv !== '' && (!TRACKER_TOKEN_ENV_PATTERN.test(tokenEnv) || input.kind === 'other')) {
    throw new TrackerSettingsError('token_env');
  }

  return {
    id,
    kind: input.kind,
    name,
    base_url: baseUrl,
    projects,
    ...(urlTemplate ? { url_template: urlTemplate } : {}),
    ...(tokenEnv ? { token_env: tokenEnv } : {}),
  };
}

/** `KEY-123` for every project of every tracker, as one pattern; null with none. */
export function issueKeyPattern(trackers: TrackerSettings[]): RegExp | null {
  const projects = trackers.flatMap((tracker) => tracker.projects).filter((project) => PROJECT.test(project));
  if (projects.length === 0) return null;
  // Longest first, so `MACOS` is not read as `MAC` followed by text.
  const alternatives = [...new Set(projects)].sort((a, b) => b.length - a.length).join('|');
  return new RegExp(`(?<![A-Za-z0-9_-])(${alternatives})-(\\d{1,9})(?![A-Za-z0-9_])`, 'g');
}

export function trackerForKey(trackers: TrackerSettings[], key: string): TrackerSettings | null {
  const project = key.split('-')[0]?.toUpperCase() ?? '';
  return trackers.find((tracker) => tracker.projects.includes(project)) ?? null;
}

/** Where a person reads the issue in the tracker itself. */
export function issueUrl(tracker: TrackerSettings, key: string): string {
  const [project = '', number = ''] = key.split('-');
  const encoded = encodeURIComponent(key);
  if (tracker.kind === 'youtrack') return `${tracker.base_url}/issue/${encoded}`;
  if (tracker.kind === 'jira') return `${tracker.base_url}/browse/${encoded}`;
  return (tracker.url_template ?? '')
    .replace(/\{key\}/g, encoded)
    .replace(/\{project\}/g, encodeURIComponent(project))
    .replace(/\{number\}/g, encodeURIComponent(number));
}

/** Every distinct issue key in a text, in order of first appearance. */
export function findIssueKeys(text: string, trackers: TrackerSettings[]): string[] {
  const pattern = issueKeyPattern(trackers);
  if (!pattern) return [];
  const keys = new Set<string>();
  for (const match of text.matchAll(pattern)) keys.add(`${match[1]}-${match[2]}`);
  return [...keys];
}

/** What the page renderer needs to link keys: the pattern and a URL per key. */
export interface IssueLinker {
  pattern: RegExp;
  href: (key: string) => string | null;
}

export function issueLinker(trackers: TrackerSettings[]): IssueLinker | null {
  const pattern = issueKeyPattern(trackers);
  if (!pattern) return null;
  return {
    pattern,
    href: (key) => {
      const tracker = trackerForKey(trackers, key);
      return tracker ? issueUrl(tracker, key) : null;
    },
  };
}
