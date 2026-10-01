import 'server-only';

import { cookies } from 'next/headers';

import { ORG_COOKIE } from '../workspace';

/**
 * Remembers which organization the reader works in. It selects among their own
 * memberships only — `getActiveMembership` checks it on every request — so it
 * is a preference, not a credential.
 */
export async function rememberOrganization(workspaceId: string): Promise<void> {
  (await cookies()).set(ORG_COOKIE, workspaceId, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: true,
  });
}
