import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { streamResource } from '@/lib/development/api';
import { visibleStream } from '@/lib/development/route-helpers';
import { STREAM_STATES, listStreamProblems, streamIssueKeys, updateStream } from '@/lib/development/service';
import { actorOf, authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getIssueSummaries } from '@/lib/trackers/service';
import { issueResource } from '@/lib/trackers/api';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** One stream with its problems and the state of its issues. */
export async function GET(request: Request, context: Context) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  try {
    const found = await visibleStream(auth.identity, (await context.params).id);
    if (!found.ok) return found.response;
    const problems = await listStreamProblems(auth.workspaceId, found.stream.id);
    const keys = streamIssueKeys(found.stream, auth.identity.workspace);
    const issues = keys.length > 0 ? await getIssueSummaries(auth.identity.workspace, keys) : new Map();
    return apiJson(
      {
        stream: streamResource(found.stream, auth.identity.workspace, {
          openProblems: problems.filter((problem) => problem.status === 'open').length,
        }),
        problems: problems.map((problem) => ({
          discussion_id: problem.id,
          title: problem.title,
          status: problem.status,
          opened_by: problem.openedByLabel,
          last_activity_at: problem.lastActivityAt.toISOString(),
          decision_page_id: problem.decisionPageId,
        })),
        issues: keys.map((key) => {
          const issue = issues.get(key);
          return issue ? issueResource(issue) : { key, readable: false };
        }),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

const patchSchema = z
  .object({
    title: z.string().min(1).max(240).optional(),
    branch: z.string().max(200).nullable().optional(),
    state: z.enum(STREAM_STATES).optional(),
    goal: z.string().max(40_000).optional(),
    issue_keys: z.array(z.string().max(40)).max(50).optional(),
    release_id: z.uuid().nullable().optional(),
    docs_page_id: z.uuid().nullable().optional(),
  })
  .strict();

/** Changes a stream: its state as work moves on, its goal, issues, release or documentation page. */
export async function PATCH(request: Request, context: Context) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;
  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);
  try {
    const found = await visibleStream(auth.identity, (await context.params).id);
    if (!found.ok) return found.response;
    const updated = await updateStream(auth.workspaceId, found.stream.id, actorOf(auth.identity), {
      title: parsed.data.title,
      ref: parsed.data.branch,
      state: parsed.data.state,
      goal: parsed.data.goal,
      issueKeys: parsed.data.issue_keys,
      releaseId: parsed.data.release_id,
      docsPageId: parsed.data.docs_page_id,
    });
    return apiJson({ stream: streamResource(updated, auth.identity.workspace) }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
