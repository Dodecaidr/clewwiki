import 'server-only';

import { getDatabase, getDatabaseHandle } from '@clewwiki/db';
import type { Database } from '@clewwiki/db';

export { getDatabase, getDatabaseHandle };
export type { Database } from '@clewwiki/db';

/** The handle Drizzle hands to a `db.transaction(...)` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything that can run a statement: the pool, or a transaction.
 *
 * Service functions take this rather than a `Database` so that a caller can
 * pull a read or an audit insert into a transaction it already owns — which is
 * how a write and the audit row describing it end up committing together.
 */
export type DbExecutor = Database | Transaction;
