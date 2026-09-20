import 'server-only';

import { and, eq } from 'drizzle-orm';
import { accounts, memberships } from '@clewwiki/db';

import { recordAudit } from '../audit';
import { getDatabase } from '../db';
import { OIDC_PROVIDER_ID, readOidcSettings } from '../oidc';
import { getDefaultWorkspace, getMembershipForUser } from '../workspace';

/**
 * What happens after a provider says who somebody is.
 *
 * Signing in and belonging to the workspace are two different things here, and
 * keeping them apart is what makes single sign-on safe to turn on: the provider
 * decides the first, an administrator decides the second. So this runs once,
 * on the page the provider redirects back to, and does the least it can:
 *
 * - a member already — nothing to do, whatever the provider said;
 * - not a member, and provisioning is off — nothing, and the landing page signs
 *   them out and says so. An account with no membership sees no workspace
 *   (`getSessionContext` returns null), so this is a refusal, not a half-state;
 * - not a member, provisioning is on, and the account really did come from the
 *   provider — a membership with the configured role, audited like any other
 *   way of joining.
 *
 * The third case checks the `account` row rather than trusting the caller:
 * this function must never be the thing that hands a membership to somebody who
 * signed in with a password and was removed from the workspace ten minutes ago.
 */
export type SsoJoin = 'member' | 'provisioned' | 'refused';

export async function ensureOidcMembership(userId: string): Promise<SsoJoin> {
  if (await getMembershipForUser(userId)) return 'member';

  const settings = readOidcSettings();
  if (settings === null || !settings.signUp) return 'refused';

  const db = getDatabase();
  const [linked] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, OIDC_PROVIDER_ID)))
    .limit(1);
  if (!linked) return 'refused';

  const workspace = await getDefaultWorkspace();
  if (!workspace) return 'refused';

  try {
    await db.transaction(async (tx) => {
      await tx.insert(memberships).values({ workspaceId: workspace.id, userId, role: settings.signUpRole });
      await recordAudit(
        {
          workspaceId: workspace.id,
          actorType: 'user',
          actorId: userId,
          action: 'member.joined',
          target: userId,
          metadata: { role: settings.signUpRole, via: 'oidc' },
        },
        tx,
      );
    });
  } catch (error) {
    // Two sign-ins at once: the unique index on (workspace, user) means one of
    // them lost, and the winner's membership is the answer for both.
    if (await getMembershipForUser(userId)) return 'member';
    console.error('[sso] a provisioned membership could not be written', error);
    return 'refused';
  }
  return 'provisioned';
}
