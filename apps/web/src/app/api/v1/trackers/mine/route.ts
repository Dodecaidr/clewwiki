import { apiError, apiJson } from '@/lib/api-response';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { emailOf, issueResource, trackerErrorResponse } from '@/lib/trackers/api';
import { assignedTo } from '@/lib/trackers/service';

export const dynamic = 'force-dynamic';

/**
 * Unresolved issues assigned to the caller: the signed-in person, or for an
 * agent token the person who issued it — the agent works their queue.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  const email = await emailOf(auth.identity);
  if (!email) return apiError(409, 'no_owner', 'The token has no owner whose issues these would be');
  try {
    const issues = await assignedTo(auth.identity.workspace, email);
    return apiJson({ assignee_email: email, issues: issues.map(issueResource) }, auth.headers);
  } catch (error) {
    return trackerErrorResponse(error);
  }
}
