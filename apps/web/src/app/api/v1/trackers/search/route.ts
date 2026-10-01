import { z } from 'zod';

import { apiJson, validationError } from '@/lib/api-response';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { issueResource, trackerErrorResponse } from '@/lib/trackers/api';
import { search } from '@/lib/trackers/service';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().trim().min(1).max(500),
  tracker: z.string().regex(/^[0-9a-f]{12}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Issues matching a query in the tracker's own language: YouTrack search syntax or JQL. */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);
  try {
    const issues = await search(auth.identity.workspace, parsed.data.q, parsed.data.tracker ?? null, parsed.data.limit);
    return apiJson({ issues: issues.map(issueResource) }, auth.headers);
  } catch (error) {
    return trackerErrorResponse(error);
  }
}
