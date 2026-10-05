import 'server-only';

import { apiError } from '../api-response';
import { requireWorkspace } from '../api-auth';
import type { ApiIdentity } from '../api-auth';
import { resolveSpaceParam } from '../spaces/access';
import { spaceKeyParamSchema } from '../spaces/keys';
import type { SpaceRecord } from '../spaces/service';

/** The space named in the route, if the caller may see it. */
export async function spaceFromRoute(
  identity: ApiIdentity,
  rawKey: string,
): Promise<{ ok: true; space: SpaceRecord } | { ok: false; response: Response }> {
  const key = spaceKeyParamSchema.safeParse(rawKey);
  if (!key.success) return { ok: false, response: apiError(404, 'not_found', 'Space not found') };
  const resolved = await resolveSpaceParam(identity, key.data);
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const mismatch = requireWorkspace(identity, resolved.space.workspaceId);
  if (mismatch) return { ok: false, response: mismatch };
  return { ok: true, space: resolved.space as SpaceRecord };
}
