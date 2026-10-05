import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { devReleases } from '@clewwiki/db';

import { apiError, apiJson, readJsonBody, serviceErrorResponse, validationError } from '@/lib/api-response';
import { releaseResource } from '@/lib/development/api';
import { shipRelease } from '@/lib/development/service';
import { actorOf, authorizePagesRequest, WRITE_SCOPES } from '@/lib/pages-api';
import { getDatabase } from '@/lib/db';
import { canView } from '@/lib/spaces/visibility';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ force: z.boolean().optional() }).strict();

/**
 * Marks a release shipped. A `409` with `missing` names the streams not yet in
 * the default branch; `{"force": true}` ships anyway and records them.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizePagesRequest(request, WRITE_SCOPES);
  if (!auth.ok) return auth.response;
  let raw: unknown = {};
  try {
    raw = await readJsonBody(request);
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) return validationError(parsed.error);
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError(404, 'not_found', 'Release not found');
  try {
    const [row] = await getDatabase()
      .select({ spaceId: devReleases.spaceId })
      .from(devReleases)
      .where(and(eq(devReleases.id, id), eq(devReleases.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!row || !canView(auth.identity, row.spaceId)) return apiError(404, 'not_found', 'Release not found');
    const shipped = await shipRelease(auth.workspaceId, id, actorOf(auth.identity), parsed.data.force === true);
    return apiJson({ release: releaseResource(shipped.release), shipped_without: shipped.missing }, auth.headers);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
