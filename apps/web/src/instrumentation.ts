/**
 * Runs pending database migrations once, when the server process starts.
 *
 * Doing this in-process rather than from a separate entrypoint command keeps
 * `docker compose up` a single step, and makes the migrator's dependencies part
 * of the traced standalone bundle instead of something the image has to carry
 * a second copy of. Concurrent replicas are serialised by an advisory lock
 * inside `runMigrations`.
 *
 * Set `RUN_MIGRATIONS_ON_START=false` to take the schema into your own hands.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.RUN_MIGRATIONS_ON_START === 'false') return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  const { runMigrations } = await import('@clewwiki/db');
  await runMigrations(connectionString);
}
