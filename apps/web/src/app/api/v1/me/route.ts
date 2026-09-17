import { NextResponse } from 'next/server';

import { authenticateRequest, requireScopes, requireWorkspace } from '@/lib/api-auth';
import { listSpaces } from '@/lib/spaces/service';
import { getWorkspaceById } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Identity of the caller: which principal, what it is allowed to do, which
 * workspace it is bound to and which spaces it can reach. Accepts either a
 * browser session or an agent bearer token.
 *
 * `space_access.all` is true for a person and for a token with no space
 * restriction; `space_access.spaces` lists the spaces the caller can reach
 * either way, archived ones included and marked, so an agent knows where it may
 * work without a second request.
 */
export async function GET(request: Request) {
  const result = await authenticateRequest(request);
  if (!result.ok) return result.response;

  const { identity } = result;

  const scopeError = requireScopes(identity, ['identity:read']);
  if (scopeError) return scopeError;

  // The workspace is re-read and re-checked against the caller rather than
  // taken on trust from the authentication step. Handlers own this check.
  const workspace = await getWorkspaceById(identity.workspaceId);
  if (!workspace) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Resource not found' } },
      { status: 404 },
    );
  }

  const scopeMismatch = requireWorkspace(identity, workspace.id);
  if (scopeMismatch) return scopeMismatch;

  const reachable = await listSpaces(workspace.id, {
    includeArchived: true,
    spaceIds: identity.spaceIds,
  });
  const spaceAccess = {
    all: identity.spaceIds === null,
    spaces: reachable.map((space) => ({
      key: space.key,
      name: space.name,
      archived: space.archivedAt !== null,
    })),
  };

  const body =
    identity.type === 'user'
      ? {
          actor: {
            type: 'user' as const,
            id: identity.userId,
            name: identity.name,
            email: identity.email,
          },
          role: identity.role,
          scopes: null,
          workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
          space_access: spaceAccess,
        }
      : {
          actor: { type: 'agent' as const, id: identity.tokenId, name: identity.name },
          role: 'agent' as const,
          scopes: identity.scopes,
          workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
          space_access: spaceAccess,
        };

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store', ...result.headers },
  });
}
