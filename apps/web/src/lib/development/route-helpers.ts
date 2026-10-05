import 'server-only';

import { apiError } from '../api-response';
import type { ApiIdentity } from '../api-auth';
import { canView } from '../spaces/visibility';
import { getStream } from './service';
import type { StreamRecord } from './service';

/** A stream the caller may see, or the 404 that says nothing about one they may not. */
export async function visibleStream(
  identity: ApiIdentity,
  streamId: string,
): Promise<{ ok: true; stream: StreamRecord } | { ok: false; response: Response }> {
  const stream = /^[0-9a-f-]{36}$/i.test(streamId) ? await getStream(identity.workspaceId, streamId) : null;
  if (!stream || !canView(identity, stream.spaceId)) {
    return { ok: false, response: apiError(404, 'not_found', 'Stream not found') };
  }
  return { ok: true, stream };
}
