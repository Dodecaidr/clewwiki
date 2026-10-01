import { apiJson } from '@/lib/api-response';
import { getTrackerToken } from '@/lib/env';
import { authorizePagesRequest, READ_SCOPES } from '@/lib/pages-api';
import { readTrackers } from '@/lib/trackers/settings';

export const dynamic = 'force-dynamic';

/** The organization's linked trackers: names, addresses, project keys, whether issues can be read. No secret. */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;
  return apiJson(
    {
      trackers: readTrackers(auth.identity.workspace).map((tracker) => ({
        id: tracker.id,
        name: tracker.name,
        kind: tracker.kind,
        base_url: tracker.base_url,
        projects: tracker.projects,
        readable: tracker.kind !== 'other' && getTrackerToken(tracker.token_env) !== null,
      })),
    },
    auth.headers,
  );
}
