import 'server-only';

import type { NextResponse } from 'next/server';

import { authenticateRequest, requireScopes } from './api-auth';
import type { ApiIdentity } from './api-auth';
import type { PageActor } from './pages/service';

/**
 * The gate every page endpoint passes through: resolve the caller, then check
 * the scope the endpoint needs.
 *
 * Workspace scoping is deliberately *not* done here. It depends on the
 * resource each handler is about to touch, so it stays written out in the
 * handler — in the SQL predicate for a read, and as an explicit comparison for
 * anything read some other way.
 */
export type PagesAuthResult =
  | {
      ok: true;
      identity: ApiIdentity;
      /** Who to record as the author of a write. */
      actor: PageActor;
      workspaceId: string;
      headers: Record<string, string>;
    }
  | { ok: false; response: NextResponse };

export const READ_SCOPES = ['pages:read'] as const;
export const WRITE_SCOPES = ['pages:write'] as const;

export async function authorizePagesRequest(
  request: Request,
  scopes: readonly string[],
): Promise<PagesAuthResult> {
  const auth = await authenticateRequest(request);
  if (!auth.ok) return { ok: false, response: auth.response };

  const scopeError = requireScopes(auth.identity, scopes);
  if (scopeError) return { ok: false, response: scopeError };

  return {
    ok: true,
    identity: auth.identity,
    actor: actorOf(auth.identity),
    workspaceId: auth.identity.workspaceId,
    headers: auth.headers ?? {},
  };
}

/**
 * The audit and authorship identity of a caller. An agent is recorded as its
 * token, not as the human who issued it: the token is what acted, and it is
 * what gets revoked when the row turns out to be wrong.
 */
export function actorOf(identity: ApiIdentity): PageActor {
  return identity.type === 'user'
    ? { type: 'user', id: identity.userId }
    : { type: 'agent', id: identity.tokenId };
}
