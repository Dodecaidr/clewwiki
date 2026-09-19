import { describe, expect, it } from 'vitest';

import { MAX_MENTIONS_PER_TEXT, mentionKey, mentionSyntax, parseMentions } from '@/lib/mentions/parse';

describe('finding the names a text addresses', () => {
  it('reads both spellings, in the order they appear', () => {
    expect(parseMentions('@backend-agent can you check? cc @[Ada Lovelace], @docs_bot.v2')).toEqual([
      'backend-agent',
      'Ada Lovelace',
      'docs_bot.v2',
    ]);
  });

  it('counts a name once however it is cased or spaced', () => {
    expect(parseMentions('@[Ada  Lovelace] and @[ada lovelace] and @ADA')).toEqual(['Ada  Lovelace', 'ADA']);
    expect(mentionKey('  Ada   Lovelace ')).toBe('ada lovelace');
  });

  it('does not take an e-mail address or a double at for a mention', () => {
    expect(parseMentions('write to ada@example.com or see @@internal')).toEqual([]);
  });

  it('leaves the trailing punctuation of a sentence out of the name', () => {
    expect(parseMentions('Thanks @backend-agent. And @gateway-bot, too - (@ops)')).toEqual([
      'backend-agent',
      'gateway-bot',
      'ops',
    ]);
  });

  it('skips code, fenced or inline', () => {
    const text = ['```java', '@Override', 'public void run() {}', '```', 'Use `@Inject` here, @reviewer.'].join('\n');
    expect(parseMentions(text)).toEqual(['reviewer']);
    expect(parseMentions('~~~\n@hidden\n~~~\n@shown')).toEqual(['shown']);
  });

  it('stops at the cap, so a wall of names is not a broadcast', () => {
    const many = Array.from({ length: 25 }, (_value, index) => `@agent-${index}`).join(' ');
    expect(parseMentions(many)).toHaveLength(MAX_MENTIONS_PER_TEXT);
  });

  it('refuses a bracketed name that runs on', () => {
    expect(parseMentions(`@[${'x'.repeat(101)}]`)).toEqual([]);
    expect(parseMentions('@[line\nbreak]')).toEqual([]);
  });

  it('spells a name the way it has to be written', () => {
    expect(mentionSyntax('backend-agent')).toBe('@backend-agent');
    expect(mentionSyntax('Ada Lovelace')).toBe('@[Ada Lovelace]');
    expect(mentionSyntax('Илья')).toBe('@[Илья]');
    expect(parseMentions(mentionSyntax('Илья'))).toEqual(['Илья']);
  });
});
