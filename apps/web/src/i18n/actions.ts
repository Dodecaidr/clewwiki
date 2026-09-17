'use server';

import { cookies } from 'next/headers';

import { LOCALE_COOKIE, isLocale } from './locale';

/**
 * Remembers the reader's language choice.
 *
 * The cookie holds nothing but `en` or `ru`: anything else is ignored rather
 * than stored, so the value can never carry more than the switcher offers.
 */
export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: true,
  });
}
