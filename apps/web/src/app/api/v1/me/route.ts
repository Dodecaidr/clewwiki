import { NextResponse } from 'next/server';

import { authenticateRequest, requireScopes, requireWorkspace } from '@/lib/api-auth';
import { getWorkspaceById } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * Identity of the caller: which principal, what it is allowed to do, and which
 * workspace it is bound to. Accepts either a browser session or an agent
 * bearer token.
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
        }
      : {
          actor: { type: 'agent' as const, id: identity.tokenId, name: identity.name },
          role: 'agent' as const,
          scopes: identity.scopes,
          workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        };

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store', ...result.headers },
  });
}
