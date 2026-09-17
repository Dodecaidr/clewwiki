import 'server-only';

import { NextResponse } from 'next/server';
import type { MembershipRole, Workspace } from '@clewwiki/db';

import { extractBearerToken } from './agent-token-crypto';
import { lookupAgentToken, touchAgentToken } from './agent-tokens';
import { auth } from './auth';
import { recordAudit } from './audit';
import { getAuditSampler } from './audit-sampler';
import { checkSessionMutation } from './csrf';
import { getAgentRateLimitMax, getAgentRateLimitWindowSeconds, getAuthBaseUrl } from './env';
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
  /**
   * Always `null` for a person: accounts reach every space of their workspace,
   * and their role, not a space list, is what governs what they may do.
   */
  spaceIds: null;
}

export interface AgentIdentity {
  type: 'agent';
  tokenId: string;
  name: string;
  scopes: AgentScope[];
  workspaceId: string;
  workspace: Workspace;
  /**
   * The spaces the token is limited to, or `null` for every space in the
   * workspace. Enforced by the handlers next to the workspace check: a page in
   * a space outside the list answers `404`, exactly like a page in another
   * workspace.
   */
  spaceIds: string[] | null;
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
  // Before the session is even read: a forged cross-site request should learn
  // nothing, not even whether the cookie it borrowed is valid.
  const csrf = checkSessionMutation(request, getAuthBaseUrl());
  if (!csrf.ok) {
    return { ok: false, response: errorResponse(403, 'forbidden', csrf.message) };
  }

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
      spaceIds: null,
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
    // Coalesced to one row per token per window, with the count of the rest:
    // the burst is the signal, and it must not become a write load of its own.
    if (lookup.record) {
      const sample = getAuditSampler().sample(`auth.rejected:${lookup.record.id}`);
      if (sample.write) {
        await recordAudit({
          workspaceId: lookup.record.workspaceId,
          actorType: 'agent',
          actorId: lookup.record.id,
          action: 'auth.rejected',
          target: route,
          metadata: { reason: lookup.reason, method: request.method, suppressed: sample.suppressed },
        });
      }
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
    // The limiter protects the handlers; sampling protects the audit table.
    // One row per token per window, carrying how many refusals it stands for.
    const sample = getAuditSampler().sample(`auth.rate_limited:${lookup.record.id}`);
    if (sample.write) {
      await recordAudit({
        workspaceId: lookup.record.workspaceId,
        actorType: 'agent',
        actorId: lookup.record.id,
        action: 'auth.rate_limited',
        target: route,
        metadata: { method: request.method, limit: decision.limit, suppressed: sample.suppressed },
      });
    }
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
      spaceIds: lookup.spaceIds,
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

/** True when the caller may reach resources in the space `spaceId`. */
export function canSeeSpace(identity: ApiIdentity, spaceId: string): boolean {
  return identity.spaceIds === null || identity.spaceIds.includes(spaceId);
}

/**
 * Explicit space-scoping gate, the companion of `requireWorkspace`. Handlers
 * call it with the space of the page (or of the page behind a claim or an
 * anchor) they are about to touch. A token limited to other spaces is answered
 * `404`, not `403`, for the same reason: the response must not confirm that the
 * resource exists somewhere the caller cannot see.
 */
export function requireSpace(identity: ApiIdentity, resourceSpaceId: string): NextResponse | null {
  if (canSeeSpace(identity, resourceSpaceId)) return null;
  return errorResponse(404, 'not_found', 'Resource not found');
}
