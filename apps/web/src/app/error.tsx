'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary. It deliberately shows no message from the thrown
 * error: an error raised while talking to the database can carry a connection
 * string, and this page is reachable by an unauthenticated visitor.
 */
export default function RouteError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('errors');

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t('genericTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('genericBody')}</p>
      <div>
        <Button onClick={reset} variant="outline">
          {t('retry')}
        </Button>
      </div>
    </div>
  );
}
