'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  checkPageAnchors,
  confirmAnchor,
  createAnchor,
  deleteAnchor,
  } from '@/lib/anchors/service';
import { isPageServiceError } from '@/lib/pages/errors';
import { getWriterSession } from '@/lib/session';
import type { SessionContext } from '@/lib/session';
import { canViewAnchor, canViewPage, findAnchor } from '@/lib/spaces/guards';

/**
 * The browser's half of the anchor mechanism.
 *
 * Each action re-reads the session itself: a form post reaches an action
 * directly and never passes through the page that rendered it, so the check
 * belongs here rather than in the component. They call the same service the
 * REST endpoints do, so an anchor created from this form and one created by an
 * agent are governed by the same rules and audited the same way.
 */

export interface AnchorActionState {
  ok?: boolean;
  error?: string;
  message?: string;
}

function actorOf(session: SessionContext) {
  return { type: 'user' as const, id: session.userId };
}

function toFailure(error: unknown): AnchorActionState {
  if (isPageServiceError(error)) {
    return { ok: false, error: error.code, message: error.message };
  }
  console.error('[anchors] action failed', error);
  return { ok: false, error: 'generic' };
}

const createSchema = z.object({
  pageId: z.uuid(),
  file: z.string().trim().min(1).max(512),
  target: z.string().trim().max(500).optional(),
  sectionId: z.string().trim().max(200).optional(),
});

/**
 * Adds an anchor from the page view.
 *
 * One text field carries either a symbol or a line range (`42-58`), because
 * that is how a reader thinks about it — "this section documents `Mixer.blend`"
 * or "this section documents those lines" — rather than as two mutually
 * exclusive forms.
 */
export async function createAnchorAction(
  _previous: AnchorActionState,
  formData: FormData,
): Promise<AnchorActionState> {
  const session = await getWriterSession();
  if (!session) return { ok: false, error: 'forbidden' };

  const parsed = createSchema.safeParse({
    pageId: formData.get('pageId'),
    file: formData.get('file'),
    target: formData.get('target') ?? '',
    sectionId: formData.get('sectionId') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'validation' };
  if (!(await canViewPage(session, parsed.data.pageId))) return { ok: false, error: 'not_found' };

  const target = parsed.data.target?.trim() ?? '';
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(target);

  try {
    await createAnchor({
      workspaceId: session.workspace.id,
      pageId: parsed.data.pageId,
      actor: actorOf(session),
      file: parsed.data.file,
      qualifiedName: range ? null : target || null,
      lineStart: range ? Number.parseInt(range[1] ?? '', 10) : null,
      lineEnd: range ? Number.parseInt(range[2] ?? '', 10) : null,
      sectionId: parsed.data.sectionId || null,
    });
  } catch (error) {
    return toFailure(error);
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}

const anchorIdSchema = z.object({ anchorId: z.uuid() });

/** Recomputes this page's anchors against the repository, on demand. */
export async function checkAnchorsAction(
  _previous: AnchorActionState,
  formData: FormData,
): Promise<AnchorActionState> {
  const session = await getWriterSession();
  if (!session) return { ok: false, error: 'forbidden' };

  const parsed = z.object({ pageId: z.uuid() }).safeParse({ pageId: formData.get('pageId') });
  if (!parsed.success) return { ok: false, error: 'validation' };
  if (!(await canViewPage(session, parsed.data.pageId))) return { ok: false, error: 'not_found' };

  try {
    await checkPageAnchors({
      workspaceId: session.workspace.id,
      pageId: parsed.data.pageId,
      actor: actorOf(session),
    });
  } catch (error) {
    return toFailure(error);
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Clears a flag after the reader has looked at what changed. */
export async function confirmAnchorAction(
  _previous: AnchorActionState,
  formData: FormData,
): Promise<AnchorActionState> {
  const session = await getWriterSession();
  if (!session) return { ok: false, error: 'forbidden' };

  const parsed = anchorIdSchema.safeParse({ anchorId: formData.get('anchorId') });
  if (!parsed.success) return { ok: false, error: 'validation' };

  try {
    const anchor = await findAnchor(session, parsed.data.anchorId);
    if (!anchor) return { ok: false, error: 'not_found' };

    await confirmAnchor({
      workspaceId: session.workspace.id,
      anchorId: parsed.data.anchorId,
      actor: actorOf(session),
    });
  } catch (error) {
    return toFailure(error);
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Removes an anchor. The right answer when the code is gone for good. */
export async function deleteAnchorAction(
  _previous: AnchorActionState,
  formData: FormData,
): Promise<AnchorActionState> {
  const session = await getWriterSession();
  if (!session) return { ok: false, error: 'forbidden' };

  const parsed = anchorIdSchema.safeParse({ anchorId: formData.get('anchorId') });
  if (!parsed.success) return { ok: false, error: 'validation' };
  if (!(await canViewAnchor(session, parsed.data.anchorId))) return { ok: false, error: 'not_found' };

  try {
    await deleteAnchor({
      workspaceId: session.workspace.id,
      anchorId: parsed.data.anchorId,
      actor: actorOf(session),
    });
  } catch (error) {
    return toFailure(error);
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}
