/**
 * Locale vocabulary and negotiation.
 *
 * There is no locale segment in the URL: a page has one address whatever
 * language it is read in, so links pasted between people who read it in
 * different languages keep working. The locale comes from a cookie the
 * language switcher sets, and before anyone has chosen, from the browser's
 * `Accept-Language` header.
 *
 * This module is plain TypeScript with no Next.js imports, so the negotiation
 * rules can be tested without a request.
 */

export const locales = ['en', 'ru'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

/** The cookie the language switcher writes. The name next-intl uses too. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

interface LanguageRange {
  primary: string;
  quality: number;
  order: number;
}

function parseAcceptLanguage(header: string): LanguageRange[] {
  const ranges: LanguageRange[] = [];
  header.split(',').forEach((part, order) => {
    const [tag, ...params] = part.trim().split(';');
    if (!tag) return;
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q' && value !== undefined) {
        const parsed = Number.parseFloat(value);
        quality = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (quality <= 0) return;
    const primary = tag.trim().toLowerCase().split('-')[0] ?? '';
    if (primary === '') return;
    ranges.push({ primary, quality, order });
  });
  // Highest quality first; equal qualities keep the order the browser sent.
  return ranges.sort((a, b) => b.quality - a.quality || a.order - b.order);
}

/**
 * Picks the locale for a request.
 *
 * An explicit choice (the cookie) always wins. Otherwise the most preferred
 * language in `Accept-Language` that this instance ships decides, and anything
 * else falls back to English.
 */
export function negotiateLocale(input: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  if (input.acceptLanguage) {
    for (const range of parseAcceptLanguage(input.acceptLanguage)) {
      if (isLocale(range.primary)) return range.primary;
    }
  }
  return defaultLocale;
}
