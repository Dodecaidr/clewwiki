import { z } from 'zod';

import {
  apiCreated,
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireWorkspace } from '@/lib/api-auth';
import { getAuthBaseUrl } from '@/lib/env';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { createSkill, listSkills } from '@/lib/skills/service';
import { toSkillListEntry, toSkillResource } from '@/lib/skills/serialize';
import { resolveSpaceParam } from '@/lib/spaces/access';
import { spaceKeyParamSchema } from '@/lib/spaces/keys';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ key: string }> };

const listQuerySchema = z.object({
  tag: z.string().trim().max(40).optional(),
});

const createBodySchema = z
  .object({
    name: z.string().max(200).optional(),
    description: z.string().max(4_000).optional(),
    version: z.string().max(200).nullish(),
    tags: z.array(z.string().max(80)).max(64).optional(),
    body: z.string().max(1_000_000).optional(),
    slug: z.string().max(200).optional(),
  })
  .strict();

/**
 * The skills of one space, without their bodies.
 *
 * A skill is an instruction package an agent installs locally; this is the
 * catalogue a chooser reads before deciding which ones to fetch in full.
 * `pages:read`, space-restricted.
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  const parsed = listQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;

    const found = await listSkills(auth.workspaceId, resolved.space.id, { tag: parsed.data.tag });
    return apiJson(
      {
        space: { key: resolved.space.key, name: resolved.space.name },
        skills: found.map(toSkillListEntry),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/**
 * Creates a skill in a space. `pages:write`, the same scope writing a page
 * needs: a skill is content of the space, written by whoever may write there.
 *
 * The body may be a whole `SKILL.md`; its front matter fills in any field the
 * request did not pass, and front matter that does not parse refuses the write
 * with `validation` naming the field and the line.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const key = spaceKeyParamSchema.safeParse((await context.params).key);
  if (!key.success) return apiError(404, 'not_found', 'Space not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = createBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const resolved = await resolveSpaceParam(auth.identity, key.data);
    if (!resolved.ok) return resolved.response;
    const mismatch = requireWorkspace(auth.identity, resolved.space.workspaceId);
    if (mismatch) return mismatch;
    if (resolved.space.archivedAt !== null) {
      return apiError(409, 'conflict', 'This space is archived and takes no new skills', {
        space: resolved.space.key,
      });
    }

    const created = await createSkill({
      workspaceId: auth.workspaceId,
      spaceId: resolved.space.id,
      spaceKey: resolved.space.key,
      actor: auth.actor,
      name: parsed.data.name,
      description: parsed.data.description,
      version: parsed.data.version,
      tags: parsed.data.tags,
      body: parsed.data.body,
      slug: parsed.data.slug,
    });
    return apiCreated(
      toSkillResource(created, resolved.space, { baseUrl: getAuthBaseUrl() }),
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
