import { z } from 'zod';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { authenticateRequest, requireWorkspace } from '@/lib/api-auth';
import { actorOf, authorizePagesRequest, isWorkspaceAdmin, READ_SCOPES } from '@/lib/pages-api';
import { repositorySettingsSchema } from '@/lib/repository/settings';
import { resolveSpaceParam } from '@/lib/spaces/access';
import {
  spaceDescriptionSchema,
  spaceIconSchema,
  spaceKeyParamSchema,
  spaceNameSchema,
} from '@/lib/spaces/keys';
import { toSpaceResource } from '@/lib/spaces/serialize';
import { listSpaceSummaries, updateSpace } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string }> };

const patchBodySchema = z
  .object({
    name: spaceNameSchema.optional(),
    description: spaceDescriptionSchema.optional(),
    icon: spaceIconSchema.nullish(),
    home_page_id: z.uuid().nullable().optional(),
    rules_page_id: z.uuid().nullable().optional(),
    repository: repositorySettingsSchema.nullable().optional(),
  })
  .strict();

/** One space, with its page count. */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const [summary] = await listSpaceSummaries(auth.workspaceId, {
      includeArchived: true,
      spaceIds: [resolved.space.id],
    });
    return apiJson(
      toSpaceResource(summary ?? resolved.space, { includeRepository: isWorkspaceAdmin(auth.identity) }),
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Changes a space: name, description, icon, home page, rules page, repository.
 * The key is
 * immutable — it is in every URL and every agent prompt that names the space —
 * and a body that tries to change it is refused rather than half-applied.
 * Administrators only.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;

  if (!isWorkspaceAdmin(auth.identity)) {
    return apiError(403, 'forbidden', 'Only a workspace administrator can change a space');
  }

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }

  if (typeof raw === 'object' && raw !== null && 'key' in raw) {
    return apiError(400, 'validation', 'A space key cannot be changed', {
      fields: { key: ['The key is fixed when the space is created'] },
    });
  }

  const parsed = patchBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const updated = await updateSpace({
      workspaceId: auth.identity.workspaceId,
      spaceId: resolved.space.id,
      actor: actorOf(auth.identity),
      name: parsed.data.name,
      description: parsed.data.description,
      icon: parsed.data.icon,
      homePageId: parsed.data.home_page_id,
      rulesPageId: parsed.data.rules_page_id,
      repository: parsed.data.repository,
    });
    return apiJson(toSpaceResource(updated, { includeRepository: true }), auth.headers ?? {});
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
