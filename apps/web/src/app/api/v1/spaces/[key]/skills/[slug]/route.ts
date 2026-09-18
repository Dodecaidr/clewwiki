import { z } from 'zod';

import {
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { getAuthBaseUrl } from '@/lib/env';
import { authorizePagesRequest, DELETE_SCOPES, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { deleteSkill, getSkillBySlug, updateSkill } from '@/lib/skills/service';
import { toSkillResource } from '@/lib/skills/serialize';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string; slug: string }> };

/** A slug as it arrives in a URL. Anything unusable is simply "not found". */
const slugParamSchema = z
  .string()
  .max(200)
  .transform((value) => value.trim().toLowerCase());

const patchBodySchema = z
  .object({
    name: z.string().max(200).optional(),
    description: z.string().max(4_000).optional(),
    version: z.string().max(200).nullish(),
    tags: z.array(z.string().max(80)).max(64).optional(),
    body: z.string().max(1_000_000).optional(),
    slug: z.string().max(200).optional(),
  })
  .strict();

/** One skill in full: the body, the assembled `SKILL.md`, and how to install it. */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const params = await context.params;
  const key = spaceKeyParamSchema.safeParse(params.key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');
  const slug = slugParamSchema.parse(params.slug);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const skill = await getSkillBySlug(auth.workspaceId, resolved.space.id, slug);
    if (!skill) return apiError(404, 'not_found', 'Skill not found');

    return apiJson(
      toSkillResource(skill, resolved.space, { baseUrl: getAuthBaseUrl() }),
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/** Changes a skill. `pages:write`. Fields left out keep their stored values. */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const params = await context.params;
  const key = spaceKeyParamSchema.safeParse(params.key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');
  const slug = slugParamSchema.parse(params.slug);

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = patchBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const updated = await updateSkill({
      workspaceId: auth.workspaceId,
      spaceId: resolved.space.id,
      spaceKey: resolved.space.key,
      slug,
      actor: auth.actor,
      name: parsed.data.name,
      description: parsed.data.description,
      version: parsed.data.version,
      tags: parsed.data.tags,
      body: parsed.data.body,
      newSlug: parsed.data.slug,
    });
    return apiJson(
      toSkillResource(updated, resolved.space, { baseUrl: getAuthBaseUrl() }),
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Removes a skill. `pages:delete` on top of `pages:write`, the same pair
 * deleting a page needs: an agent that writes documentation rarely needs to be
 * able to take a project's instructions away from everyone who installs them.
 */
export async function DELETE(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, DELETE_SCOPES);
  if (!auth.ok) return auth.response;

  const params = await context.params;
  const key = spaceKeyParamSchema.safeParse(params.key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');
  const slug = slugParamSchema.parse(params.slug);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const deleted = await deleteSkill({
      workspaceId: auth.workspaceId,
      spaceId: resolved.space.id,
      spaceKey: resolved.space.key,
      slug,
      actor: auth.actor,
    });
    return apiJson({ slug: deleted.slug, deleted: true }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
