import 'server-only';

import { eq } from 'drizzle-orm';
import { agentTokens, users } from '@clewwiki/db';

import { apiError } from '../api-response';
import type { ApiIdentity } from '../api-auth';
import { getDatabase } from '../db';
import { TrackerError } from './client';
import type { TrackerIssue } from './client';

/** A tracker failure as a REST answer the caller can act on. */
export function trackerErrorResponse(error: unknown) {
  if (!(error instanceof TrackerError)) throw error;
  switch (error.code) {
    case 'noToken':
      return apiError(409, 'not_configured', 'No tracker of this organization can be read: an administrator has to link one with a token');
    case 'notFound':
      return apiError(404, 'not_found', 'No such issue, or no linked tracker owns that key');
    case 'denied':
      return apiError(502, 'tracker_denied', 'The tracker refused the token this wiki uses');
    case 'unsupported':
      return apiError(409, 'not_supported', 'This tracker is linked for its addresses only');
    default:
      return apiError(502, 'tracker_unavailable', error.message);
  }
}

export function issueResource(issue: TrackerIssue): Record<string, unknown> {
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    assignee: issue.assignee,
    resolved: issue.resolved,
    url: issue.url,
    tracker: issue.tracker,
    created: issue.created,
    updated: issue.updated,
    ...(issue.description !== undefined
      ? { description: issue.description, reporter: issue.reporter ?? null, comments: issue.comments ?? [], fields: issue.fields ?? {} }
      : {}),
  };
}

/**
 * Whose issues "mine" are: a person's own address, or — for an agent token —
 * the address of the person who issued it. An agent works on behalf of
 * somebody, and its tasks are the ones assigned to them.
 */
export async function emailOf(identity: ApiIdentity): Promise<string | null> {
  if (identity.type === 'user') return identity.email;
  const [row] = await getDatabase()
    .select({ email: users.email })
    .from(agentTokens)
    .innerJoin(users, eq(users.id, agentTokens.createdBy))
    .where(eq(agentTokens.id, identity.tokenId))
    .limit(1);
  return row?.email ?? null;
}
