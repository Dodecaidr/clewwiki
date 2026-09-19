/**
 * Finding the names a text addresses.
 *
 * Two spellings. `@[Ada Lovelace]` takes any name, spaces included, and is what
 * a person's name needs. `@backend-agent` — letters, digits, `.`, `_`, `-` — is
 * what an agent's name usually is, and what people type without being told.
 *
 * Code is skipped: `@Override` in a fence is Java, not a colleague. An e-mail
 * address is not a mention either, which is what the look-behind is for.
 *
 * This is parsing and nothing else — no database, so it can be tested as text.
 * Whether a name belongs to anybody is `./service`'s question.
 */

/** Most distinct names one text may address. A wall of mentions is a broadcast, and there is none. */
export const MAX_MENTIONS_PER_TEXT = 10;
const MAX_NAME_LENGTH = 100;

const FENCED = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const BRACKETED = /(?<![\w@])@\[([^\]\n]{1,100})\]/g;
const BARE = /(?<![\w@[])@([A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9]|[A-Za-z0-9])/g;

/** The names a text mentions, as written, once each, in the order they appear. */
export function parseMentions(text: string): string[] {
  const prose = text.replace(FENCED, '\n').replace(INLINE_CODE, ' ');
  const found: Array<{ index: number; name: string }> = [];
  for (const match of prose.matchAll(BRACKETED)) {
    found.push({ index: match.index, name: (match[1] ?? '').trim() });
  }
  for (const match of prose.matchAll(BARE)) {
    found.push({ index: match.index, name: match[1] ?? '' });
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const { name } of found.sort((a, b) => a.index - b.index)) {
    const key = mentionKey(name);
    if (name === '' || name.length > MAX_NAME_LENGTH || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === MAX_MENTIONS_PER_TEXT) break;
  }
  return names;
}

/** What two spellings of one name have in common: case and surrounding space do not matter. */
export function mentionKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** How to write a mention of this name: bare when it can be, bracketed when it has to be. */
export function mentionSyntax(name: string): string {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(name) ? `@${name}` : `@[${name}]`;
}
