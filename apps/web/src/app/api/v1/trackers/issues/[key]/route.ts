import { apiError, apiJson } from '@/lib/api-response';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { issueResource, trackerErrorResponse } from '@/lib/trackers/api';
import { getIssue } from '@/lib/trackers/service';

export const dynamic = 'force-dynamic';

/** One issue in full — description, comments, fields — read from the tracker now. */
export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  const { key } = await context.params;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,19}-\d{1,9}$/.test(key)) return apiError(404, 'not_found', 'Not an issue key');
  try {
    return apiJson({ issue: issueResource(await getIssue(auth.identity.workspace, key)) }, auth.headers);
  } catch (error) {
    return trackerErrorResponse(error);
  }
}
