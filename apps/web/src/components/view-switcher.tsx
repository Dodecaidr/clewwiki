'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { setThemeAction, setWidthAction } from '@/lib/view/actions';
import { themes } from '@/lib/view/prefs';
import type { Theme, Width } from '@/lib/view/prefs';
import { cn } from '@/lib/utils';

const themeGlyph: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };

const segment = (active: boolean) =>
  cn(
    'px-2 py-1 font-medium transition-colors disabled:opacity-60',
    active
      ? 'bg-secondary text-foreground'
      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
  );

/**
 * Theme (system / light / dark) and page width (wide / narrow). Each choice is
 * written to a cookie by a server action and the route re-rendered in place,
 * the same way the language switcher works. The theme is also applied to
 * `<html>` at once, so the colours change before the refresh lands.
 */
export function ViewSwitcher({ theme, width }: { theme: Theme; width: Width }) {
  const t = useTranslations('view');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="inline-flex shrink-0 items-center gap-2 text-xs">
      <div
        role="group"
        aria-label={t('themeLabel')}
        className="inline-flex overflow-hidden rounded-(--radius-base) border border-border"
      >
        {themes.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === theme}
            title={t(`theme_${option}`)}
            aria-label={t(`theme_${option}`)}
            disabled={pending}
            onClick={() => {
              if (option === theme) return;
              document.documentElement.dataset.theme = option;
              startTransition(async () => {
                await setThemeAction(option);
                router.refresh();
              });
            }}
            className={segment(option === theme)}
          >
            <span aria-hidden>{themeGlyph[option]}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={width === 'wide'}
        title={width === 'wide' ? t('width_narrow') : t('width_wide')}
        aria-label={width === 'wide' ? t('width_narrow') : t('width_wide')}
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            await setWidthAction(width === 'wide' ? 'narrow' : 'wide');
            router.refresh();
          });
        }}
        className={cn(
          'rounded-(--radius-base) border border-border',
          segment(false),
        )}
      >
        <span aria-hidden>{width === 'wide' ? '→←' : '←→'}</span>
      </button>
    </div>
  );
}
