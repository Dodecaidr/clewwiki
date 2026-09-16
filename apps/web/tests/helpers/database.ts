import { sql } from 'drizzle-orm';

/**
 * Integration tests need a real PostgreSQL instance, because the behaviour
 * under test — token lookup, revocation, expiry, workspace scoping — lives in
 * SQL predicates as much as in TypeScript.
 *
 * Point `TEST_DATABASE_URL` (or `DATABASE_URL`) at a throwaway database and the
 * suite runs; leave it unset, or point it at something unreachable, and the
 * suite skips with a message instead of failing, so a checkout with no database
 * still produces a green `pnpm test`.
 *
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://clewwiki:clewwiki@localhost:5432/clewwiki pnpm test
 */

export const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

export interface DatabaseProbe {
  reachable: boolean;
  reason?: string;
}

/** Checks that the configured database answers, and applies migrations. */
export async function prepareTestDatabase(): Promise<DatabaseProbe> {
  if (!databaseUrl) {
    return { reachable: false, reason: 'TEST_DATABASE_URL / DATABASE_URL is not set' };
  }

  const { createDatabase, runMigrations } = await import('@clewwiki/db');

  const handle = createDatabase(databaseUrl, { max: 1 });
  try {
    await handle.db.execute(sql`select 1`);
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle.sql.end({ timeout: 5 });
  }

  try {
    await runMigrations(databaseUrl);
    return { reachable: true };
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
