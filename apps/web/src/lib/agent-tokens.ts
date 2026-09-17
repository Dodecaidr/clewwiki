import 'server-only';

import { and, desc, eq, isNull } from 'drizzle-orm';
import { agentTokens } from '@clewwiki/db';
import type { AgentToken } from '@clewwiki/db';

import {
  classifyTokenLifecycle,
  generateAgentToken,
  parseAgentToken,
  verifyTokenSecret,
} from './agent-token-crypto';
import { getDatabase } from './db';
import { normalizeScopes } from './scopes';
import type { AgentScope } from './scopes';

export interface IssueAgentTokenInput {
  workspaceId: string;
  name: string;
  scopes: readonly string[];
  /** Days until the token expires. Omit for a non-expiring token. */
  expiresInDays?: number | null;
  /**
   * The spaces the token may reach. `null` or omitted means every space. The
   * caller is responsible for having checked that the ids belong to the
   * workspace; `issueAgentToken` stores what it is given, de-duplicated.
   */
  spaceIds?: readonly string[] | null;
  createdBy: string;
}

export interface IssuedAgentToken {
  record: AgentToken;
  /** Shown to the operator once and never stored. */
  token: string;
}

export async function issueAgentToken(input: IssueAgentTokenInput): Promise<IssuedAgentToken> {
  const db = getDatabase();
  const generated = generateAgentToken();
  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  const [record] = await db
    .insert(agentTokens)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      prefix: generated.prefix,
      tokenHash: generated.tokenHash,
      scopes: normalizeScopes(input.scopes),
      spaceIds: input.spaceIds ? [...new Set(input.spaceIds)] : null,
      expiresAt,
      createdBy: input.createdBy,
    })
    .returning();

  if (!record) {
    throw new Error('Failed to persist agent token');
  }

  return { record, token: generated.token };
}

export async function listAgentTokens(workspaceId: string): Promise<AgentToken[]> {
  const db = getDatabase();
  return db
    .select()
    .from(agentTokens)
    .where(eq(agentTokens.workspaceId, workspaceId))
    .orderBy(desc(agentTokens.createdAt));
}

/**
 * Revokes a token. The workspace id is part of the WHERE clause rather than
 * checked afterwards, so an admin of one workspace cannot revoke another
 * workspace's token even by guessing its id.
 */
export async function revokeAgentToken(workspaceId: string, tokenId: string): Promise<boolean> {
  const db = getDatabase();
  const rows = await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentTokens.id, tokenId),
        eq(agentTokens.workspaceId, workspaceId),
        isNull(agentTokens.revokedAt),
      ),
    )
    .returning({ id: agentTokens.id });
  return rows.length > 0;
}

export type AgentTokenRejection = 'malformed' | 'unknown' | 'invalid' | 'revoked' | 'expired';

export type AgentTokenLookup =
  | { ok: true; record: AgentToken; scopes: AgentScope[]; spaceIds: string[] | null }
  | { ok: false; reason: AgentTokenRejection; record?: AgentToken };

/**
 * Resolves a presented bearer token.
 *
 * Lookup happens on the non-secret prefix; the secret itself is only ever
 * compared as a SHA-256 digest, in constant time. Lifecycle (revoked, expired)
 * is decided here, before any handler logic runs, which is what makes
 * revocation and TTL authentication-layer controls rather than write-time ones.
 */
export async function lookupAgentToken(presented: string): Promise<AgentTokenLookup> {
  const parsed = parseAgentToken(presented);
  if (!parsed) {
    return { ok: false, reason: 'malformed' };
  }

  const db = getDatabase();
  const [record] = await db
    .select()
    .from(agentTokens)
    .where(eq(agentTokens.prefix, parsed.prefix))
    .limit(1);

  if (!record) {
    return { ok: false, reason: 'unknown' };
  }

  if (!verifyTokenSecret(parsed.secret, record.tokenHash)) {
    return { ok: false, reason: 'invalid' };
  }

  const lifecycle = classifyTokenLifecycle(record);
  if (lifecycle !== 'active') {
    return { ok: false, reason: lifecycle, record };
  }

  return {
    ok: true,
    record,
    scopes: normalizeScopes(record.scopes),
    spaceIds: normalizeSpaceIds(record.spaceIds),
  };
}

/**
 * Reads the stored space restriction defensively. It is a JSON column, so a
 * row written by hand could hold anything; anything that is not a list of
 * strings is read as the narrowest thing it could mean — no spaces at all —
 * rather than widened to every space.
 */
export function normalizeSpaceIds(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))];
}

export async function touchAgentToken(tokenId: string): Promise<void> {
  const db = getDatabase();
  await db.update(agentTokens).set({ lastUsedAt: new Date() }).where(eq(agentTokens.id, tokenId));
}
