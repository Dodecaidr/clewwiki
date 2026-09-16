import { getRequestConfig } from 'next-intl/server';

/**
 * i18n scaffold. v1 ships English strings only and no locale routing, so every
 * request resolves to `en`. The plumbing exists now so that adding a locale is
 * a matter of adding a message file and a negotiation step, not retrofitting
 * every string in the UI.
 */
export const defaultLocale = 'en';
export const locales = [defaultLocale] as const;

export type Locale = (typeof locales)[number];

export default getRequestConfig(async () => {
  const locale: Locale = defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
