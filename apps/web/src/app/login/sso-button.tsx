'use client';

import { useTranslations } from 'next-intl';

import { signInWithSsoAction } from './actions';
import { Button } from '@/components/ui/button';

/**
 * The provider's button, under the password form and separated from it.
 *
 * A form rather than a link, so that leaving for the provider is a POST from
 * this origin — a link would let another site start the round trip on a
 * visitor's behalf.
 */
export function SsoButton({ name }: { name: string }) {
  const t = useTranslations('login');

  return (
    <div className="grid gap-3 border-t border-border pt-4">
      <p className="text-sm text-muted-foreground">{t('ssoIntro')}</p>
      <form action={signInWithSsoAction}>
        <Button type="submit" variant="secondary">
          {t('ssoSubmit', { name })}
        </Button>
      </form>
    </div>
  );
}
