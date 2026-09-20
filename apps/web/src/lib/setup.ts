import 'server-only';

import { eq } from 'drizzle-orm';
import { memberships, users, withAdvisoryLock, workspaces } from '@clewwiki/db';

import { auth } from './auth';
import { recordAudit } from './audit';
import { getDatabaseHandle } from './db';
import { clearSetupToken, verifySetupToken } from './setup-token';
import { DEFAULT_WORKSPACE_SLUG, hasAnyUser } from './workspace';

export type SetupOutcome =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; error: 'generic' | 'alreadyDone' | 'setupToken' };

export interface SetupInput {
  setupToken: string | null | undefined;
  workspaceName: string;
  name: string;
  email: string;
  password: string;
}

/**
 * Advisory lock key for first-run setup. Any constant works as long as it is
 * stable across processes; this one is arbitrary and unique to this routine.
 */
const SETUP_LOCK_KEY = 0x63_6c_65_77;

/**
 * Creates the administrator account and the single workspace.
 *
 * Three guards, in order:
 *
 * 1. The one-time setup token (`lib/setup-token.ts`), compared in constant
 *    time. Without it, whoever reaches a fresh instance first would become its
 *    administrator.
 * 2. A Postgres advisory lock around the whole routine, so two simultaneous
 *    first visits cannot both pass the "no users yet" check: the second one
 *    blocks, then sees the account the first one created and stops.
 * 3. The account, its membership and the audit row either all exist afterwards
 *    or none do. The account is created by the authentication library, which
 *    owns its own write; the membership and the audit row are written in one
 *    transaction after it, and if that transaction fails the account is
 *    deleted again before the lock is released. An account with no membership
 *    would close `/setup` and leave no administrator — a lockout only SQL could
 *    undo.
 *
 * No account is ever seeded by a migration or fixture — this is the only way
 * an account comes into existence on a fresh instance. Every later one comes
 * from an invitation; see `lib/members/service.ts`.
 */
export async function completeSetup(input: SetupInput): Promise<SetupOutcome> {
  // Checked before the lock and before the "already done" answer, so a caller
  // without the token learns nothing about the instance's state.
  if (!verifySetupToken(input.setupToken)) {
    return { ok: false, error: 'setupToken' };
  }

  const { db, sql } = getDatabaseHandle();

  const outcome = await withAdvisoryLock(sql, SETUP_LOCK_KEY, async (): Promise<SetupOutcome> => {
    if (await hasAnyUser()) {
      return { ok: false, error: 'alreadyDone' };
    }

    const signUp = await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
    });
    if (!signUp?.user) {
      return { ok: false, error: 'generic' };
    }
    const userId = signUp.user.id;

    try {
      const workspaceId = await db.transaction(async (tx) => {
        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: input.workspaceName, slug: DEFAULT_WORKSPACE_SLUG })
          .onConflictDoUpdate({ target: workspaces.slug, set: { name: input.workspaceName } })
          .returning();
        if (!workspace) throw new Error('The workspace could not be created');

        await tx.insert(memberships).values({ workspaceId: workspace.id, userId, role: 'admin' });

        await recordAudit(
          {
            workspaceId: workspace.id,
            actorType: 'user',
            actorId: userId,
            action: 'workspace.initialized',
            target: workspace.id,
            metadata: { workspaceName: workspace.name },
          },
          tx,
        );
        return workspace.id;
      });
      return { ok: true, userId, workspaceId };
    } catch (error) {
      console.error('[setup] setup failed after the account was created; removing it', error);
      // Sessions and credentials cascade from the user row.
      await db.delete(users).where(eq(users.id, userId));
      return { ok: false, error: 'generic' };
    }
  });

  if (outcome.ok) clearSetupToken();
  return outcome;
}
