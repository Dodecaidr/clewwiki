import { z } from 'zod';

import { apiError, apiJson, serviceErrorResponse, validationError } from '@/lib/api-response';
import { authenticateRequest, requireScopes, requireWorkspace } from '@/lib/api-auth';
import { listAuditEntries } from '@/lib/audit';
import { isWorkspaceAdmin } from '@/lib/pages-api';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  action: z.string().min(1).max(100).optional(),
  target: z.string().min(1).max(200).optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * The audit log of this workspace, newest first.
 *
 * It records both outcomes of every attempt, not only the ones that succeeded:
 * a claim that lost its race, a write refused for a stale hash and a
 * force-release all leave a row, which is what makes the log usable after an
 * incident rather than only during one.
 *
 * Readable by a workspace administrator, or by a token holding `audit:read`
 * and no space restriction — an editor account cannot read who did what across
 * the whole workspace, and neither can a token limited to some spaces.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return auth.response;

  const scopeError = requireScopes(auth.identity, ['audit:read']);
  if (scopeError) return scopeError;

  if (auth.identity.type === 'user' && !isWorkspaceAdmin(auth.identity)) {
    return apiError(403, 'forbidden', 'Only a workspace administrator can read the audit log');
  }

  // The log is workspace-wide: its rows name pages, paths and claims in every
  // space. A token limited to some spaces would read about the others through
  // it, so it cannot read the log at all, whatever its scopes.
  if (auth.identity.spaceIds !== null) {
    return apiError(
      403,
      'forbidden',
      'The audit log covers every space; a token limited to some spaces cannot read it',
    );
  }

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error);

  const mismatch = requireWorkspace(auth.identity, auth.identity.workspaceId);
  if (mismatch) return mismatch;

  try {
    const entries = await listAuditEntries(auth.identity.workspaceId, {
      action: parsed.data.action,
      target: parsed.data.target,
      since: parsed.data.since ? new Date(parsed.data.since) : undefined,
      limit: parsed.data.limit,
    });

    return apiJson(
      {
        entries: entries.map((entry) => ({
          id: entry.id,
          action: entry.action,
          target: entry.target,
          actor: { type: entry.actorType, id: entry.actorId },
          metadata: entry.metadata ?? {},
          created_at: entry.createdAt.toISOString(),
        })),
      },
      auth.headers ?? {},
    );
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
