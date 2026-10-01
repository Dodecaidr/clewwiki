import 'server-only';

import type { Workspace } from '@clewwiki/db';

import { getTrackerToken } from '../env';
import { TrackerError, assignedQuery, fetchIssue, searchIssues } from './client';
import type { FetchLike, TrackerIssue } from './client';
import { readTrackers, trackerForKey } from './settings';
import type { TrackerSettings } from './settings';

/**
 * Issues for pages, people and agents, read through the organization's
 * trackers. Reads are cached for a few minutes per organization: a page that
 * mentions twenty issues is opened far more often than those issues change,
 * and a tracker should not be asked twenty times per page view.
 */

const TTL_MS = 5 * 60 * 1000;
const MAX_CACHED = 5_000;

interface Cached {
  issue: TrackerIssue;
  at: number;
}

declare global {
  var __clewwikiIssueCache: Map<string, Cached> | undefined;
}

function cache(): Map<string, Cached> {
  globalThis.__clewwikiIssueCache ??= new Map();
  return globalThis.__clewwikiIssueCache;
}

/** Tests only. */
export function clearIssueCache(): void {
  globalThis.__clewwikiIssueCache = undefined;
}

function remember(workspaceId: string, issue: TrackerIssue): void {
  const store = cache();
  if (store.size >= MAX_CACHED) store.clear();
  store.set(`${workspaceId}:${issue.key}`, { issue, at: Date.now() });
}

function recall(workspaceId: string, key: string): TrackerIssue | null {
  const hit = cache().get(`${workspaceId}:${key}`);
  return hit && Date.now() - hit.at < TTL_MS ? hit.issue : null;
}

export function readableTrackers(workspace: Pick<Workspace, 'settings'>): TrackerSettings[] {
  return readTrackers(workspace).filter(
    (tracker) => tracker.kind !== 'other' && getTrackerToken(tracker.token_env) !== null,
  );
}

export async function getIssue(
  workspace: Pick<Workspace, 'id' | 'settings'>,
  rawKey: string,
  fetchImpl?: FetchLike,
): Promise<TrackerIssue> {
  const key = rawKey.trim().toUpperCase();
  const tracker = trackerForKey(readTrackers(workspace), key);
  if (!tracker) throw new TrackerError('notFound');
  // A full read always goes to the tracker: the cache holds summaries for
  // panels, and somebody asking for one issue wants it as it is now.
  const issue = await fetchIssue(tracker, key, fetchImpl);
  remember(workspace.id, { ...issue, description: undefined, comments: undefined, fields: undefined });
  return issue;
}

/**
 * Status, assignee and summary of the given keys, from the cache or in one
 * search per tracker. Keys of a tracker the server cannot read are left out.
 */
export async function getIssueSummaries(
  workspace: Pick<Workspace, 'id' | 'settings'>,
  keys: string[],
  fetchImpl?: FetchLike,
): Promise<Map<string, TrackerIssue>> {
  const found = new Map<string, TrackerIssue>();
  const missing = new Map<TrackerSettings, string[]>();
  const trackers = readableTrackers(workspace);
  for (const key of keys.slice(0, 50)) {
    const cached = recall(workspace.id, key);
    if (cached) {
      found.set(key, cached);
      continue;
    }
    const tracker = trackerForKey(trackers, key);
    if (!tracker) continue;
    missing.set(tracker, [...(missing.get(tracker) ?? []), key]);
  }
  await Promise.all(
    [...missing].map(async ([tracker, wanted]) => {
      const query =
        tracker.kind === 'youtrack' ? `issue ID: ${wanted.join(', ')}` : `key in (${wanted.join(', ')})`;
      try {
        for (const issue of await searchIssues(tracker, query, wanted.length, fetchImpl)) {
          remember(workspace.id, issue);
          if (wanted.includes(issue.key)) found.set(issue.key, issue);
        }
      } catch (error) {
        // A tracker that is down leaves its keys as plain links; the page still opens.
        console.warn('[trackers] reading issue summaries failed', tracker.name, error instanceof Error ? error.message : error);
      }
    }),
  );
  return found;
}

export async function search(
  workspace: Pick<Workspace, 'settings'>,
  query: string,
  trackerId: string | null,
  limit = 50,
  fetchImpl?: FetchLike,
): Promise<TrackerIssue[]> {
  const trackers = readableTrackers(workspace);
  const tracker = trackerId ? trackers.find((entry) => entry.id === trackerId) : trackers[0];
  if (!tracker) throw new TrackerError(trackers.length === 0 ? 'noToken' : 'notFound');
  return searchIssues(tracker, query, limit, fetchImpl);
}

/** Unresolved issues assigned to the person with this address, in every readable tracker. */
export async function assignedTo(
  workspace: Pick<Workspace, 'settings'>,
  email: string,
  fetchImpl?: FetchLike,
): Promise<TrackerIssue[]> {
  const trackers = readableTrackers(workspace);
  if (trackers.length === 0) throw new TrackerError('noToken');
  const lists = await Promise.all(
    trackers.map(async (tracker) => {
      const query = await assignedQuery(tracker, email, fetchImpl);
      return query ? searchIssues(tracker, query, 50, fetchImpl) : [];
    }),
  );
  return lists.flat();
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

export interface IssueMarkdownLabels {
  status: string;
  assignee: string;
  reporter: string;
  created: string;
  updated: string;
  link: string;
  description: string;
  comments: string;
  summary: string;
  key: string;
  none: string;
}

const cell = (value: string | null | undefined): string =>
  (value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

/** One issue as a page body: a facts table, the description, the comments as quotes. */
export function issueToMarkdown(issue: TrackerIssue, labels: IssueMarkdownLabels): string {
  const rows: Array<[string, string]> = [
    [labels.status, issue.status ?? labels.none],
    [labels.assignee, issue.assignee ?? labels.none],
    [labels.reporter, issue.reporter ?? labels.none],
    [labels.created, issue.created?.slice(0, 10) ?? ''],
    [labels.updated, issue.updated?.slice(0, 10) ?? ''],
    [labels.link, `[${issue.key}](${issue.url})`],
  ];
  const parts = [
    `| | |\n| --- | --- |\n${rows.map(([name, value]) => `| ${cell(name)} | ${name === labels.link ? value : cell(value)} |`).join('\n')}`,
  ];
  if (issue.description && issue.description.trim() !== '') {
    parts.push(`## ${labels.description}`, issue.description.trim());
  }
  if (issue.comments && issue.comments.length > 0) {
    parts.push(`## ${labels.comments}`);
    for (const comment of issue.comments) {
      const head = `**${comment.author || '—'}**${comment.created ? ` · ${comment.created.slice(0, 10)}` : ''}`;
      const body = comment.text.trim().split(/\r?\n/).map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
      parts.push(`> ${head}\n>\n${body}`);
    }
  }
  return parts.join('\n\n');
}

/** Many issues as one table: key (linked), summary, status, assignee. */
export function issuesToTable(issues: TrackerIssue[], labels: IssueMarkdownLabels): string {
  const header = `| ${labels.key} | ${labels.summary} | ${labels.status} | ${labels.assignee} |\n| --- | --- | --- | --- |`;
  const rows = issues.map(
    (issue) =>
      `| [${issue.key}](${issue.url}) | ${cell(issue.summary)} | ${cell(issue.status ?? labels.none)} | ${cell(issue.assignee ?? labels.none)} |`,
  );
  return [header, ...rows].join('\n');
}
