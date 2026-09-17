import { z } from 'zod';

import {
  apiCreated,
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { authenticateRequest } from '@/lib/api-auth';
import { actorOf, authorizePagesRequest, isWorkspaceAdmin, READ_SCOPES } from '@/lib/pages-api';
import {
  spaceDescriptionSchema,
  spaceIconSchema,
  spaceKeyInputSchema,
  spaceNameSchema,
} from '@/lib/spaces/keys';
import { toSpaceResource } from '@/lib/spaces/serialize';
import { createSpace, listSpaceSummaries } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

const listQuerySchema = z.object({
  include_archived: z.enum(['true', 'false']).default('false'),
});

const createBodySchema = z.object({
  key: spaceKeyInputSchema,
  name: spaceNameSchema,
  description: spaceDescriptionSchema.default(''),
  icon: spaceIconSchema.nullish(),
});

/**
 * The spaces the caller can reach, with how many pages each holds and when one
 * last changed. A token limited to some spaces sees only those; archived
 * spaces are left out unless `include_archived=true`.
 */
export async function GET(request: Request) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = listQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);

  try {
    const summaries = await listSpaceSummaries(auth.workspaceId, {
      includeArchived: parsed.data.include_archived === 'true',
      spaceIds: auth.identity.spaceIds,
    });
    const includeRepository = isWorkspaceAdmin(auth.identity);
    return apiJson(
      { spaces: summaries.map((space) => toSpaceResource(space, { includeRepository })) },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Creates a space. An administrator's act: an agent token carries scopes but no
 * role, so no token can create one, the same rule token issuance follows.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;

  if (!isWorkspaceAdmin(auth.identity)) {
    return apiError(403, 'forbidden', 'Only a workspace administrator can create a space');
  }

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }

  const parsed = createBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const space = await createSpace({
      workspaceId: auth.identity.workspaceId,
      actor: actorOf(auth.identity),
      key: parsed.data.key,
      name: parsed.data.name,
      description: parsed.data.description,
      icon: parsed.data.icon ?? null,
    });
    return apiCreated(toSpaceResource(space, { includeRepository: true }), auth.headers ?? {});
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
