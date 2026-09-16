'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { acquireClaim, releaseClaim } from '@/lib/claims/service';
import { isPageServiceError } from '@/lib/pages/errors';
import { renderMarkdown } from '@/lib/pages/markdown';
import { createPage, deletePage, linkPages, updatePage } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';

/**
 * The write actions behind the page forms.
 *
 * Each one re-checks the session itself. The redirect a page component
 * performs is a UI affordance; the check here is the control, because a form
 * post arrives at the action directly and never passes through the page.
 */

export interface PageFormState {
  error?: string;
  /** Set when the service rejected the write for a reason worth quoting. */
  message?: string;
}

const kindSchema = z.enum(['technical', 'human']);

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  path: z.string().trim().max(512).optional(),
  parentId: z.uuid().optional(),
  kind: kindSchema,
  summary: z.string().trim().max(2_000).optional(),
  body: z.string().max(1_000_000),
});

const updateSchema = createSchema.extend({
  pageId: z.uuid(),
  baseContentHash: z.string().length(64),
  /**
   * The lease the open editor is holding. Absent when the form was submitted
   * without the browser having taken one — with scripting off, for instance —
   * in which case the action takes one for the duration of the save.
   */
  claimId: z.uuid().optional(),
});

function formString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : value;
}

async function requireWriter() {
  const session = await getSessionContext();
  if (!session) return null;
  // Both v1 roles may write. The distinction that exists today is token
  // issuance, which stays with admins.
  return session;
}

function toFormState(error: unknown): PageFormState {
  if (isPageServiceError(error)) {
    return { error: error.code, message: error.message };
  }
  console.error('[pages] action failed', error);
  return { error: 'generic' };
}

export async function createPageAction(
  _prevState: PageFormState,
  formData: FormData,
): Promise<PageFormState> {
  const session = await requireWriter();
  if (!session) return { error: 'forbidden' };

  const parsed = createSchema.safeParse({
    title: formData.get('title'),
    path: formString(formData, 'path'),
    parentId: formString(formData, 'parentId'),
    kind: formData.get('kind') ?? 'technical',
    summary: formString(formData, 'summary'),
    body: formData.get('body') ?? '',
  });

  if (!parsed.success) {
    return { error: 'validation' };
  }

  let created: { id: string };
  try {
    created = await createPage({
      workspaceId: session.workspace.id,
      actor: { type: 'user', id: session.userId },
      title: parsed.data.title,
      path: parsed.data.path,
      parentId: parsed.data.parentId ?? null,
      kind: parsed.data.kind,
      body: parsed.data.body,
      summary: parsed.data.summary ?? null,
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/pages');
  redirect(`/pages/${created.id}`);
}

export async function updatePageAction(
  _prevState: PageFormState,
  formData: FormData,
): Promise<PageFormState> {
  const session = await requireWriter();
  if (!session) return { error: 'forbidden' };

  const parsed = updateSchema.safeParse({
    pageId: formData.get('pageId'),
    baseContentHash: formData.get('baseContentHash'),
    claimId: formString(formData, 'claimId'),
    title: formData.get('title'),
    path: formString(formData, 'path'),
    parentId: formString(formData, 'parentId'),
    kind: formData.get('kind') ?? 'technical',
    summary: formString(formData, 'summary'),
    body: formData.get('body') ?? '',
  });

  if (!parsed.success) {
    return { error: 'validation' };
  }

  const actor = { type: 'user' as const, id: session.userId, label: session.name };

  // A save needs a lease. The editor normally already holds one; when it does
  // not — scripting off, or a form restored from the back button — the action
  // takes one for the length of the write, so the save is still refused if
  // someone else is holding the page rather than quietly overwriting them.
  let claimId = parsed.data.claimId ?? null;
  let takenHere = false;

  try {
    if (!claimId) {
      const { claim } = await acquireClaim({
        workspaceId: session.workspace.id,
        pageId: parsed.data.pageId,
        actor,
        settings: session.workspace.settings,
      });
      claimId = claim.id;
      takenHere = true;
    }

    await updatePage({
      workspaceId: session.workspace.id,
      pageId: parsed.data.pageId,
      actor: { type: 'user', id: session.userId },
      title: parsed.data.title,
      path: parsed.data.path,
      parentId: parsed.data.parentId ?? null,
      kind: parsed.data.kind,
      body: parsed.data.body,
      summary: parsed.data.summary ?? null,
      claimId,
      // The form carries the hash it was rendered from, so a save built on a
      // page someone else has since changed is refused rather than winning.
      baseContentHash: parsed.data.baseContentHash,
    });
  } catch (error) {
    // A lease taken for this save alone goes back even when the save failed;
    // one the editor was already holding stays, so the author can fix the
    // problem and try again without losing the page.
    if (takenHere && claimId) {
      await releaseClaimQuietly(session.workspace.id, claimId, actor);
    }
    return toFormState(error);
  }

  // The editor is done with the page: the lease goes back rather than waiting
  // out its TTL while nobody is editing.
  await releaseClaimQuietly(session.workspace.id, claimId, actor);

  revalidatePath('/pages');
  revalidatePath('/presence');
  revalidatePath(`/pages/${parsed.data.pageId}`);
  redirect(`/pages/${parsed.data.pageId}`);
}

/**
 * Releases a lease without letting that failure become the user's problem.
 *
 * The write it belonged to has already committed; a claim that could not be
 * handed back expires on its own, and reporting it as a failed save would be
 * both wrong and alarming.
 */
async function releaseClaimQuietly(
  workspaceId: string,
  claimId: string,
  actor: { type: 'user'; id: string; label: string },
): Promise<void> {
  try {
    await releaseClaim({ workspaceId, claimId, actor });
  } catch (error) {
    console.error('[pages] claim could not be released after a save', error);
  }
}

export async function deletePageAction(
  _prevState: PageFormState,
  formData: FormData,
): Promise<PageFormState> {
  const session = await requireWriter();
  if (!session) return { error: 'forbidden' };

  const parsed = z.object({ pageId: z.uuid() }).safeParse({ pageId: formData.get('pageId') });
  if (!parsed.success) return { error: 'validation' };

  try {
    await deletePage({
      workspaceId: session.workspace.id,
      pageId: parsed.data.pageId,
      actor: { type: 'user', id: session.userId },
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/pages');
  redirect('/pages');
}

export async function linkPageAction(
  _prevState: PageFormState,
  formData: FormData,
): Promise<PageFormState> {
  const session = await requireWriter();
  if (!session) return { error: 'forbidden' };

  const parsed = z
    .object({ pageId: z.uuid(), linkedPageId: z.uuid().optional() })
    .safeParse({
      pageId: formData.get('pageId'),
      linkedPageId: formString(formData, 'linkedPageId'),
    });
  if (!parsed.success) return { error: 'validation' };

  try {
    await linkPages({
      workspaceId: session.workspace.id,
      pageId: parsed.data.pageId,
      linkedPageId: parsed.data.linkedPageId ?? null,
      actor: { type: 'user', id: session.userId },
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath(`/pages/${parsed.data.pageId}`);
  return {};
}

/**
 * Renders the editor preview.
 *
 * It goes through the same server-side pipeline as the page view and the HTML
 * export instead of a second renderer in the browser, so what the preview
 * shows is what gets stored and exported — and the sanitiser cannot be skipped
 * by rendering a different way.
 */
export async function renderPreviewAction(markdown: string): Promise<string> {
  const session = await getSessionContext();
  if (!session) return '';
  if (typeof markdown !== 'string' || markdown.length > 1_000_000) return '';
  return renderMarkdown(markdown);
}
