import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { apiError, apiJson, readJsonBody, validationError } from '@/lib/api-response';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';
import { trackerErrorResponse } from '@/lib/trackers/api';
import { getIssue, issueToMarkdown, issuesToTable, search } from '@/lib/trackers/service';
import type { IssueMarkdownLabels } from '@/lib/trackers/service';

export const dynamic = 'force-dynamic';

const bodySchema = z.union([
  z.object({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,19}-\d{1,9}$/) }).strict(),
  z.object({ query: z.string().trim().min(1).max(500), tracker: z.string().regex(/^[0-9a-f]{12}$/).optional() }).strict(),
]);

/**
 * Page Markdown for the editor to insert: one issue in full (`{"key"}`), or a
 * table of the issues a query finds (`{"query"}`). Headings and labels are in
 * the reader's language. Nothing is stored here.
 */
export async function POST(request: Request) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof SyntaxError) return apiError(400, 'validation', error.message);
    throw error;
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);

  const t = await getTranslations('trackers');
  const labels: IssueMarkdownLabels = {
    status: t('mdStatus'),
    assignee: t('mdAssignee'),
    reporter: t('mdReporter'),
    created: t('mdCreated'),
    updated: t('mdUpdated'),
    link: t('mdLink'),
    description: t('mdDescription'),
    comments: t('mdComments'),
    summary: t('mdSummary'),
    key: t('mdKey'),
    none: '—',
  };
  try {
    if ('key' in parsed.data) {
      const issue = await getIssue(auth.identity.workspace, parsed.data.key);
      return apiJson({ title: `${issue.key}: ${issue.summary}`, markdown: issueToMarkdown(issue, labels) }, auth.headers);
    }
    const issues = await search(auth.identity.workspace, parsed.data.query, parsed.data.tracker ?? null, 100);
    if (issues.length === 0) return apiError(404, 'not_found', 'The query found no issues');
    return apiJson({ title: null, markdown: issuesToTable(issues, labels), count: issues.length }, auth.headers);
  } catch (error) {
    return trackerErrorResponse(error);
  }
}
