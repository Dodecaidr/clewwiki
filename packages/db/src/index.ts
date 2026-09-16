import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import * as schema from './schema';

export * from './schema';
export { schema };

export type SqlClient = ReturnType<typeof postgres>;
export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  db: Database;
  sql: SqlClient;
}

export interface CreateDatabaseOptions {
  /** Maximum number of pooled connections. */
  max?: number;
}

/**
 * Builds a Drizzle client over a fresh connection pool. Callers that want a
 * process-wide singleton should use `getDatabaseHandle()` instead.
 */
export function createDatabase(
  connectionString: string,
  options: CreateDatabaseOptions = {},
): DatabaseHandle {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    // Transaction poolers reject prepared statements; disabling them keeps the
    // app compatible with a pooler placed in front of Postgres.
    prepare: false,
  });
  return { db: drizzle(sql, { schema }), sql };
}

declare global {
  // eslint-disable-next-line no-var
  var __clewwikiDb: DatabaseHandle | undefined;
}

/**
 * Process-wide database singleton. Reusing one pool matters in development,
 * where module reloads would otherwise open a new pool on every edit.
 */
export function getDatabaseHandle(): DatabaseHandle {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  globalThis.__clewwikiDb ??= createDatabase(connectionString);
  return globalThis.__clewwikiDb;
}

export function getDatabase(): Database {
  return getDatabaseHandle().db;
}

/**
 * Absolute path to the generated SQL migrations shipped with this package.
 *
 * The built container bundles the application, so the package's own directory
 * layout no longer exists there; `CLEWWIKI_MIGRATIONS_DIR` lets the image point
 * at the copy of the SQL files it ships instead.
 */
export function resolveMigrationsFolder(override?: string): string {
  const configured = override ?? process.env.CLEWWIKI_MIGRATIONS_DIR;
  if (configured) return configured;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
}

/** Advisory lock key held while migrations run, so replicas do not race. */
const MIGRATION_LOCK_KEY = 0x63_6c_65_78;

/**
 * Applies every pending migration on a dedicated connection, then closes it.
 * Used at container start-up and by the integration test setup, so both reach a
 * schema state through exactly the same path.
 *
 * The advisory lock means several replicas starting at once are safe: the first
 * one migrates while the others wait, then find nothing left to do.
 */
export async function runMigrations(
  connectionString: string,
  migrationsFolder?: string,
): Promise<void> {
  const client = postgres(connectionString, { max: 1, prepare: false });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(drizzle(client), {
        migrationsFolder: resolveMigrationsFolder(migrationsFolder),
      });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await client.end();
  }
}

/**
 * Runs `fn` while holding a session-level Postgres advisory lock on a reserved
 * connection. Concurrent callers block until the holder finishes, which is what
 * makes the otherwise racy "check, then create" first-run setup safe.
 */
export async function withAdvisoryLock<T>(
  sql: SqlClient,
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  const reserved = await sql.reserve();
  try {
    await reserved`select pg_advisory_lock(${key})`;
    try {
      return await fn();
    } finally {
      await reserved`select pg_advisory_unlock(${key})`;
    }
  } finally {
    reserved.release();
  }
}
