import { z } from 'zod';

import {
  apiError,
  apiJson,
  readJsonBody,
  serviceErrorResponse,
  validationError,
} from '@/lib/api-response';
import { requireSpace } from '@/lib/api-auth';
import { authorizeImportRequest } from '@/lib/imports/auth';
import { toImportItemResource } from '@/lib/imports/serialize';
import { requireImport, updateImportItem } from '@/lib/imports/service';
import { getSpaceById } from '@/lib/spaces/service';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; itemId: string }> };

const patchSchema = z
  .object({
    decision: z.enum(['create', 'skip', 'overwrite']).optional(),
    target_path: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * The reviewer's edit: where this page should land, and whether it should be
 * created at all. Only while the import is still waiting for review — once it
 * has been applied, the pages are the thing to edit.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await authorizeImportRequest(request);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await readJsonBody(request);
  } catch {
    return apiError(400, 'validation', 'Request body is not valid JSON');
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  const { id, itemId } = await context.params;
  try {
    const record = await requireImport(auth.workspaceId, id);
    const space = await getSpaceById(auth.workspaceId, record.spaceId);
    if (!space) return apiError(404, 'not_found', 'Import not found');
    const outside = requireSpace(auth.identity, space.id);
    if (outside) return outside;

    const updated = await updateImportItem({
      workspaceId: auth.workspaceId,
      importId: record.id,
      itemId,
      actor: auth.actor,
      ...(parsed.data.decision === undefined ? {} : { decision: parsed.data.decision }),
      ...(parsed.data.target_path === undefined ? {} : { targetPath: parsed.data.target_path }),
    });
    return apiJson(toImportItemResource(updated));
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
