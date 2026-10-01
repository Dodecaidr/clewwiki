import { afterEach, describe, expect, it } from 'vitest';

import { renderMarkdown } from '@/lib/pages/markdown';
import { TrackerError, assignedQuery, fetchIssue, htmlToText, searchIssues } from '@/lib/trackers/client';
import type { FetchLike } from '@/lib/trackers/client';
import { clearIssueCache, getIssueSummaries, issueToMarkdown, issuesToTable } from '@/lib/trackers/service';
import {
  TrackerSettingsError,
  findIssueKeys,
  issueLinker,
  issueUrl,
  normalizeTracker,
  trackerForKey,
} from '@/lib/trackers/settings';
import type { TrackerSettings } from '@/lib/trackers/settings';

/**
 * Issue trackers: what an administrator may link, how keys in pages become
 * links, and how YouTrack and Jira answers are read — all without a network.
 */

const youtrack: TrackerSettings = {
  id: 'aaaaaaaaaaaa',
  kind: 'youtrack',
  name: 'YouTrack',
  base_url: 'https://yt.example.com',
  projects: ['APP', 'MAC'],
  token_env: 'CLEWWIKI_TRACKER_TOKEN_YT',
};
const jira: TrackerSettings = {
  id: 'bbbbbbbbbbbb',
  kind: 'jira',
  name: 'Jira',
  base_url: 'https://acme.atlassian.net',
  projects: ['WEB'],
  token_env: 'CLEWWIKI_TRACKER_TOKEN_JIRA',
};
const gitlab: TrackerSettings = {
  id: 'cccccccccccc',
  kind: 'other',
  name: 'GitLab',
  base_url: 'https://gitlab.example.com',
  projects: ['GL'],
  url_template: 'https://gitlab.example.com/group/app/-/issues/{number}',
};

const field = (input: Partial<Parameters<typeof normalizeTracker>[0]>) => {
  try {
    normalizeTracker({ kind: 'youtrack', name: 'YT', baseUrl: 'https://yt.example.com', projects: 'MAC', ...input }, 'x');
    return 'ok';
  } catch (error) {
    return error instanceof TrackerSettingsError ? error.field : String(error);
  }
};

afterEach(() => {
  delete process.env.CLEWWIKI_TRACKER_TOKEN_YT;
  delete process.env.CLEWWIKI_TRACKER_TOKEN_JIRA;
  clearIssueCache();
});

describe('tracker settings', () => {
  it('keeps what an administrator may link, and nothing that would carry a secret', () => {
    expect(normalizeTracker({ kind: 'youtrack', name: ' YT ', baseUrl: 'https://yt.example.com/youtrack/', projects: 'mac, app;MAC' }, 'id1')).toEqual({
      id: 'id1',
      kind: 'youtrack',
      name: 'YT',
      base_url: 'https://yt.example.com/youtrack',
      projects: ['MAC', 'APP'],
    });
    expect(field({ baseUrl: 'http://yt.example.com' })).toBe('base_url');
    expect(field({ baseUrl: 'https://user:pass@yt.example.com' })).toBe('base_url');
    expect(field({ baseUrl: 'https://yt.example.com/?token=1' })).toBe('base_url');
    expect(field({ projects: '1ABC' })).toBe('projects');
    expect(field({ projects: '' })).toBe('projects');
    expect(field({ tokenEnv: 'DATABASE_URL' })).toBe('token_env');
    expect(field({ tokenEnv: 'CLEWWIKI_TRACKER_TOKEN_YT' })).toBe('ok');
    expect(field({ kind: 'other', urlTemplate: 'https://gl.example.com/issues' })).toBe('url_template');
    expect(field({ kind: 'other', urlTemplate: 'javascript:alert({key})' })).toBe('url_template');
    expect(field({ kind: 'other', urlTemplate: 'https://gl.example.com/-/issues/{number}' })).toBe('ok');
    expect(field({ kind: 'svn' })).toBe('kind');
  });

  it('finds keys of linked projects only, and builds each tracker’s issue address', () => {
    const trackers = [youtrack, jira, gitlab];
    expect(findIssueKeys('See APP-978, MAC-1 and WEB-7; not XAPP-1, MAC-2x or ABC-3. APP-978 again. GL-15', trackers)).toEqual([
      'APP-978',
      'MAC-1',
      'WEB-7',
      'GL-15',
    ]);
    expect(findIssueKeys('MAC-1 and `MAC-2`\n\n```\nMAC-3\n```\nMAC-4', trackers)).toEqual(['MAC-1', 'MAC-4']);
    expect(trackerForKey(trackers, 'WEB-7')?.name).toBe('Jira');
    expect(issueUrl(youtrack, 'MAC-1')).toBe('https://yt.example.com/issue/MAC-1');
    expect(issueUrl(jira, 'WEB-7')).toBe('https://acme.atlassian.net/browse/WEB-7');
    expect(issueUrl(gitlab, 'GL-15')).toBe('https://gitlab.example.com/group/app/-/issues/15');
  });

  it('links keys in rendered pages, but not inside code or an existing link', async () => {
    const html = await renderMarkdown(
      'Fixes MAC-42 here.\n\n`MAC-43` and [MAC-44](https://elsewhere.example) stay.\n\n```\nMAC-45\n```',
      {},
      undefined,
      issueLinker([youtrack]),
    );
    expect(html).toContain('<a href="https://yt.example.com/issue/MAC-42" class="issue-link" rel="noopener noreferrer">MAC-42</a>');
    expect(html).not.toContain('issue/MAC-43');
    expect(html).not.toContain('issue/MAC-44');
    expect(html).not.toContain('issue/MAC-45');
    expect(await renderMarkdown('MAC-42')).not.toContain('<a');
  });
});

function jsonFetch(routes: Record<string, unknown>, seen: string[] = []): FetchLike {
  return async (url, init) => {
    seen.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`);
    const path = url.replace(/^https:\/\/[^/]+/, '');
    const match = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!match) return new Response('{}', { status: 404 });
    const body = routes[match];
    if (typeof body === 'number') return new Response('{}', { status: body });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('tracker clients', () => {
  it('reads a YouTrack issue: state, assignee, description and comments', async () => {
    process.env.CLEWWIKI_TRACKER_TOKEN_YT = 'perm:secret';
    const seen: string[] = [];
    const issue = await fetchIssue(
      youtrack,
      'MAC-42',
      jsonFetch(
        {
          '/api/issues/MAC-42': {
            idReadable: 'MAC-42',
            summary: 'Battery test hangs',
            description: 'Steps:\n1. Run',
            resolved: null,
            created: 1_700_000_000_000,
            reporter: { fullName: 'Ada' },
            customFields: [
              { name: 'State', value: { name: 'In Progress' } },
              { name: 'Assignee', value: { fullName: 'Grace', login: 'grace' } },
              { name: 'Tags', value: [{ name: 'mac' }, { name: 'qa' }] },
            ],
            comments: [{ text: 'Seen on M3', created: 1_700_000_100_000, author: { fullName: 'Linus' } }],
          },
        },
        seen,
      ),
    );
    expect(issue).toMatchObject({
      key: 'MAC-42',
      summary: 'Battery test hangs',
      status: 'In Progress',
      assignee: 'Grace',
      resolved: false,
      url: 'https://yt.example.com/issue/MAC-42',
      reporter: 'Ada',
      fields: { Tags: 'mac, qa' },
      comments: [{ author: 'Linus', text: 'Seen on M3' }],
    });
    expect(seen[0]).toContain('Bearer perm:secret');
  });

  it('turns the HTML of an issue in YouTrack’s older wiki markup into text a page keeps', async () => {
    expect(
      htmlToText('<div class="wiki text prewrapped"><a href="/issue/KT-1">KT-1</a>?  wow.<br/>Don&#39;t &amp; <strong>stop</strong></div>\n'),
    ).toBe("KT-1?  wow.\nDon't & stop");
    process.env.CLEWWIKI_TRACKER_TOKEN_YT = 't';
    const issue = await fetchIssue(
      youtrack,
      'MAC-1',
      jsonFetch({
        '/api/issues/MAC-1': {
          idReadable: 'MAC-1',
          usesMarkdown: false,
          description: '<p>Old <em>style</em></p>',
          comments: [{ text: '<div>legacy</div>', usesMarkdown: false }, { text: '**md** <kbd>x</kbd>', usesMarkdown: true }],
        },
      }),
    );
    expect(issue.description).toBe('Old style');
    expect(issue.comments?.map((comment) => comment.text)).toEqual(['legacy', '**md** <kbd>x</kbd>']);
  });

  it('reads Jira, Cloud’s document format included, with Basic for an email:token', async () => {
    process.env.CLEWWIKI_TRACKER_TOKEN_JIRA = 'me@acme.test:api-token';
    const seen: string[] = [];
    const issue = await fetchIssue(
      jira,
      'WEB-7',
      jsonFetch(
        {
          '/rest/api/2/issue/WEB-7': {
            key: 'WEB-7',
            fields: {
              summary: 'Login form',
              status: { name: 'Done', statusCategory: { key: 'done' } },
              assignee: { displayName: 'Grace' },
              description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use SSO' }] }] },
            },
          },
        },
        seen,
      ),
    );
    expect(issue).toMatchObject({ key: 'WEB-7', status: 'Done', resolved: true, description: 'Use SSO' });
    expect(seen[0]).toContain(`Basic ${Buffer.from('me@acme.test:api-token').toString('base64')}`);
  });

  it('says why a read failed, and never reads without a token', async () => {
    await expect(fetchIssue(youtrack, 'MAC-1', jsonFetch({}))).rejects.toMatchObject({ code: 'noToken' });
    process.env.CLEWWIKI_TRACKER_TOKEN_YT = 't';
    await expect(fetchIssue(youtrack, 'MAC-1', jsonFetch({}))).rejects.toMatchObject({ code: 'notFound' });
    await expect(fetchIssue(youtrack, 'MAC-1', jsonFetch({ '/api/issues': 401 }))).rejects.toMatchObject({ code: 'denied' });
    await expect(fetchIssue(youtrack, 'not a key', jsonFetch({}))).rejects.toBeInstanceOf(TrackerError);
    await expect(fetchIssue(gitlab, 'GL-1', jsonFetch({}))).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('finds a person’s queue by their exact address, never by text typed into the query', async () => {
    process.env.CLEWWIKI_TRACKER_TOKEN_YT = 't';
    const users = [
      { login: 'grace.h', email: 'grace@acme.test' },
      { login: 'evil', email: 'grace@acme.test.evil' },
    ];
    expect(await assignedQuery(youtrack, 'Grace@acme.test', jsonFetch({ '/api/users': users }))).toBe('for: grace.h #Unresolved');
    expect(await assignedQuery(youtrack, 'nobody@acme.test', jsonFetch({ '/api/users': users }))).toBeNull();
    const seen: string[] = [];
    await searchIssues(youtrack, 'for: grace.h #Unresolved', 10, jsonFetch({ '/api/issues': [] }, seen));
    expect(seen[0]).toContain('/api/issues?query=for%3A%20grace.h%20%23Unresolved&$top=10');
  });

  it('reads the summaries of a page’s keys in one search per tracker, then from the cache', async () => {
    process.env.CLEWWIKI_TRACKER_TOKEN_YT = 't';
    const workspace = { id: 'w1', settings: { trackers: [youtrack, gitlab] } };
    const seen: string[] = [];
    const fetchMock = jsonFetch(
      {
        '/api/issues?': [
          { idReadable: 'MAC-1', summary: 'One', customFields: [{ name: 'State', value: { name: 'Open' } }] },
          { idReadable: 'MAC-2', summary: 'Two', resolved: 1 },
        ],
      },
      seen,
    );
    const first = await getIssueSummaries(workspace, ['MAC-1', 'MAC-2', 'GL-5'], fetchMock);
    expect([...first.keys()].sort()).toEqual(['MAC-1', 'MAC-2']);
    expect(first.get('MAC-2')?.resolved).toBe(true);
    expect(seen).toHaveLength(1);
    expect(decodeURIComponent(seen[0] ?? '')).toContain('query=issue ID: MAC-1, MAC-2');
    await getIssueSummaries(workspace, ['MAC-1'], fetchMock);
    expect(seen).toHaveLength(1);
  });
});

describe('issues as page Markdown', () => {
  const labels = {
    status: 'Status',
    assignee: 'Assignee',
    reporter: 'Reporter',
    created: 'Created',
    updated: 'Updated',
    link: 'In the tracker',
    description: 'Description',
    comments: 'Comments',
    summary: 'Summary',
    key: 'Issue',
    none: '—',
  };
  const issue = {
    key: 'MAC-42',
    summary: 'Pipes | here',
    status: 'Open',
    assignee: null,
    resolved: false,
    url: 'https://yt.example.com/issue/MAC-42',
    tracker: 'YouTrack',
    created: '2025-01-02T00:00:00.000Z',
    updated: null,
    description: 'Do it.',
    reporter: 'Ada',
    comments: [{ author: 'Linus', created: '2025-01-03T00:00:00.000Z', text: 'line one\n\nline two' }],
  };

  it('writes one issue as facts, description and quoted comments', () => {
    const markdown = issueToMarkdown(issue, labels);
    expect(markdown).toContain('| Assignee | — |');
    expect(markdown).toContain('| In the tracker | [MAC-42](https://yt.example.com/issue/MAC-42) |');
    expect(markdown).toContain('## Description\n\nDo it.');
    expect(markdown).toContain('> **Linus** · 2025-01-03\n>\n> line one\n>\n> line two');
  });

  it('writes many issues as one table, escaping what would break it', () => {
    expect(issuesToTable([issue], labels)).toBe(
      '| Issue | Summary | Status | Assignee |\n| --- | --- | --- | --- |\n| [MAC-42](https://yt.example.com/issue/MAC-42) | Pipes \\| here | Open | — |',
    );
  });
});
