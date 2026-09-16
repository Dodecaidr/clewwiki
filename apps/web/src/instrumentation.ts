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

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;

  if (process.env.RUN_MIGRATIONS_ON_START !== 'false') {
    const { runMigrations } = await import('@clewwiki/db');
    await runMigrations(connectionString);
  }

  startClaimSweep();
}

/**
 * The periodic claim sweep.
 *
 * Expiry is already applied lazily wherever the answer matters — claiming,
 * renewing, writing, and the presence board all ignore a lease past its
 * deadline — so this timer changes no decision. What it does is end the leases
 * nobody asked about: it frees the partial unique indexes, deletes notes that
 * should no longer be readable, and records when each lease actually lapsed.
 *
 * A minute is the default interval: short enough that a released target becomes
 * claimable promptly, long enough to be invisible next to ordinary traffic. Set
 * `CLAIM_SWEEP_INTERVAL_SECONDS=0` to turn it off and drive
 * `expireStaleClaims()` some other way. The timer is unref'd so it never keeps
 * the process alive on its own, and failures are logged rather than thrown:
 * a sweep that cannot reach the database must not take the server down with it.
 */
function startClaimSweep(): void {
  const raw = process.env.CLAIM_SWEEP_INTERVAL_SECONDS;
  const parsed = raw === undefined ? 60 : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return;

  const intervalMs = Math.max(10, parsed) * 1000;

  const timer = setInterval(() => {
    void (async () => {
      try {
        const { expireStaleClaims } = await import('./lib/claims/service');
        const { expired } = await expireStaleClaims();
        if (expired > 0) {
          console.log(`[claims] sweep released ${expired} expired claim(s)`);
        }
      } catch (error) {
        console.error('[claims] sweep failed', error);
      }
    })();
  }, intervalMs);

  timer.unref?.();
}
