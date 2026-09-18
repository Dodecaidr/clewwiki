import { z } from 'zod';

import {
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireSpace, requireWorkspace } from '@/lib/api-auth';
import { MAX_DECISION_FIELD_LENGTH, getDiscussionById, resolveDiscussion } from '@/lib/discussions/service';
import { toDiscussionStub } from '@/lib/discussions/serialize';
import { locales } from '@/i18n/locale';
import { authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const paramsSchema = z.object({ id: z.uuid() });

const bodySchema = z
  .object({
    decision: z.string().min(1).max(MAX_DECISION_FIELD_LENGTH),
    context: z.string().max(MAX_DECISION_FIELD_LENGTH).nullish(),
    options: z.string().max(MAX_DECISION_FIELD_LENGTH).nullish(),
    consequences: z.string().max(MAX_DECISION_FIELD_LENGTH).nullish(),
    locale: z.enum(locales).optional(),
  })
  .strict();

/**
 * Resolves a discussion into a decision page. `pages:write` — it writes a page,
 * which is exactly the scope writing a page needs.
 *
 * `decision` is required, and that requirement is the feature. A thread can be
 * closed by walking away from it — the sweep does that for free — so the only
 * reason to call this endpoint is to leave something behind, and an endpoint
 * that accepted an empty decision would let a caller throw away the one part of
 * the conversation worth keeping while feeling tidy about it.
 *
 * Nothing here summarises anything. `context`, `options` and `consequences` are
 * the caller's own prose, quoted or condensed from the thread by whoever read
 * it; the server puts them under headings and stamps the participants and the
 * dates on the end.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Discussion not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const existing = await getDiscussionById(auth.workspaceId, parsedParams.data.id);
    if (!existing) return apiError(404, 'not_found', 'Discussion not found');

    const mismatch = requireWorkspace(auth.identity, existing.workspaceId);
    if (mismatch) return mismatch;
    const outOfReach = requireSpace(auth.identity, existing.spaceId);
    if (outOfReach) return outOfReach;

    const result = await resolveDiscussion({
      workspaceId: auth.workspaceId,
      discussionId: existing.id,
      actor: { ...auth.actor, label: auth.identity.name },
      decision: parsed.data.decision,
      context: parsed.data.context ?? null,
      options: parsed.data.options ?? null,
      consequences: parsed.data.consequences ?? null,
      locale: parsed.data.locale,
    });

    const space = await getSpaceById(auth.workspaceId, result.discussion.spaceId);
    if (!space) return apiError(404, 'not_found', 'Discussion not found');

    return apiJson(
      {
        ...toDiscussionStub(result.discussion, space),
        decision_page: {
          page_id: result.page.id,
          path: result.page.path,
          title: result.page.title,
          content_hash: result.page.contentHash,
          version: result.page.version,
          created: result.created,
        },
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
