'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { locales } from '@/i18n/locale';
import { consumeMessageBudget } from '@/lib/discussions/rate-limit';
import {
  MAX_DECISION_FIELD_LENGTH,
  MAX_DISCUSSION_TITLE_LENGTH,
  MAX_MESSAGE_BYTES,
  deleteDiscussion,
  openDiscussion,
  postDiscussionMessage,
  resolveDiscussion,
} from '@/lib/discussions/service';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '@/lib/discussions/retention';
import { isPageServiceError } from '@/lib/pages/errors';
import { getWriterSession } from '@/lib/session';
import type { SessionContext } from '@/lib/session';
import { updateSpace } from '@/lib/spaces/service';
import { spaceDiscussionHref, spaceDiscussionsHref, spacePageHref } from '@/lib/spaces/urls';
import { findSpaceById, findSpaceByKey } from '@/lib/spaces/visibility';
import { canViewDiscussion, findDiscussion } from '@/lib/spaces/guards';

/**
 * What a person does with a discussion from the interface.
 *
 * Every action re-reads the session itself — a form post reaches an action
 * directly, never through the page that rendered the form — and every one goes
 * through the same service the REST endpoints and the MCP tools use, so a
 * thread opened here is audited and swept exactly like one opened by an agent.
 */

export interface DiscussionFormState {
  error?: string;
  message?: string;
  saved?: boolean;
}

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function toFormState(error: unknown): DiscussionFormState {
  if (isPageServiceError(error)) return { error: error.code, message: error.message };
  console.error('[discussions] action failed', error);
  return { error: 'generic' };
}

/** The label a thread snapshots for a person: their display name. */
function actorOf(session: SessionContext) {
  return { type: 'user' as const, id: session.userId, label: session.name };
}

const openSchema = z.object({
  spaceKey: z.string().min(1).max(20),
  title: z.string().trim().min(1).max(MAX_DISCUSSION_TITLE_LENGTH),
  body: z.string().trim().min(1).max(MAX_MESSAGE_BYTES),
  pageId: z.union([z.uuid(), z.literal('')]),
});

export async function openDiscussionAction(
  _previous: DiscussionFormState,
  formData: FormData,
): Promise<DiscussionFormState> {
  const session = await getWriterSession();
  if (!session) return { error: 'forbidden' };

  const parsed = openSchema.safeParse({
    spaceKey: formText(formData, 'spaceKey'),
    title: formText(formData, 'title'),
    body: formText(formData, 'body'),
    pageId: formText(formData, 'pageId'),
  });
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  const space = await findSpaceByKey(session, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  let discussionId: string;
  try {
    const result = await openDiscussion({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: actorOf(session),
      title: parsed.data.title,
      body: parsed.data.body,
      pageId: parsed.data.pageId === '' ? null : parsed.data.pageId,
    });
    discussionId = result.discussion.id;
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(spaceDiscussionHref(space.key, discussionId));
}

export async function postDiscussionMessageAction(
  _previous: DiscussionFormState,
  formData: FormData,
): Promise<DiscussionFormState> {
  const session = await getWriterSession();
  if (!session) return { error: 'forbidden' };

  const parsed = z
    .object({
      discussionId: z.uuid(),
      body: z.string().trim().min(1).max(MAX_MESSAGE_BYTES),
    })
    .safeParse({
      discussionId: formText(formData, 'discussionId'),
      body: formText(formData, 'body'),
    });
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  if (!(await canViewDiscussion(session, parsed.data.discussionId))) return { error: 'not_found' };

  // The same bucket the REST endpoint consumes from, so the interface cannot be
  // used as a way around the limit an agent is held to.
  const budget = consumeMessageBudget('user', session.userId);
  if (!budget.allowed) return { error: 'rate_limited' };

  try {
    await postDiscussionMessage({
      workspaceId: session.workspace.id,
      discussionId: parsed.data.discussionId,
      actor: actorOf(session),
      body: parsed.data.body,
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  return { saved: true };
}

const resolveSchema = z.object({
  discussionId: z.uuid(),
  decision: z.string().trim().min(1).max(MAX_DECISION_FIELD_LENGTH),
  context: z.string().max(MAX_DECISION_FIELD_LENGTH),
  options: z.string().max(MAX_DECISION_FIELD_LENGTH),
  consequences: z.string().max(MAX_DECISION_FIELD_LENGTH),
  locale: z.enum(locales),
});

/**
 * Resolving from the interface, which lands on the decision page it just wrote.
 *
 * Landing there rather than back on the thread is deliberate: the page is the
 * thing that survives, and the person who wrote it should see it as everybody
 * else will, immediately, while they can still fix it.
 */
export async function resolveDiscussionAction(
  _previous: DiscussionFormState,
  formData: FormData,
): Promise<DiscussionFormState> {
  const session = await getWriterSession();
  if (!session) return { error: 'forbidden' };

  const parsed = resolveSchema.safeParse({
    discussionId: formText(formData, 'discussionId'),
    decision: formText(formData, 'decision'),
    context: formText(formData, 'context'),
    options: formText(formData, 'options'),
    consequences: formText(formData, 'consequences'),
    locale: formText(formData, 'locale'),
  });
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  if (!(await canViewDiscussion(session, parsed.data.discussionId))) return { error: 'not_found' };

  let target: string;
  try {
    const result = await resolveDiscussion({
      workspaceId: session.workspace.id,
      discussionId: parsed.data.discussionId,
      actor: actorOf(session),
      decision: parsed.data.decision,
      context: parsed.data.context,
      options: parsed.data.options,
      consequences: parsed.data.consequences,
      locale: parsed.data.locale,
    });
    const space = await findSpaceById(session, result.discussion.spaceId);
    if (!space) return { error: 'not_found' };
    target = spacePageHref(space.key, result.page.id);
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(target);
}

export async function deleteDiscussionAction(
  _previous: DiscussionFormState,
  formData: FormData,
): Promise<DiscussionFormState> {
  const session = await getWriterSession();
  if (!session) return { error: 'forbidden' };

  const parsed = z.object({ discussionId: z.uuid() }).safeParse({
    discussionId: formText(formData, 'discussionId'),
  });
  if (!parsed.success) return { error: 'validation' };

  const existing = await findDiscussion(session, parsed.data.discussionId);
  if (!existing) return { error: 'not_found' };
  const space = await findSpaceById(session, existing.spaceId);
  if (!space) return { error: 'not_found' };

  try {
    await deleteDiscussion({
      workspaceId: session.workspace.id,
      discussionId: existing.id,
      actor: actorOf(session),
      isAdmin: session.role === 'admin',
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(spaceDiscussionsHref(space.key));
}

/* ------------------------------------------------------------------ */
/* Retention settings                                                  */
/* ------------------------------------------------------------------ */

const settingsSchema = z.object({
  spaceKey: z.string().min(1).max(20),
  idleDays: z.coerce.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS),
  retentionDays: z.coerce.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS),
  decisionsPageId: z.union([z.uuid(), z.literal('')]),
});

/**
 * How long this space's threads live, and where its decisions are filed.
 *
 * An administrator's act: the windows decide when everybody else's
 * conversations are deleted, and the parent page decides where a decision ends
 * up in the tree.
 */
export async function saveDiscussionSettingsAction(
  _previous: DiscussionFormState,
  formData: FormData,
): Promise<DiscussionFormState> {
  const session = await getWriterSession();
  if (!session || session.role !== 'admin') return { error: 'forbidden' };

  const parsed = settingsSchema.safeParse({
    spaceKey: formText(formData, 'spaceKey'),
    idleDays: formText(formData, 'idleDays'),
    retentionDays: formText(formData, 'retentionDays'),
    decisionsPageId: formText(formData, 'decisionsPageId'),
  });
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  const space = await findSpaceByKey(session, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  try {
    await updateSpace({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: { type: 'user', id: session.userId },
      discussions: {
        idleDays: parsed.data.idleDays,
        retentionDays: parsed.data.retentionDays,
        decisionsPageId: parsed.data.decisionsPageId === '' ? null : parsed.data.decisionsPageId,
      },
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  return { saved: true };
}
