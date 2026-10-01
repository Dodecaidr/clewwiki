import Link from 'next/link';
import { eq, sql } from 'drizzle-orm';
import { users } from '@clewwiki/db';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';

import { Alert, Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getDatabase } from '@/lib/db';
import { findOpenInvitation } from '@/lib/members/service';
import { getSignedInUser } from '@/lib/session';
import { getWorkspaceById } from '@/lib/workspace';

import { acceptAsMemberAction } from './actions';
import { JoinForm } from './join-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('join');
  // The link is a secret: it must not be kept by a search engine or sent on as a referrer.
  return { title: t('title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

async function accountExists(email: string): Promise<boolean> {
  const [row] = await getDatabase()
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  return row !== undefined;
}

export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ failed?: string }>;
}) {
  const t = await getTranslations('join');
  const { token } = await params;
  const { failed } = await searchParams;
  const invitation = await findOpenInvitation(decodeURIComponent(token));
  const workspace = invitation ? await getWorkspaceById(invitation.workspaceId) : null;
  const user = invitation ? await getSignedInUser() : null;
  // The invited address already has an account here — the person is in
  // another organization — so they join with it rather than making a second.
  const existing = invitation ? await accountExists(invitation.email) : false;

  return (
    <div className="mx-auto grid w-full max-w-md gap-6">
      {invitation && workspace ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('heading', { workspace: workspace.name })}</CardTitle>
            <CardDescription>{t(`intro_${invitation.role}`)}</CardDescription>
          </CardHeader>
          <CardBody className="grid gap-4 text-sm">
            {failed ? <Alert tone="error">{t('error_invalidInvitation')}</Alert> : null}
            {user && user.email.toLowerCase() === invitation.email ? (
              <form action={acceptAsMemberAction} className="grid gap-3">
                <input type="hidden" name="token" value={token} />
                <p>{t('existingSignedIn', { email: invitation.email })}</p>
                <div>
                  <Button type="submit">{t('joinExisting', { workspace: workspace.name })}</Button>
                </div>
              </form>
            ) : user ? (
              <Alert tone="error">{t('wrongAccount', { signedIn: user.email, invited: invitation.email })}</Alert>
            ) : existing ? (
              <p>
                {t('existingSignIn', { email: invitation.email })}{' '}
                <Link href={`/login?next=${encodeURIComponent(`/join/${token}`)}`} className="underline underline-offset-2">
                  {t('signInToJoin')}
                </Link>
              </p>
            ) : (
              <JoinForm token={token} email={invitation.email} />
            )}
          </CardBody>
        </Card>
      ) : (
        <Alert tone="error">{t('invalid')}</Alert>
      )}
    </div>
  );
}
