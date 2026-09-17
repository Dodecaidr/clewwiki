/**
 * Path segments generated from page titles.
 *
 * A title is turned into a segment in four steps, every one of them
 * deterministic so the form's preview and the server agree on the result:
 *
 * 1. Cyrillic letters of Russian, Ukrainian and Belarusian are transliterated
 *    with the ICAO Doc 9303 table — the one used for the machine-readable zone
 *    of passports — applied letter by letter regardless of language. It needs
 *    no apostrophes or digraphs made of punctuation, which is what makes it fit
 *    a URL: `Архитектура бэкенда` becomes `arkhitektura-bekenda`. One table for
 *    three languages means `г` is always `g` and `и` always `i`, including in
 *    Ukrainian words where a national system would write `h` and `y`.
 * 2. A handful of Latin letters that Unicode does not decompose (`ß`, `æ`, `œ`,
 *    `ø`, `ł`, …) are spelled out, and the remaining diacritics are stripped by
 *    NFKD normalisation: `Größe` becomes `grosse`, `Côté` becomes `cote`.
 * 3. The result is lowercased, every run of other characters becomes one
 *    hyphen, hyphens are trimmed, and the segment is cut to the segment limit.
 * 4. A title with nothing left — emoji only, or a script with no table here,
 *    such as Chinese — gets `page-` followed by eight hex digits hashed from the
 *    title, so the same title always proposes the same segment.
 *
 * Uniqueness is not this module's concern: two pages with the same title under
 * the same parent are told apart on the server, which appends `-2`, `-3`, … to
 * whichever arrives second (`withNumericSuffix`).
 */

import { MAX_SEGMENT_LENGTH, slugifySegment } from './paths';

/** ICAO Doc 9303 transliteration for the Cyrillic letters of ru, uk and be. */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  є: 'ie',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ў: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: 'ie',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'iu',
  я: 'ia',
};

/** Latin letters that NFKD leaves alone because they are not letter + mark. */
const LATIN_LIGATURES: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
};

/**
 * Apostrophes inside words (`м'ясо`, `пам’ять`, `don't`) are dropped rather
 * than turned into a hyphen that would split one word in two.
 */
const DROPPED: ReadonlySet<string> = new Set(["'", '\u2019', '\u02bc']);

/** Prefix of the segment given to a title nothing could be made of. */
export const FALLBACK_SEGMENT_PREFIX = 'page-';

/**
 * Transliterates the letters this module has a table for and leaves everything
 * else as it is. Composed first, so `й` typed as `и` plus a combining breve is
 * still one letter rather than an `i` that loses its mark.
 */
export function transliterate(value: string): string {
  let result = '';
  for (const char of value.normalize('NFC').toLowerCase()) {
    if (DROPPED.has(char)) continue;
    result += CYRILLIC[char] ?? LATIN_LIGATURES[char] ?? char;
  }
  return result;
}

/** The segment a title transliterates to, or `''` when nothing survives. */
export function slugFromTitle(title: string): string {
  return slugifySegment(transliterate(title));
}

/** 32-bit FNV-1a over UTF-16 code units, as eight hex digits. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The segment proposed for a title: its transliteration, or `page-<hash>`
 * when the title has no letter or digit this module can spell in Latin.
 */
export function generateSegment(title: string): string {
  const slug = slugFromTitle(title);
  if (slug !== '') return slug;
  return FALLBACK_SEGMENT_PREFIX + shortHash(title.normalize('NFC').trim());
}

/**
 * `segment` with `-n` appended, for the n-th page to want the same segment
 * under the same parent. The first one keeps the bare segment. The segment is
 * shortened when the suffix would push it past the limit, so the result is
 * always a valid segment.
 */
export function withNumericSuffix(segment: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`Suffix number must be a positive integer, got ${n}`);
  }
  if (n === 1) return segment;
  const suffix = `-${n}`;
  const stem = segment.slice(0, MAX_SEGMENT_LENGTH - suffix.length).replace(/-+$/g, '');
  return stem + suffix;
}
