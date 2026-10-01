import 'server-only';

import { toPrivateHosts } from '@clewwiki/import/address';
import { createGuardedFetch } from '@clewwiki/import/transport';

import { getTrackerPrivateHosts, getTrackerToken } from '../env';
import { issueUrl } from './settings';
import type { TrackerSettings } from './settings';

/**
 * Reading issues from YouTrack and Jira, server-side, with the token the
 * operator put in the environment.
 *
 * Requests go through the import's guarded transport: `https` only, public
 * addresses only unless the operator listed the host in
 * `TRACKER_PRIVATE_HOSTS`, no redirects followed, a capped body. The address
 * is an administrator's setting, but an administrator of one organization is
 * not trusted with the network of the instance.
 *
 * What comes back is the tracker's text, written by whoever filed the issue —
 * data, shown and handed to agents as data, never followed as instructions.
 */

export interface TrackerIssue {
  key: string;
  summary: string;
  status: string | null;
  assignee: string | null;
  resolved: boolean;
  url: string;
  tracker: string;
  created: string | null;
  updated: string | null;
  /** Present when one issue is read in full; absent in a search result. */
  description?: string;
  reporter?: string | null;
  comments?: Array<{ author: string; created: string | null; text: string }>;
  fields?: Record<string, string>;
}

export class TrackerError extends Error {
  constructor(
    readonly code: 'noToken' | 'notFound' | 'denied' | 'unavailable' | 'unsupported',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'TrackerError';
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function defaultFetch(): FetchLike {
  return createGuardedFetch({
    privateHosts: toPrivateHosts(getTrackerPrivateHosts()),
    maxResponseBytes: 8 * 1024 * 1024,
    timeoutMs: 20_000,
  }) as FetchLike;
}

function authorization(tracker: TrackerSettings): string {
  const token = getTrackerToken(tracker.token_env);
  if (!token) throw new TrackerError('noToken');
  // Jira Cloud takes `email:api-token` as Basic; everything else is a bearer token.
  if (tracker.kind === 'jira' && token.includes(':')) return `Basic ${Buffer.from(token).toString('base64')}`;
  return `Bearer ${token}`;
}

async function getJson<T>(tracker: TrackerSettings, path: string, fetchImpl: FetchLike): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${tracker.base_url}${path}`, {
      headers: { authorization: authorization(tracker), accept: 'application/json' },
    });
  } catch (error) {
    if (error instanceof TrackerError) throw error;
    throw new TrackerError('unavailable', error instanceof Error ? error.message : undefined);
  }
  if (response.status === 404) throw new TrackerError('notFound');
  if (response.status === 401 || response.status === 403) throw new TrackerError('denied');
  if (!response.ok) throw new TrackerError('unavailable', `The tracker answered ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new TrackerError('unavailable', 'The tracker did not answer with JSON');
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/* ------------------------------------------------------------------ */
/* YouTrack                                                            */
/* ------------------------------------------------------------------ */

interface YouTrackValue {
  name?: string;
  fullName?: string;
  login?: string;
  presentation?: string;
  text?: string;
}

interface YouTrackIssue {
  idReadable?: string;
  /** False for an issue written in YouTrack's older wiki markup: its texts then arrive as HTML. */
  usesMarkdown?: boolean;
  summary?: string;
  description?: string | null;
  resolved?: number | null;
  created?: number;
  updated?: number;
  reporter?: { fullName?: string; login?: string } | null;
  customFields?: Array<{ name?: string; value?: YouTrackValue | YouTrackValue[] | string | number | null }>;
  comments?: Array<{
    text?: string;
    usesMarkdown?: boolean;
    created?: number;
    author?: { fullName?: string; login?: string } | null;
  }>;
}

const YT_LIST_FIELDS = 'idReadable,summary,resolved,created,updated,customFields(name,value(name,fullName,login,presentation))';
const YT_FULL_FIELDS = `${YT_LIST_FIELDS},usesMarkdown,description,reporter(fullName,login),comments(text,usesMarkdown,created,author(fullName,login))`;

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/**
 * Text YouTrack rendered to HTML — an issue in its older wiki markup — as plain
 * text a page can show. The page renderer drops raw HTML outright, so passing
 * it through would lose the words along with the tags.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16) || 32);
      if (entity.startsWith('#') && entity !== '#39') return String.fromCodePoint(Number(entity.slice(1)) || 32);
      return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A YouTrack text as Markdown: as is when written in Markdown, as plain text when it came as HTML. */
function ytText(value: string | null | undefined, usesMarkdown: boolean | undefined): string {
  const raw = text(value);
  return usesMarkdown === false || /^\s*<(div|p)\b/i.test(raw) ? htmlToText(raw) : raw;
}

function ytValue(value: YouTrackValue | YouTrackValue[] | string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(ytValue).filter(Boolean).join(', ');
  return value.fullName ?? value.name ?? value.presentation ?? value.login ?? value.text ?? '';
}

const iso = (millis: number | undefined | null): string | null =>
  typeof millis === 'number' ? new Date(millis).toISOString() : null;

function fromYouTrack(tracker: TrackerSettings, issue: YouTrackIssue, full: boolean): TrackerIssue {
  const fields: Record<string, string> = {};
  for (const field of issue.customFields ?? []) {
    if (field.name) fields[field.name] = ytValue(field.value);
  }
  const key = issue.idReadable ?? '';
  return {
    key,
    summary: text(issue.summary),
    status: fields.State || fields.Status || fields['Состояние'] || null,
    assignee: fields.Assignee || fields['Исполнитель'] || null,
    resolved: typeof issue.resolved === 'number',
    url: issueUrl(tracker, key),
    tracker: tracker.name,
    created: iso(issue.created),
    updated: iso(issue.updated),
    ...(full
      ? {
          description: ytText(issue.description, issue.usesMarkdown),
          reporter: issue.reporter?.fullName ?? issue.reporter?.login ?? null,
          comments: (issue.comments ?? []).map((comment) => ({
            author: comment.author?.fullName ?? comment.author?.login ?? '',
            created: iso(comment.created),
            text: ytText(comment.text, comment.usesMarkdown),
          })),
          fields,
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Jira                                                                */
/* ------------------------------------------------------------------ */

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string; statusCategory?: { key?: string } } | null;
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    created?: string;
    updated?: string;
    resolutiondate?: string | null;
    comment?: { comments?: Array<{ author?: { displayName?: string }; created?: string; body?: unknown }> };
  };
}

/** Jira Cloud's v3 answers in Atlassian Document Format; v2 and Data Center in wiki text. */
function jiraText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as { type?: string; text?: string; content?: unknown[] };
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(jiraText).join('');
  return node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem' ? `${inner}\n` : inner;
}

function fromJira(tracker: TrackerSettings, issue: JiraIssue, full: boolean): TrackerIssue {
  const fields = issue.fields ?? {};
  const key = issue.key ?? '';
  return {
    key,
    summary: text(fields.summary),
    status: fields.status?.name ?? null,
    assignee: fields.assignee?.displayName ?? null,
    resolved: Boolean(fields.resolutiondate) || fields.status?.statusCategory?.key === 'done',
    url: issueUrl(tracker, key),
    tracker: tracker.name,
    created: fields.created ?? null,
    updated: fields.updated ?? null,
    ...(full
      ? {
          description: jiraText(fields.description).trim(),
          reporter: fields.reporter?.displayName ?? null,
          comments: (fields.comment?.comments ?? []).map((comment) => ({
            author: comment.author?.displayName ?? '',
            created: comment.created ?? null,
            text: jiraText(comment.body).trim(),
          })),
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* One interface over both                                             */
/* ------------------------------------------------------------------ */

const KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;

export async function fetchIssue(
  tracker: TrackerSettings,
  key: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<TrackerIssue> {
  if (!KEY.test(key)) throw new TrackerError('notFound');
  if (tracker.kind === 'youtrack') {
    const issue = await getJson<YouTrackIssue>(
      tracker,
      `/api/issues/${encodeURIComponent(key)}?fields=${encodeURIComponent(YT_FULL_FIELDS)}`,
      fetchImpl,
    );
    return fromYouTrack(tracker, issue, true);
  }
  if (tracker.kind === 'jira') {
    const issue = await getJson<JiraIssue>(
      tracker,
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,status,assignee,reporter,created,updated,resolutiondate,comment`,
      fetchImpl,
    );
    return fromJira(tracker, issue, true);
  }
  throw new TrackerError('unsupported');
}

/**
 * Issues matching a query in the tracker's own language — YouTrack search
 * syntax (`project: MAC #Unresolved`) or JQL — at most `limit` of them.
 */
export async function searchIssues(
  tracker: TrackerSettings,
  query: string,
  limit = 50,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<TrackerIssue[]> {
  const top = Math.min(Math.max(limit, 1), 100);
  if (tracker.kind === 'youtrack') {
    const issues = await getJson<YouTrackIssue[]>(
      tracker,
      `/api/issues?query=${encodeURIComponent(query)}&$top=${top}&fields=${encodeURIComponent(YT_LIST_FIELDS)}`,
      fetchImpl,
    );
    return (Array.isArray(issues) ? issues : []).map((issue) => fromYouTrack(tracker, issue, false));
  }
  if (tracker.kind === 'jira') {
    const answer = await getJson<{ issues?: JiraIssue[] }>(
      tracker,
      `/rest/api/2/search?jql=${encodeURIComponent(query)}&maxResults=${top}&fields=summary,status,assignee,created,updated,resolutiondate`,
      fetchImpl,
    );
    return (answer.issues ?? []).map((issue) => fromJira(tracker, issue, false));
  }
  throw new TrackerError('unsupported');
}

/**
 * The tracker's query for "unresolved issues assigned to the person with this
 * address", or null when the tracker does not know them. The person is looked
 * up by address, never by a name typed into the query.
 */
export async function assignedQuery(
  tracker: TrackerSettings,
  email: string,
  fetchImpl: FetchLike = defaultFetch(),
): Promise<string | null> {
  if (tracker.kind === 'youtrack') {
    const users = await getJson<Array<{ login?: string; email?: string }>>(
      tracker,
      `/api/users?query=${encodeURIComponent(email)}&fields=login,email&$top=10`,
      fetchImpl,
    );
    const match = (Array.isArray(users) ? users : []).find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (!match?.login || !/^[\w.@-]+$/.test(match.login)) return null;
    return `for: ${match.login} #Unresolved`;
  }
  if (tracker.kind === 'jira') {
    const users = await getJson<Array<{ accountId?: string; name?: string; emailAddress?: string }>>(
      tracker,
      `/rest/api/2/user/search?query=${encodeURIComponent(email)}&username=${encodeURIComponent(email)}&maxResults=10`,
      fetchImpl,
    );
    const match = (Array.isArray(users) ? users : []).find(
      (user) => user.emailAddress === undefined || user.emailAddress.toLowerCase() === email.toLowerCase(),
    );
    const id = match?.accountId ?? match?.name;
    if (!id || !/^[\w.:@-]+$/.test(id)) return null;
    return `assignee = "${id}" AND resolution = Unresolved ORDER BY updated DESC`;
  }
  return null;
}
