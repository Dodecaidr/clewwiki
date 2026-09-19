'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { isPageServiceError } from '@/lib/pages/errors';
import {
  MAX_REVIEW_NOTE_LENGTH,
  acceptPageChanges,
  revertPageChanges,
} from '@/lib/reviews/service';
import { getSessionContext } from '@/lib/session';
import { spacePageChangesHref } from '@/lib/spaces/urls';
import { findPage, findSpaceById } from '@/lib/spaces/visibility';

/**
 * A person's decision about what agents changed on a page.
 *
 * The action re-reads the session itself — a form post reaches it directly,
 * never through the page that rendered the form — and goes through the same
 * service as `POST /api/v1/pages/{id}/review`. There is no agent path to it: a
 * server action is reached with a session cookie or not at all.
 */

export interface ReviewFormState {
  error?: string;
  message?: string;
}

const decisionSchema = z.object({
  pageId: z.uuid(),
  decision: z.enum(['accept', 'revert']),
  version: z.coerce.number().int().min(1),
  note: z.string().max(MAX_REVIEW_NOTE_LENGTH),
});

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function reviewPageAction(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  const session = await getSessionContext();
  if (!session) return { error: 'forbidden' };

  const parsed = decisionSchema.safeParse({
    pageId: formText(formData, 'pageId'),
    decision: formText(formData, 'decision'),
    version: formText(formData, 'version'),
    note: formText(formData, 'note'),
  });
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  const page = await findPage(session, parsed.data.pageId);
  if (!page) return { error: 'not_found' };
  const space = await findSpaceById(session, page.spaceId);
  if (!space) return { error: 'not_found' };

  let from: number;
  let to: number;
  try {
    const input = {
      workspaceId: session.workspace.id,
      pageId: page.id,
      reviewer: { id: session.userId, label: session.name },
      headVersion: parsed.data.version,
      note: parsed.data.note,
    };
    const result =
      parsed.data.decision === 'accept'
        ? await acceptPageChanges(input)
        : await revertPageChanges(input);
    from = result.review.fromVersion;
    to = result.review.toVersion;
  } catch (error) {
    if (isPageServiceError(error)) {
      const reason = typeof error.details?.reason === 'string' ? error.details.reason : null;
      return { error: reason ?? error.code, message: error.message };
    }
    console.error('[reviews] action failed', error);
    return { error: 'generic' };
  }

  revalidatePath('/', 'layout');
  // Back to the same comparison, which now shows the decision instead of the
  // form. A page an agent created has no "before" to show, so it is 0.
  redirect(`${spacePageChangesHref(space.key, page.id, { from, to })}&decided=1`);
}
