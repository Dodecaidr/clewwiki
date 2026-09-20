import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { auth } from '@/lib/auth';
import { ensureOidcMembership } from '@/lib/members/sso';

/**
 * Where the provider sends somebody back to.
 *
 * Signing in at the provider says who they are; it does not say they belong
 * here. This page is where the second question is answered, once, before
 * anything of the workspace is rendered: a member goes to the wiki, and
 * somebody the provider vouches for who has no membership is signed out again
 * and told so on the sign-in page. Leaving them signed in with no membership
 * would be a session that renders nothing, on every page, for ever.
 */
export const dynamic = 'force-dynamic';

export default async function SsoLandingPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect('/login?sso=failed');

  const outcome = await ensureOidcMembership(session.user.id);
  if (outcome === 'refused') {
    await auth.api.signOut({ headers: await headers() });
    redirect('/login?sso=denied');
  }
  redirect('/');
}
