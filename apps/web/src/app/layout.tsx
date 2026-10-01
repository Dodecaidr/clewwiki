import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { shellWidthClass } from '@/lib/view/prefs';
import { getViewPrefs } from '@/lib/view/server';

import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return {
    title: {
      default: 'clewwiki',
      template: '%s — clewwiki',
    },
    description: t('description'),
    // A self-hosted instance is not public content; keep it out of indexes even
    // when an operator exposes it to the internet.
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const view = await getViewPrefs();
  const shell = shellWidthClass(view.width);

  return (
    <html lang={locale} data-theme={view.theme}>
      <body className="flex min-h-dvh flex-col">
        <NextIntlClientProvider>
          <SiteHeader view={view} />
          <main className={`mx-auto w-full ${shell} flex-1 px-6 py-10`}>{children}</main>
          <SiteFooter shellClass={shell} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
