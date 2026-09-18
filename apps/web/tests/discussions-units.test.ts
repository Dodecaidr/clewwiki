import { describe, expect, it } from 'vitest';

import {
  DECISIONS_PAGE_SLUG,
  buildDecisionPageBody,
  decisionsParentTemplate,
  uniqueParticipants,
} from '@/lib/discussions/decision-page';
import {
  DEFAULT_IDLE_DAYS,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  clampDays,
  idleDeadline,
  nextExpiry,
  readDiscussionPolicy,
  retentionDeadline,
} from '@/lib/discussions/retention';
import {
  MAX_DECISION_FIELD_LENGTH,
  MAX_DISCUSSION_TITLE_LENGTH,
  MAX_MESSAGE_BYTES,
  messageByteLength,
  normalizeDiscussionTitle,
  normalizeMessageBody,
  wasClosedForInactivity,
} from '@/lib/discussions/service';
import type { DiscussionRecord } from '@/lib/discussions/service';
import {
  newSpaceDiscussionHref,
  spaceDiscussionHref,
  spaceDiscussionsHref,
} from '@/lib/spaces/urls';

const DAY = 24 * 60 * 60 * 1000;

describe('retention policy', () => {
  it('falls back to the documented defaults when a space has configured nothing', () => {
    const policy = readDiscussionPolicy({});
    expect(policy).toEqual({
      idleDays: DEFAULT_IDLE_DAYS,
      retentionDays: DEFAULT_RETENTION_DAYS,
      decisionsPageId: null,
    });
    expect(DEFAULT_IDLE_DAYS).toBe(14);
    expect(DEFAULT_RETENTION_DAYS).toBe(7);
  });

  it('reads what the space configured', () => {
    expect(
      readDiscussionPolicy({
        discussion_idle_days: 30,
        discussion_retention_days: 2,
        decisions_page_id: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({
      idleDays: 30,
      retentionDays: 2,
      decisionsPageId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('refuses to let a nonsense setting change how the sweep behaves', () => {
    // Settings JSON is written by administrators and by older releases; a value
    // this cannot read must fall back rather than produce a strange deadline.
    expect(clampDays(undefined, 14)).toBe(14);
    expect(clampDays('seven', 14)).toBe(14);
    expect(clampDays(Number.NaN, 14)).toBe(14);
    expect(clampDays(Number.POSITIVE_INFINITY, 14)).toBe(14);
    // A window of zero would delete a thread in the same sweep that made it.
    expect(clampDays(0, 14)).toBe(MIN_RETENTION_DAYS);
    expect(clampDays(-5, 14)).toBe(MIN_RETENTION_DAYS);
    expect(clampDays(10_000, 14)).toBe(MAX_RETENTION_DAYS);
    expect(clampDays(7.9, 14)).toBe(7);
  });

  it('treats an empty decisions page id as no page at all', () => {
    expect(readDiscussionPolicy({ decisions_page_id: '' }).decisionsPageId).toBeNull();
    expect(readDiscussionPolicy({ decisions_page_id: null }).decisionsPageId).toBeNull();
    expect(readDiscussionPolicy(null).decisionsPageId).toBeNull();
  });

  it('computes the two deadlines from the policy', () => {
    const policy = readDiscussionPolicy({ discussion_idle_days: 14, discussion_retention_days: 7 });
    const at = new Date('2026-03-01T00:00:00.000Z');
    expect(idleDeadline(at, policy).toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(retentionDeadline(at, policy).toISOString()).toBe('2026-03-08T00:00:00.000Z');
  });

  it('picks the idle window while open and the retention window once resolved', () => {
    const policy = readDiscussionPolicy({ discussion_idle_days: 3, discussion_retention_days: 1 });
    const at = new Date('2026-03-01T12:00:00.000Z');
    expect(nextExpiry('open', at, policy).getTime()).toBe(at.getTime() + 3 * DAY);
    expect(nextExpiry('resolved', at, policy).getTime()).toBe(at.getTime() + 1 * DAY);
  });
});

describe('validation limits', () => {
  it('trims and collapses a title, and refuses an empty one', () => {
    expect(normalizeDiscussionTitle('  Auth   contract  ')).toBe('Auth contract');
    expect(() => normalizeDiscussionTitle('   ')).toThrow(/needs a title/);
  });

  it('refuses a title past the limit, naming it', () => {
    expect(() => normalizeDiscussionTitle('x'.repeat(MAX_DISCUSSION_TITLE_LENGTH + 1))).toThrow(
      /at most 200 characters/,
    );
    expect(normalizeDiscussionTitle('x'.repeat(MAX_DISCUSSION_TITLE_LENGTH))).toHaveLength(
      MAX_DISCUSSION_TITLE_LENGTH,
    );
  });

  it('measures a message in octets, not characters', () => {
    // The cap bounds what a thread costs to read back, and Cyrillic is two
    // octets per character: 4096 Russian letters are exactly the limit.
    expect(messageByteLength('я')).toBe(2);
    expect(messageByteLength('a')).toBe(1);
    expect(() => normalizeMessageBody('я'.repeat(4_096))).not.toThrow();
    expect(() => normalizeMessageBody('я'.repeat(4_097))).toThrow(/at most 8192 bytes/);
    expect(() => normalizeMessageBody('a'.repeat(MAX_MESSAGE_BYTES + 1))).toThrow();
  });

  it('refuses an empty message', () => {
    expect(() => normalizeMessageBody('   \n  ')).toThrow(/needs a body/);
    expect(normalizeMessageBody('  hello  ')).toBe('hello');
  });

  it('keeps the decision field ceiling well above a message, because a page is not a note', () => {
    expect(MAX_DECISION_FIELD_LENGTH).toBeGreaterThan(MAX_MESSAGE_BYTES);
  });
});

describe('closed for inactivity', () => {
  function discussion(overrides: Partial<DiscussionRecord> = {}): DiscussionRecord {
    return {
      id: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-0000000000ff',
      spaceId: '00000000-0000-4000-8000-0000000000aa',
      title: 'Auth contract',
      status: 'resolved',
      openedByType: 'agent',
      openedById: 'token-1',
      openedByLabel: 'backend-agent',
      pageId: null,
      sectionId: null,
      lastActivityAt: new Date('2026-03-01T00:00:00.000Z'),
      resolvedAt: new Date('2026-03-15T00:00:00.000Z'),
      resolvedBy: 'system',
      decisionPageId: null,
      expiresAt: new Date('2026-03-22T00:00:00.000Z'),
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('is derived from the state rather than from a sentence stored in a row', () => {
    expect(wasClosedForInactivity(discussion())).toBe(true);
    // Resolved by a person, with a decision: not the same thing at all.
    expect(
      wasClosedForInactivity(
        discussion({ resolvedBy: 'user-1', decisionPageId: '00000000-0000-4000-8000-00000000000b' }),
      ),
    ).toBe(false);
    expect(wasClosedForInactivity(discussion({ status: 'open' }))).toBe(false);
  });
});

describe('decision page body', () => {
  const base = {
    discussionTitle: 'Auth contract: breaking change to /session',
    decision: 'Drop the legacy cookie in 2.0.',
    participants: ['backend-agent', 'Dana', 'backend-agent'],
    openedAt: new Date('2026-03-01T09:00:00.000Z'),
    resolvedAt: new Date('2026-03-04T17:30:00.000Z'),
  };

  it('puts the caller’s four blocks under headings, in ADR order', () => {
    const body = buildDecisionPageBody({
      ...base,
      context: 'Two services still read it.',
      options: 'Keep it, deprecate it, drop it.',
      consequences: 'OPS reruns its integration suite.',
    });
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(['Context', 'Options considered', 'Decision', 'Consequences']);
    expect(body).toContain('Two services still read it.');
    expect(body).toContain('Drop the legacy cookie in 2.0.');
  });

  it('leaves out a section the caller had nothing to say about', () => {
    const body = buildDecisionPageBody(base);
    expect(body).toContain('## Decision');
    expect(body).not.toContain('## Context');
    expect(body).not.toContain('## Options considered');
    expect(body).not.toContain('## Consequences');
  });

  it('names the participants once each, opener first, and dates the thread', () => {
    const body = buildDecisionPageBody(base);
    expect(body).toContain('Participants: backend-agent, Dana.');
    expect(body).toContain(
      'From the discussion “Auth contract: breaking change to /session”, 2026-03-01 — 2026-03-04.',
    );
  });

  it('carries no link back to the thread, because the thread is going to be gone', () => {
    const body = buildDecisionPageBody(base);
    expect(body).not.toContain('/discussions/');
    expect(body).not.toMatch(/\]\(/);
  });

  it('writes the headings in the caller’s language', () => {
    const body = buildDecisionPageBody({ ...base, context: 'Контекст тут.', locale: 'ru' });
    expect(body).toContain('## Контекст');
    expect(body).toContain('## Решение');
    expect(body).toContain('Участники: backend-agent, Dana.');
    expect(body).toContain('По итогам обсуждения');
  });

  it('says so plainly when nobody is recorded as a participant', () => {
    expect(buildDecisionPageBody({ ...base, participants: [] })).toContain(
      'Participants: nobody recorded.',
    );
  });

  it('de-duplicates participants keeping first appearance', () => {
    expect(uniqueParticipants(['  a  ', 'b', 'a', '', '   ', 'b'])).toEqual(['a', 'b']);
  });

  it('offers a decisions parent in both languages, filed at /decisions', () => {
    expect(DECISIONS_PAGE_SLUG).toBe('decisions');
    expect(decisionsParentTemplate('en').title).toBe('Decisions');
    expect(decisionsParentTemplate('ru').title).toBe('Решения');
    expect(decisionsParentTemplate('ru').body).toContain('решения');
  });
});

describe('discussion routes', () => {
  it('builds the addresses the sidebar and the page buttons link to', () => {
    expect(spaceDiscussionsHref('MOBILE')).toBe('/spaces/MOBILE/discussions');
    expect(spaceDiscussionHref('MOBILE', 'abc')).toBe('/spaces/MOBILE/discussions/abc');
    expect(newSpaceDiscussionHref('MOBILE')).toBe('/spaces/MOBILE/discussions/new');
    expect(newSpaceDiscussionHref('MOBILE', 'p1')).toBe('/spaces/MOBILE/discussions/new?page=p1');
  });
});
