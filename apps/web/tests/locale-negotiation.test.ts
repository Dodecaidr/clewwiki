import { describe, expect, it } from 'vitest';

import { defaultLocale, negotiateLocale } from '@/i18n/locale';

describe('negotiateLocale', () => {
  it('defaults to English with nothing to go on', () => {
    expect(negotiateLocale({})).toBe('en');
    expect(defaultLocale).toBe('en');
  });

  it('lets the cookie win over Accept-Language', () => {
    expect(negotiateLocale({ cookie: 'en', acceptLanguage: 'ru-RU,ru;q=0.9' })).toBe('en');
    expect(negotiateLocale({ cookie: 'ru', acceptLanguage: 'en-US,en;q=0.9' })).toBe('ru');
  });

  it('ignores a cookie that names a locale this instance does not ship', () => {
    expect(negotiateLocale({ cookie: 'de', acceptLanguage: 'ru' })).toBe('ru');
    expect(negotiateLocale({ cookie: '<script>', acceptLanguage: null })).toBe('en');
  });

  it('picks Russian from Accept-Language', () => {
    expect(negotiateLocale({ acceptLanguage: 'ru' })).toBe('ru');
    expect(negotiateLocale({ acceptLanguage: 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' })).toBe('ru');
  });

  it('respects quality values and falls through unsupported languages', () => {
    expect(negotiateLocale({ acceptLanguage: 'en;q=0.5, ru;q=0.8' })).toBe('ru');
    expect(negotiateLocale({ acceptLanguage: 'de-DE, ru;q=0.5' })).toBe('ru');
    expect(negotiateLocale({ acceptLanguage: 'ru;q=0, en' })).toBe('en');
  });

  it('falls back to English for other languages and garbage', () => {
    expect(negotiateLocale({ acceptLanguage: 'fr-FR,de;q=0.9' })).toBe('en');
    expect(negotiateLocale({ acceptLanguage: '*' })).toBe('en');
    expect(negotiateLocale({ acceptLanguage: ';;,,' })).toBe('en');
  });
});
