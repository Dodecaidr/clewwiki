import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { authenticateRequest, requireWorkspace } from '@/lib/api-auth';
import { isWorkspaceAdmin } from '@/lib/pages-api';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';
import { MAX_SPACE_MEMBERS, listSpaceMembers, setSpaceMembers } from '@/lib/spaces/visibility';
import type { SpaceMember } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string }> };

const putBodySchema = z
  .object({ user_ids: z.array(z.string().min(1).max(200)).max(MAX_SPACE_MEMBERS) })
  .strict();

function toMemberResource(member: SpaceMember) {
  return {
    user_id: member.userId,
    name: member.name,
    email: member.email,
    workspace_role: member.workspaceRole,
    added_at: member.addedAt.toISOString(),
  };
}

const ADMINS_ONLY =
  'Only a workspace administrator can see or change who is in a space. A token cannot, whatever its scopes: the list is of people, and it names them.';

/**
 * The people a restricted space is visible to. Workspace administrators are not
 * listed unless somebody added them: they see every space regardless.
 *
 * A person who is signed in as an administrator, and nobody else. The list
 * carries names and e-mail addresses, which is more than an agent token — or an
 * editor — has any use for.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;
  if (!isWorkspaceAdmin(auth.identity)) return apiError(403, 'forbidden', ADMINS_ONLY);

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const members = await listSpaceMembers(auth.identity.workspaceId, resolved.space.id);
    return apiJson({
      space: { key: resolved.space.key, name: resolved.space.name, restricted: resolved.space.restricted },
      members: members.map(toMemberResource),
    });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Replaces the member list, whole. Listing people does not restrict the space —
 * `PATCH /api/v1/spaces/{key}` with `restricted: true` does — so a list can be
 * prepared before the space is closed and nobody is locked out in between.
 */
export async function PUT(request: Request, context: RouteContext) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;
  if (!isWorkspaceAdmin(auth.identity) || auth.identity.type !== 'user') {
    return apiError(403, 'forbidden', ADMINS_ONLY);
  }

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = putBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const members = await setSpaceMembers({
      workspaceId: auth.identity.workspaceId,
      spaceId: resolved.space.id,
      actor: { type: 'user', id: auth.identity.userId },
      userIds: parsed.data.user_ids,
    });
    return apiJson({
      space: { key: resolved.space.key, name: resolved.space.name, restricted: resolved.space.restricted },
      members: members.map(toMemberResource),
    });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
