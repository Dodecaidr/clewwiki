import { describe, expect, it } from 'vitest';

import { MAX_SEGMENT_LENGTH, SEGMENT_PATTERN, slugifySegment } from '@/lib/pages/paths';
import {
  FALLBACK_SEGMENT_PREFIX,
  generateSegment,
  slugFromTitle,
  transliterate,
  withNumericSuffix,
} from '@/lib/pages/slug';

describe('generateSegment — Cyrillic', () => {
  it('transliterates Russian with the ICAO table', () => {
    expect(generateSegment('Архитектура бэкенда')).toBe('arkhitektura-bekenda');
    expect(generateSegment('Щука, ёж и цапля')).toBe('shchuka-ezh-i-tsaplia');
    expect(generateSegment('Подъезд и объём')).toBe('podieezd-i-obieem');
    expect(generateSegment('Юла, Яма, Хор, Чай, Шум, Жук, Эхо, Мышь')).toBe(
      'iula-iama-khor-chai-shum-zhuk-ekho-mysh',
    );
  });

  it('transliterates the Ukrainian letters є, ї, і and ґ', () => {
    expect(generateSegment('Європа')).toBe('ievropa');
    expect(generateSegment('Їжак і ґанок')).toBe('izhak-i-ganok');
    expect(generateSegment('Київ')).toBe('kiiv');
  });

  it('transliterates the Belarusian ў', () => {
    expect(generateSegment('Ўзор і воўк')).toBe('uzor-i-vouk');
  });

  it('keeps a word with an apostrophe in one piece', () => {
    expect(generateSegment("М'ясо")).toBe('miaso');
    expect(generateSegment('Пам’ять')).toBe('pamiat');
  });

  it('treats й and ё typed as a letter plus a combining mark like the composed letters', () => {
    const decomposed = 'Сергей Ёлкин'.normalize('NFD');
    expect(decomposed).not.toBe('Сергей Ёлкин');
    expect(generateSegment(decomposed)).toBe('sergei-elkin');
  });

  it('matches uppercase and lowercase alike', () => {
    expect(generateSegment('БЭКЕНД')).toBe(generateSegment('бэкенд'));
  });
});

describe('generateSegment — Latin scripts', () => {
  it('strips German and French diacritics', () => {
    expect(generateSegment('Größe über Äpfel')).toBe('grosse-uber-apfel');
    expect(generateSegment('Côté cœur, déjà vu')).toBe('cote-coeur-deja-vu');
    expect(generateSegment('Ça marche à Noël')).toBe('ca-marche-a-noel');
  });

  it('spells out letters that do not decompose', () => {
    expect(generateSegment('Łódź Ærø')).toBe('lodz-aero');
  });

  it('leaves a plain ASCII title as the existing slug rule does', () => {
    expect(generateSegment('Auth Service')).toBe(slugifySegment('Auth Service'));
    expect(generateSegment('  --Auth___Service!!  ')).toBe('auth-service');
  });
});

describe('generateSegment — mixed and empty', () => {
  it('handles a title mixing scripts, digits and punctuation', () => {
    expect(generateSegment('API v2: Авторизация через OAuth 2.0')).toBe(
      'api-v2-avtorizatsiia-cherez-oauth-2-0',
    );
    expect(generateSegment('🚀 Деплой — prod')).toBe('deploi-prod');
  });

  it('falls back to page-<hash> for an emoji-only title', () => {
    const segment = generateSegment('🚀🔥');
    expect(segment).toMatch(/^page-[0-9a-f]{8}$/);
    expect(segment.startsWith(FALLBACK_SEGMENT_PREFIX)).toBe(true);
  });

  it('falls back for a script it has no table for', () => {
    expect(generateSegment('架构')).toMatch(/^page-[0-9a-f]{8}$/);
  });

  it('is deterministic, and different titles fall back differently', () => {
    expect(generateSegment('🚀🔥')).toBe(generateSegment('🚀🔥'));
    expect(generateSegment('🚀🔥')).not.toBe(generateSegment('🎉'));
    expect(generateSegment(' 🚀🔥 ')).toBe(generateSegment('🚀🔥'));
  });

  it('reports an empty slug from slugFromTitle when nothing survives', () => {
    expect(slugFromTitle('🚀🔥')).toBe('');
    expect(slugFromTitle('———')).toBe('');
  });

  it('always produces a valid segment within the length limit', () => {
    const long = 'Очень длинный заголовок страницы '.repeat(10);
    for (const title of ['Архитектура', '🚀', long, 'Größe', 'a', '---x---']) {
      const segment = generateSegment(title);
      expect(segment).toMatch(SEGMENT_PATTERN);
      expect(segment.length).toBeLessThanOrEqual(MAX_SEGMENT_LENGTH);
    }
    expect(generateSegment(long).endsWith('-')).toBe(false);
  });
});

describe('transliterate', () => {
  it('leaves characters it has no table for untouched', () => {
    expect(transliterate('abc 123 架')).toBe('abc 123 架');
  });
});

describe('withNumericSuffix', () => {
  it('keeps the bare segment for the first page and numbers the rest', () => {
    expect(withNumericSuffix('arkhitektura', 1)).toBe('arkhitektura');
    expect(withNumericSuffix('arkhitektura', 2)).toBe('arkhitektura-2');
    expect(withNumericSuffix('arkhitektura', 13)).toBe('arkhitektura-13');
  });

  it('shortens a segment at the limit so the suffix fits', () => {
    const full = 'a'.repeat(MAX_SEGMENT_LENGTH);
    const numbered = withNumericSuffix(full, 2);
    expect(numbered.length).toBe(MAX_SEGMENT_LENGTH);
    expect(numbered.endsWith('-2')).toBe(true);
    expect(numbered).toMatch(SEGMENT_PATTERN);
  });

  it('does not leave a double hyphen where the cut lands on one', () => {
    const segment = `${'a'.repeat(MAX_SEGMENT_LENGTH - 3)}-bc`;
    expect(withNumericSuffix(segment, 2)).toMatch(SEGMENT_PATTERN);
  });

  it('refuses a number that is not a positive integer', () => {
    expect(() => withNumericSuffix('x', 0)).toThrow(RangeError);
    expect(() => withNumericSuffix('x', 1.5)).toThrow(RangeError);
  });
});
