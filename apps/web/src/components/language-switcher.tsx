'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { setLocaleAction } from '@/i18n/actions';
import { locales } from '@/i18n/locale';
import { cn } from '@/lib/utils';

/**
 * EN / RU toggle. The choice is stored in a cookie by a server action and the
 * current route is re-rendered in place, so the address never changes.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations('language');
  const current = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div
      role="group"
      aria-label={t('label')}
      className={cn(
        'inline-flex shrink-0 overflow-hidden rounded-(--radius-base) border border-border text-xs',
        className,
      )}
    >
      {locales.map((locale) => {
        const active = locale === current;
        return (
          <button
            key={locale}
            type="button"
            lang={locale}
            aria-pressed={active}
            title={t(locale)}
            disabled={pending}
            onClick={() => {
              if (active) return;
              startTransition(async () => {
                await setLocaleAction(locale);
                router.refresh();
              });
            }}
            className={cn(
              'px-2 py-1 font-medium uppercase transition-colors disabled:opacity-60',
              active
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {locale}
          </button>
        );
      })}
    </div>
  );
}
