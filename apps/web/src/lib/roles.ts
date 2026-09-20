import type { MembershipRole } from '@clewwiki/db';

import { DEFAULT_AGENT_SCOPES } from './scopes';

/**
 * What the three roles mean, in one place.
 *
 * - **viewer** reads. Pages, discussions, comments, history, exports, search,
 *   their own inbox and their own account — and nothing that writes.
 * - **editor** reads and writes content.
 * - **admin** also manages members, agent tokens, spaces and their settings.
 *
 * A viewer is to people what a default, read-only token is to agents, and is enforced
 * at the same doors: REST through `requireScopes`, server actions through
 * `getWriterSession`. Being able to *see* a space is a separate question —
 * restricted spaces and their members — and a viewer is asked it like anybody
 * else. Hiding a button is never the control: every write is refused where it
 * is made, and `tests/viewer-role-guard.test.ts` fails when a server action
 * forgets to.
 */

/**
 * The scopes a person's role amounts to over REST. `null` means every scope. A
 * viewer has what a token is issued with by default — who am I, and reading —
 * and the audit log stays with administrators, as it does for everybody.
 */
export function scopesOfRole(role: MembershipRole): readonly string[] | null {
  return role === 'viewer' ? DEFAULT_AGENT_SCOPES : null;
}

export function canWrite(role: MembershipRole): boolean {
  return role !== 'viewer';
}
