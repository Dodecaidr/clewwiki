import 'server-only';

import { eq } from 'drizzle-orm';
import { users } from '@clewwiki/db';

import { getDatabase } from '../db';

/**
 * Marking an account's address as verified, and what that means here.
 *
 * There is no mail transport and no confirmation link, so "verified" cannot
 * mean what it means in a product people sign themselves up to. It means the
 * one thing this instance can actually assert: **an administrator said this
 * address is this person.** That is the only way an account comes into
 * existence — `/setup` for the first one, an invitation for every other, with
 * public sign-up switched off — so the assertion is as strong as the
 * administrator, which is the trust model of the whole workspace anyway.
 *
 * It matters because the authentication library will not link an identity from
 * an OpenID Connect provider into a local row whose address is unverified. That
 * rule exists to stop somebody registering an account at a victim's address and
 * waiting for the victim's first sign-on to land in it. Here nobody can
 * register anything, so what the rule would protect against cannot happen — and
 * without this, single sign-on would refuse every member the administrator
 * invited, which is everybody.
 *
 * Nothing else in the product reads this column.
 */
export async function markEmailVerified(userId: string): Promise<void> {
  await getDatabase().update(users).set({ emailVerified: true }).where(eq(users.id, userId));
}
