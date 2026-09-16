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
import { createAnchor, getFallbackShare, listAnchorsForPage } from '@/lib/anchors/service';
import { toAnchorResource, toFallbackShareResource } from '@/lib/anchors/serialize';
import { authorizePagesRequest, READ_SCOPES, WRITE_SCOPES } from '@/lib/pages-api';
import { getPageById } from '@/lib/pages/service';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.uuid() });

const createBodySchema = z.object({
  file: z.string().trim().min(1).max(512),
  qualified_name: z.string().trim().min(1).max(500).nullish(),
  kind: z.string().trim().min(1).max(50).nullish(),
  line_start: z.number().int().min(1).max(1_000_000).nullish(),
  line_end: z.number().int().min(1).max(1_000_000).nullish(),
  section_id: z.string().trim().min(1).max(200).nullish(),
  ref: z.string().trim().min(1).max(200).nullish(),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Anchors a page, or one of its sections, to a declaration in the workspace's
 * source repository.
 *
 * The declaration is resolved against the repository before the row is
 * written, so an anchor never starts life pointing at nothing: a misspelled
 * symbol is a `validation` failure here rather than a `lost` badge at the next
 * check. A block with no declaration to point at takes `line_start`/`line_end`
 * instead, which is the weaker fallback path and is counted as such.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;

  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) return apiError(404, 'not_found', 'Page not found');

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }

  const parsed = createBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  try {
    const page = await getPageById(auth.workspaceId, parsedParams.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;

    const anchor = await createAnchor({
      workspaceId: auth.workspaceId,
      pageId: page.id,
      actor: auth.actor,
      workspaceSettings: auth.identity.workspace.settings,
      file: parsed.data.file,
      qualifiedName: parsed.data.qualified_name,
      kind: parsed.data.kind,
      lineStart: parsed.data.line_start,
      lineEnd: parsed.data.line_end,
      sectionId: parsed.data.section_id,
      ref: parsed.data.ref,
    });

    return apiCreated(toAnchorResource(anchor), auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

/** Every anchor on one page, with the state its last check left behind. */
export async function GET(request: Request, context: RouteContext) {
  const auth = await authorizePagesRequest(request, READ_SCOPES);
  if (!auth.ok) return auth.response;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return apiError(404, 'not_found', 'Page not found');

  try {
    const page = await getPageById(auth.workspaceId, parsed.data.id);
    if (!page) return apiError(404, 'not_found', 'Page not found');

    const mismatch = requireWorkspace(auth.identity, page.workspaceId);
    if (mismatch) return mismatch;

    const [pageAnchors, fallbackShare] = await Promise.all([
      listAnchorsForPage(auth.workspaceId, page.id),
      getFallbackShare(auth.workspaceId),
    ]);

    return apiJson(
      {
        page_id: page.id,
        anchors: pageAnchors.map(toAnchorResource),
        fallback_share: toFallbackShareResource(fallbackShare),
      },
      auth.headers,
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
