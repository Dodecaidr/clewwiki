import type { Locale } from '@/i18n/locale';

/**
 * The body of a decision page, assembled from what the caller wrote.
 *
 * Read this next to what it deliberately does not do: **the server never
 * summarises a thread.** Every word of context, of the options weighed, of the
 * decision and its consequences comes from the caller — a person typing into
 * the resolve form, or an agent that has read the thread and is reporting what
 * it concluded. This module puts four blocks of somebody else's prose under
 * four headings and stamps a footer on the end. Anything cleverer would be the
 * server inventing a record of a decision it did not witness, and a wrong
 * decision page is worse than no decision page, because the next agent to read
 * it will believe it.
 *
 * The result is a normal page body: Markdown, versioned, searchable,
 * exportable. It carries no link back to the thread, because the thread is
 * going to be deleted — a link that will certainly break is worse than none —
 * so instead it records the thread's title and the dates it ran between.
 *
 * Headings are localised because a Russian team's decisions should not carry
 * English headings. The locale is the caller's: the interface language for a
 * person, an optional field for REST and MCP, English when nobody said.
 */

export interface DecisionPageInput {
  /** The discussion's title; also the page's title. */
  discussionTitle: string;
  /** What the decision is, in the caller's words. Required. */
  decision: string;
  /** Why the question came up, in the caller's words. */
  context?: string | null;
  /** The alternatives weighed, quoted or summarised by the caller. */
  options?: string | null;
  /** What follows from the decision: migrations, deprecations, follow-up work. */
  consequences?: string | null;
  /** Display names of everyone who wrote in the thread, opener first. */
  participants: readonly string[];
  openedAt: Date;
  resolvedAt: Date;
  locale?: Locale;
}

interface DecisionLabels {
  context: string;
  options: string;
  decision: string;
  consequences: string;
  /** `{names}` — who took part. */
  participants: string;
  /** `{title}`, `{from}`, `{to}` — which thread, and when it ran. */
  thread: string;
  nobody: string;
}

const LABELS: Record<Locale, DecisionLabels> = {
  en: {
    context: 'Context',
    options: 'Options considered',
    decision: 'Decision',
    consequences: 'Consequences',
    participants: 'Participants: {names}.',
    thread: 'From the discussion “{title}”, {from} — {to}.',
    nobody: 'nobody recorded',
  },
  ru: {
    context: 'Контекст',
    options: 'Рассмотренные варианты',
    decision: 'Решение',
    consequences: 'Последствия',
    participants: 'Участники: {names}.',
    thread: 'По итогам обсуждения «{title}», {from} — {to}.',
    nobody: 'не записаны',
  },
};

/** ISO date without the time: a decision is dated by day, not by second. */
function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Trims a block and drops it if nothing is left. An empty section is a heading
 * with silence under it, which reads as "we did not think about this" rather
 * than "the caller had nothing to add".
 */
function block(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * De-duplicates participant names, keeping the order they first appeared in, so
 * the opener leads and somebody who wrote four messages is named once.
 */
export function uniqueParticipants(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function buildDecisionPageBody(input: DecisionPageInput): string {
  const labels = LABELS[input.locale ?? 'en'];
  const sections: string[] = [];

  const push = (heading: string, text: string | null) => {
    if (text !== null) sections.push(`## ${heading}\n\n${text}`);
  };

  push(labels.context, block(input.context));
  push(labels.options, block(input.options));
  // The decision itself is the only required block, so it is the only one that
  // cannot be dropped; the service refuses an empty one before we get here.
  push(labels.decision, block(input.decision) ?? '');
  push(labels.consequences, block(input.consequences));

  const participants = uniqueParticipants(input.participants);
  const footer = [
    fill(labels.participants, {
      names: participants.length > 0 ? participants.join(', ') : labels.nobody,
    }),
    fill(labels.thread, {
      title: input.discussionTitle.trim(),
      from: isoDay(input.openedAt),
      to: isoDay(input.resolvedAt),
    }),
  ].join(' ');

  return `${sections.join('\n\n')}\n\n---\n\n${footer}\n`;
}

/** The path segment the decisions parent page gets when it is created. */
export const DECISIONS_PAGE_SLUG = 'decisions';

/** Title and body of that parent page, in the caller's language. */
export function decisionsParentTemplate(locale: Locale): { title: string; body: string } {
  return locale === 'ru'
    ? {
        title: 'Решения',
        body:
          '# Решения\n\nЗдесь лежат решения, принятые в обсуждениях этого пространства. ' +
          'Каждая страница ниже — итог одного обсуждения: контекст, рассмотренные варианты, ' +
          'само решение и его последствия. Сами переписки удаляются, решения остаются.\n',
      }
    : {
        title: 'Decisions',
        body:
          '# Decisions\n\nThe decisions taken in this space’s discussions. Each page below is ' +
          'the outcome of one discussion: the context, the options weighed, the decision and ' +
          'what follows from it. The conversations are cleaned up; these stay.\n',
      };
}
