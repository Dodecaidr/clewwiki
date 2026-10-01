import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { getAuthBaseUrl } from '@/lib/env';
import { readRegistrationMode } from '@/lib/orgs/access';
import { ORG_COOKIE, getMembership, getWorkspaceBySlug } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

/**
 * An organization's own entrance, `/o/<slug>` — the address its people
 * bookmark. A member is switched to it; anybody else is sent to sign in for
 * it, or to ask to join it when the organization takes requests.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const base = getAuthBaseUrl().replace(/\/+$/, '');
  const workspace = await getWorkspaceBySlug(slug.toLowerCase());
  if (!workspace) return NextResponse.redirect(`${base}/login`, 303);

  const session = await auth.api.getSession({ headers: request.headers });
  if (session?.user && (await getMembership(session.user.id, workspace.id))) {
    const response = NextResponse.redirect(`${base}/`, 303);
    response.cookies.set(ORG_COOKIE, workspace.id, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      httpOnly: true,
    });
    return response;
  }
  if (session?.user && readRegistrationMode(workspace) === 'approval') {
    return NextResponse.redirect(`${base}/o/${workspace.slug}/register`, 303);
  }
  return NextResponse.redirect(`${base}/login?org=${encodeURIComponent(workspace.slug)}`, 303);
}
