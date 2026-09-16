import 'server-only';

import { and, desc, eq, gte } from 'drizzle-orm';
import { auditLog } from '@clewwiki/db';
import type { AuditLogRow } from '@clewwiki/db';

import { getDatabase } from './db';
import type { DbExecutor } from './db';

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
export async function recordAudit(entry: AuditEntry, tx?: DbExecutor): Promise<void> {
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

export interface ListAuditOptions {
  action?: string;
  target?: string;
  since?: Date;
  limit?: number;
}

/**
 * Reads the log back, newest first, scoped to one workspace.
 *
 * The filters are the ones an investigation actually starts from: what happened
 * (`action`), to what (`target`), and since when. Everything is bounded by
 * `limit` so a long-lived instance cannot be pulled through one request.
 */
export async function listAuditEntries(
  workspaceId: string,
  options: ListAuditOptions = {},
): Promise<AuditLogRow[]> {
  const db = getDatabase();
  const filters = [eq(auditLog.workspaceId, workspaceId)];

  if (options.action) filters.push(eq(auditLog.action, options.action));
  if (options.target) filters.push(eq(auditLog.target, options.target));
  if (options.since) filters.push(gte(auditLog.createdAt, options.since));

  return db
    .select()
    .from(auditLog)
    .where(and(...filters))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
}
