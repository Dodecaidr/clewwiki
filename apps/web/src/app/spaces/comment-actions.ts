'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  MAX_COMMENT_BYTES,
  deleteComment,
  openComment,
  replyToComment,
  setCommentResolved,
} from '@/lib/comments/service';
import { consumeMessageBudget } from '@/lib/discussions/rate-limit';
import { isPageServiceError } from '@/lib/pages/errors';
import { getSessionContext } from '@/lib/session';
import type { SessionContext } from '@/lib/session';
import { canViewComment, canViewPage } from '@/lib/spaces/guards';

/**
 * What a person does with comments from the interface.
 *
 * Every action re-reads the session itself and goes through the same service as
 * the REST endpoints, so a comment written here is bounded, audited and
 * anchored exactly like one an agent posts.
 */

export interface CommentFormState {
  error?: string;
  message?: string;
  /** Changes on every success, so a form can tell a second success from the first. */
  savedAt?: number;
}

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function toFormState(error: unknown): CommentFormState {
  if (isPageServiceError(error)) return { error: error.code, message: error.message };
  console.error('[comments] action failed', error);
  return { error: 'generic' };
}

function actorOf(session: SessionContext) {
  return { type: 'user' as const, id: session.userId, label: session.name };
}

function overBudget(session: SessionContext): CommentFormState | null {
  return consumeMessageBudget('user', session.userId).allowed ? null : { error: 'rate_limited' };
}

const openSchema = z.object({
  pageId: z.uuid(),
  body: z.string().trim().min(1).max(MAX_COMMENT_BYTES),
  // Empty for a comment on the page as a whole.
  blockIndex: z.union([z.literal(''), z.coerce.number().int().min(0).max(100_000)]),
  version: z.coerce.number().int().min(1),
});

export async function openCommentAction(
  _previous: CommentFormState,
  formData: FormData,
): Promise<CommentFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };

  const parsed = openSchema.safeParse({
    pageId: formText(formData, 'pageId'),
    body: formText(formData, 'body'),
    blockIndex: formText(formData, 'blockIndex'),
    version: formText(formData, 'version'),
  });
  if (!parsed.success) return { error: 'validation', message: parsed.error.issues[0]?.message };
  if (!(await canViewPage(session, parsed.data.pageId))) return { error: 'not_found' };
  const limited = overBudget(session);
  if (limited) return limited;

  try {
    await openComment({
      workspaceId: session.workspace.id,
      pageId: parsed.data.pageId,
      actor: actorOf(session),
      body: parsed.data.body,
      blockIndex: parsed.data.blockIndex === '' ? null : parsed.data.blockIndex,
      // The block was counted in the version on screen, which may no longer be
      // the newest by the time the form is posted.
      version: parsed.data.version,
    });
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath('/', 'layout');
  return { savedAt: Date.now() };
}

export async function replyCommentAction(
  _previous: CommentFormState,
  formData: FormData,
): Promise<CommentFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };

  const parsed = z
    .object({ threadId: z.uuid(), body: z.string().trim().min(1).max(MAX_COMMENT_BYTES) })
    .safeParse({ threadId: formText(formData, 'threadId'), body: formText(formData, 'body') });
  if (!parsed.success) return { error: 'validation', message: parsed.error.issues[0]?.message };
  if (!(await canViewComment(session, parsed.data.threadId))) return { error: 'not_found' };
  const limited = overBudget(session);
  if (limited) return limited;

  try {
    await replyToComment({
      workspaceId: session.workspace.id,
      threadId: parsed.data.threadId,
      actor: actorOf(session),
      body: parsed.data.body,
    });
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath('/', 'layout');
  return { savedAt: Date.now() };
}

export async function resolveCommentAction(
  _previous: CommentFormState,
  formData: FormData,
): Promise<CommentFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };

  const parsed = z
    .object({ threadId: z.uuid(), resolved: z.enum(['true', 'false']) })
    .safeParse({
      threadId: formText(formData, 'threadId'),
      resolved: formText(formData, 'resolved'),
    });
  if (!parsed.success) return { error: 'validation' };
  if (!(await canViewComment(session, parsed.data.threadId))) return { error: 'not_found' };

  try {
    await setCommentResolved({
      workspaceId: session.workspace.id,
      threadId: parsed.data.threadId,
      actor: actorOf(session),
      resolved: parsed.data.resolved === 'true',
    });
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath('/', 'layout');
  return { savedAt: Date.now() };
}

export async function deleteCommentAction(
  _previous: CommentFormState,
  formData: FormData,
): Promise<CommentFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };

  const parsed = z.object({ commentId: z.uuid() }).safeParse({
    commentId: formText(formData, 'commentId'),
  });
  if (!parsed.success) return { error: 'validation' };
  if (!(await canViewComment(session, parsed.data.commentId))) return { error: 'not_found' };

  try {
    await deleteComment({
      workspaceId: session.workspace.id,
      commentId: parsed.data.commentId,
      actor: actorOf(session),
      isAdmin: session.role === 'admin',
    });
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath('/', 'layout');
  return { savedAt: Date.now() };
}
