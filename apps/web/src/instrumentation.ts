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

  await announceSetupToken();
  startClaimSweep();
  startDiscussionSweep();
}

/**
 * On an instance with no accounts yet, makes sure the one-time setup token
 * exists and has been printed to the log — so the operator can read it with
 * `docker compose logs web | grep "setup token"` before opening `/setup`.
 *
 * Only when no account exists: a running instance has nothing to set up, and a
 * token printed on every restart would teach operators to ignore the line. A
 * database that cannot be reached here is not fatal; `/setup` generates and
 * prints the token itself when it is first rendered.
 */
async function announceSetupToken(): Promise<void> {
  try {
    const { hasAnyUser } = await import('./lib/workspace');
    if (await hasAnyUser()) return;
    const { getConfiguredSetupToken } = await import('./lib/env');
    if (getConfiguredSetupToken() !== null) {
      console.log('[setup] no account exists yet; /setup requires the value of CLEWWIKI_SETUP_TOKEN');
      return;
    }
    const { ensureSetupToken } = await import('./lib/setup-token');
    ensureSetupToken();
  } catch (error) {
    console.error('[setup] could not check for existing accounts at start-up', error);
  }
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

/**
 * The periodic discussion sweep: the same shape as the claim sweep above, for
 * the same reason.
 *
 * Discussions expire lazily wherever the answer matters — a listing, a thread,
 * the cap on open threads — so this timer changes no decision either. What it
 * does is act on the threads nobody opened: it closes the ones that have gone
 * quiet, deletes the ones whose retention window has run out along with their
 * messages, and leaves the audit rows saying so. It never touches a decision
 * page; that is an ordinary page and outlives the conversation.
 *
 * Five minutes rather than one, because the deadlines are measured in days and
 * a tighter interval would only be polling. Set
 * `DISCUSSION_SWEEP_INTERVAL_SECONDS=0` to turn it off and drive
 * `sweepDiscussions()` some other way. Unref'd so it never keeps the process
 * alive, and failures are logged rather than thrown.
 */
function startDiscussionSweep(): void {
  const raw = process.env.DISCUSSION_SWEEP_INTERVAL_SECONDS;
  const parsed = raw === undefined ? 300 : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return;

  const intervalMs = Math.max(30, parsed) * 1000;

  const timer = setInterval(() => {
    void (async () => {
      try {
        const { sweepDiscussions } = await import('./lib/discussions/service');
        const { closed, deleted } = await sweepDiscussions();
        if (closed > 0 || deleted > 0) {
          console.log(
            `[discussions] sweep closed ${closed} idle discussion(s) and deleted ${deleted}`,
          );
        }
      } catch (error) {
        console.error('[discussions] sweep failed', error);
      }
    })();
  }, intervalMs);

  timer.unref?.();
}
