import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { LOCALE_COOKIE, negotiateLocale } from './locale';

/**
 * Resolves the locale for every request without a locale segment in the URL:
 * the `NEXT_LOCALE` cookie when the reader picked a language, else the
 * browser's `Accept-Language`, else English.
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const locale = negotiateLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get('accept-language'),
  });

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
