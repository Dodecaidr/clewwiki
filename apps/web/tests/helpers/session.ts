import { randomBytes } from 'node:crypto';

import type { Database } from '@clewwiki/db';
import type * as ClewwikiDb from '@clewwiki/db';

export interface TestAccount {
  userId: string;
  email: string;
  password: string;
  /** A `Cookie` header value carrying the account's session. */
  cookie: string;
}

/**
 * Creates a human account with a membership and a live session, the way first-
 * run setup does: through the authentication library's server-side API, never
 * through the (disabled) HTTP sign-up route.
 */
export async function createTestAccount(options: {
  db: Database;
  schema: typeof ClewwikiDb;
  workspaceId: string;
  role: 'admin' | 'editor' | 'viewer';
  tag: string;
}): Promise<TestAccount> {
  const { auth } = await import('@/lib/auth');
  const email = `${options.tag}-${options.role}-${randomBytes(3).toString('hex')}@example.test`;
  const password = randomBytes(18).toString('base64url');

  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password, name: `${options.role} ${options.tag}` },
    returnHeaders: true,
  });
  const userId = response.user.id;
  const setCookie = headers.get('set-cookie') ?? '';
  const match = /(better-auth\.session_token=[^;,\s]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error(`sign-up returned no session cookie: ${setCookie}`);

  await options.db
    .insert(options.schema.memberships)
    .values({ workspaceId: options.workspaceId, userId, role: options.role });

  return { userId, email, password, cookie: match[1] };
}
