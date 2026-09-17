import 'server-only';

import type { NextResponse } from 'next/server';

import { canSeeSpace } from '../api-auth';
import type { ApiIdentity } from '../api-auth';
import { apiError } from '../api-response';
import { getSpaceByKey, listSpaces } from './service';
import type { SpaceRecord } from './service';

/**
 * How a handler turns a `space` parameter, or its absence, into the set of
 * spaces a request may read.
 *
 * Two rules. A key the caller cannot see — because it does not exist, or
 * because the token is limited to other spaces — is `404 Space not found`,
 * whichever of the two it is. And "every space" means every space the caller
 * can see: for a limited token that is its list, never the workspace.
 */

export type SpaceParamResult =
  | { ok: true; space: SpaceRecord }
  | { ok: false; response: NextResponse };

export async function resolveSpaceParam(
  identity: ApiIdentity,
  key: string,
): Promise<SpaceParamResult> {
  const space = await getSpaceByKey(identity.workspaceId, key);
  // The workspace is in the lookup's predicate; the comparison is the explicit
  // check the handler owns, the same way pages do it.
  if (!space || space.workspaceId !== identity.workspaceId || !canSeeSpace(identity, space.id)) {
    return { ok: false, response: apiError(404, 'not_found', 'Space not found') };
  }
  return { ok: true, space };
}

/**
 * The spaces a caller can see. Archived spaces are left out unless asked for:
 * "all spaces" in a search or a listing means the ones in use.
 */
export async function visibleSpaces(
  identity: ApiIdentity,
  options: { includeArchived?: boolean } = {},
): Promise<SpaceRecord[]> {
  return listSpaces(identity.workspaceId, {
    includeArchived: options.includeArchived,
    spaceIds: identity.spaceIds,
  });
}
