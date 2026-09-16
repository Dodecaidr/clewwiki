import 'server-only';

import { auditLog } from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

import { getDatabase } from './db';

export type AuditActorType = 'user' | 'agent';

export interface AuditEntry {
  workspaceId: string;
  actorType: AuditActorType;
  actorId: string;
  /** Dotted verb, e.g. `token.issued`, `api.request`, `auth.rejected`. */
  action: string;
  /** What the action was aimed at: a route, a token id, a page id. */
  target?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends an audit row.
 *
 * Pass `tx` to make the row part of a caller-owned transaction; that is how a
 * write and its audit record end up committing or failing together. Without
 * `tx` the row is written on its own connection, which is the right shape for
 * authentication outcomes, where there is no surrounding write to join.
 */
export async function recordAudit(entry: AuditEntry, tx?: Database): Promise<void> {
  const db = tx ?? getDatabase();
  await db.insert(auditLog).values({
    workspaceId: entry.workspaceId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    target: entry.target ?? null,
    metadata: entry.metadata ?? null,
  });
}
