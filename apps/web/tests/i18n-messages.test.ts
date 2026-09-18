import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import ru from '../messages/ru.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out.set(path, value);
    } else {
      for (const [nested, text] of flatten(value, path)) out.set(nested, text);
    }
  }
  return out;
}

const catalogs = { en: flatten(en as Tree), ru: flatten(ru as Tree) };

describe('message catalogs', () => {
  it('en and ru have exactly the same keys', () => {
    const enKeys = [...catalogs.en.keys()].sort();
    const ruKeys = [...catalogs.ru.keys()].sort();
    expect(enKeys.filter((key) => !catalogs.ru.has(key))).toEqual([]);
    expect(ruKeys.filter((key) => !catalogs.en.has(key))).toEqual([]);
    expect(ruKeys).toEqual(enKeys);
  });

  it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('%s has no empty strings', (locale) => {
    const empty = [...catalogs[locale].entries()]
      .filter(([, value]) => value.trim() === '')
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])(
    '%s messages are all valid ICU syntax',
    (locale) => {
      const invalid: string[] = [];
      const t = createTranslator({
        locale,
        messages: locale === 'en' ? en : ru,
        onError: (error) => {
          // Missing values and tag handlers are expected here; a message the
          // parser cannot read is not, because it renders as its key.
          if (error.code === 'INVALID_MESSAGE') invalid.push(error.message);
        },
      });
      const translate = t as unknown as { rich: (key: string, values: Record<string, unknown>) => unknown };
      for (const key of catalogs[locale].keys()) {
        translate.rich(key, {});
      }
      expect(invalid).toEqual([]);
    },
  );

  it('keeps the attribution line identical in every locale', () => {
    expect(catalogs.ru.get('common.attribution')).toBe(catalogs.en.get('common.attribution'));
    expect(catalogs.en.get('common.attribution')).toBe(
      'clewwiki — created by Dodecaidr (https://dodecaidr.pro)',
    );
  });
});
