import 'server-only';

import { NextResponse } from 'next/server';
import type { MembershipRole, Workspace } from '@clewwiki/db';

import { extractBearerToken } from './agent-token-crypto';
import { lookupAgentToken, touchAgentToken } from './agent-tokens';
import { auth } from './auth';
import { recordAudit } from './audit';
import { getAgentRateLimitMax, getAgentRateLimitWindowSeconds } from './env';
import { TokenBucketRateLimiter } from './rate-limit';
import { hasAllScopes } from './scopes';
import type { AgentScope } from './scopes';
import { getMembershipForUser, getWorkspaceById } from './workspace';

export interface UserIdentity {
  type: 'user';
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
  workspaceId: string;
  workspace: Workspace;
}

export interface AgentIdentity {
  type: 'agent';
  tokenId: string;
  name: string;
  scopes: AgentScope[];
  workspaceId: string;
  workspace: Workspace;
}

export type ApiIdentity = UserIdentity | AgentIdentity;

export type AuthResult =
  | {
      ok: true;
      identity: ApiIdentity;
      /**
       * Rate-limit headers for the caller to attach to its response. Present
       * for agent tokens so a well-behaved client can slow down before it is
       * turned away rather than after.
       */
      headers?: Record<string, string>;
    }
  | { ok: false; response: NextResponse };

declare global {
  var __clewwikiAgentRateLimiter: TokenBucketRateLimiter | undefined;
}

function getRateLimiter(): TokenBucketRateLimiter {
  globalThis.__clewwikiAgentRateLimiter ??= new TokenBucketRateLimiter(
    getAgentRateLimitMax(),
    getAgentRateLimitWindowSeconds(),
  );
  return globalThis.__clewwikiAgentRateLimiter;
}

function errorResponse(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

const UNAUTHORIZED_HEADERS = { 'WWW-Authenticate': 'Bearer realm="clewwiki"' } as const;

/**
 * Resolves the caller of a REST request: either a browser session or an agent
 * bearer token. A request carrying an `Authorization: Bearer` header is only
 * ever evaluated as a token — it never silently falls back to a session cookie,
 * which would let a rejected token borrow the browser's identity.
 */
export async function authenticateRequest(request: Request): Promise<AuthResult> {
  const bearer = extractBearerToken(request.headers.get('authorization'));
  if (bearer !== null) {
    return authenticateAgent(request, bearer);
  }
  return authenticateSession(request);
}

async function authenticateSession(request: Request): Promise<AuthResult> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return {
      ok: false,
      response: errorResponse(401, 'unauthenticated', 'Authentication required', UNAUTHORIZED_HEADERS),
    };
  }

  const membership = await getMembershipForUser(session.user.id);
  if (!membership) {
    return {
      ok: false,
      response: errorResponse(403, 'no_workspace', 'Account is not a member of any workspace'),
    };
  }

  const workspace = await getWorkspaceById(membership.workspaceId);
  if (!workspace) {
    return {
      ok: false,
      response: errorResponse(403, 'no_workspace', 'Account is not a member of any workspace'),
    };
  }

  return {
    ok: true,
    identity: {
      type: 'user',
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: membership.role,
      workspaceId: workspace.id,
      workspace,
    },
  };
}

async function authenticateAgent(request: Request, presented: string): Promise<AuthResult> {
  const route = new URL(request.url).pathname;
  const lookup = await lookupAgentToken(presented);

  if (!lookup.ok) {
    // A token we can identify gets an audit row even though it was rejected:
    // a burst of calls from a revoked token is exactly the signal the log
    // exists for. An unrecognised token has no workspace to attribute.
    if (lookup.record) {
      await recordAudit({
        workspaceId: lookup.record.workspaceId,
        actorType: 'agent',
        actorId: lookup.record.id,
        action: 'auth.rejected',
        target: route,
        metadata: { reason: lookup.reason, method: request.method },
      });
    }
    return {
      ok: false,
      response: errorResponse(401, 'invalid_token', 'Invalid or expired token', UNAUTHORIZED_HEADERS),
    };
  }

  const decision = getRateLimiter().consume(lookup.record.id);
  const rateHeaders: Record<string, string> = {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(decision.resetAfterSeconds),
  };

  if (!decision.allowed) {
    await recordAudit({
      workspaceId: lookup.record.workspaceId,
      actorType: 'agent',
      actorId: lookup.record.id,
      action: 'auth.rate_limited',
      target: route,
      metadata: { method: request.method, limit: decision.limit },
    });
    return {
      ok: false,
      response: errorResponse(429, 'rate_limited', 'Rate limit exceeded', {
        ...rateHeaders,
        'Retry-After': String(decision.resetAfterSeconds),
      }),
    };
  }

  const workspace = await getWorkspaceById(lookup.record.workspaceId);
  if (!workspace) {
    return {
      ok: false,
      response: errorResponse(403, 'no_workspace', 'Token workspace no longer exists'),
    };
  }

  await touchAgentToken(lookup.record.id);
  await recordAudit({
    workspaceId: workspace.id,
    actorType: 'agent',
    actorId: lookup.record.id,
    action: 'api.request',
    target: route,
    metadata: { method: request.method, tokenName: lookup.record.name },
  });

  return {
    ok: true,
    headers: rateHeaders,
    identity: {
      type: 'agent',
      tokenId: lookup.record.id,
      name: lookup.record.name,
      scopes: lookup.scopes,
      workspaceId: workspace.id,
      workspace,
    },
  };
}

/**
 * Scope gate for agent callers. Human sessions are governed by their
 * membership role instead, so they pass through.
 */
export function requireScopes(
  identity: ApiIdentity,
  required: readonly string[],
): NextResponse | null {
  if (identity.type === 'user') return null;
  if (hasAllScopes(identity.scopes, required)) return null;
  return errorResponse(403, 'insufficient_scope', `Token is missing scope: ${required.join(', ')}`);
}

/**
 * Explicit workspace-scoping gate. Handlers call this with the workspace of the
 * resource they are about to touch. A mismatch answers 404, not 403, so the
 * response does not confirm that the resource exists elsewhere.
 */
export function requireWorkspace(
  identity: ApiIdentity,
  resourceWorkspaceId: string,
): NextResponse | null {
  if (identity.workspaceId === resourceWorkspaceId) return null;
  return errorResponse(404, 'not_found', 'Resource not found');
}
