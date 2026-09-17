'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { acquireClaim, releaseClaim } from '@/lib/claims/service';
import { isPageServiceError } from '@/lib/pages/errors';
import { renderMarkdown } from '@/lib/pages/markdown';
import { createPage, deletePage, getPageById, linkPages, updatePage } from '@/lib/pages/service';
import { getSessionContext } from '@/lib/session';
import { getSpaceById, getSpaceByKey } from '@/lib/spaces/service';
import { spaceHref, spacePageHref } from '@/lib/spaces/urls';

/**
 * The write actions behind the page forms.
 *
 * Each one re-checks the session itself. The redirect a page component
 * performs is a UI affordance; the check here is the control, because a form
 * post arrives at the action directly and never passes through the page.
 *
 * A page is placed by choosing its parent from its space's tree; the form sends
 * at most one path segment, never a whole path, so a subsection is made by
 * picking where it goes rather than by typing where it is.
 */

export interface PageFormState {
  error?: string;
  /** Set when the service rejected the write for a reason worth quoting. */
  message?: string;
}

const kindSchema = z.enum(['technical', 'human']);

const fieldsSchema = z.object({
  title: z.string().trim().min(1).max(300),
  /** One path segment. Empty means "derive it from the title" on create, "keep it" on edit. */
  segment: z.string().trim().max(80).optional(),
  parentId: z.uuid().optional(),
  kind: kindSchema,
  summary: z.string().trim().max(2_000).optional(),
  body: z.string().max(1_000_000),
});

const createSchema = fieldsSchema.extend({
  spaceKey: z.string().trim().min(1).max(20),
});

const updateSchema = fieldsSchema.extend({
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
  // Both roles may write, in every space. Per-space permissions are a later
  // step; today the distinctions are token issuance and space administration,
  // which stay with admins.
  return session;
}

function toFormState(error: unknown): PageFormState {
  if (isPageServiceError(error)) {
    return { error: error.code, message: error.message };
  }
  console.error('[pages] action failed', error);
  return { error: 'generic' };
}

/** Every route renders on request; this drops any cached render of them at once. */
function revalidateWiki(): void {
  revalidatePath('/', 'layout');
}

export async function createPageAction(
  _prevState: PageFormState,
  formData: FormData,
): Promise<PageFormState> {
  const session = await requireWriter();
  if (!session) return { error: 'forbidden' };

  const parsed = createSchema.safeParse({
    spaceKey: formData.get('spaceKey'),
    title: formData.get('title'),
    segment: formString(formData, 'segment'),
    parentId: formString(formData, 'parentId'),
    kind: formData.get('kind') ?? 'technical',
    summary: formString(formData, 'summary'),
    body: formData.get('body') ?? '',
  });

  if (!parsed.success) {
    return { error: 'validation' };
  }

  const space = await getSpaceByKey(session.workspace.id, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  let created: { id: string };
  try {
    created = await createPage({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: { type: 'user', id: session.userId },
      title: parsed.data.title,
      // One segment, joined onto the parent's path or made top-level. Left
      // empty, the service generates it from the title — transliterating
      // Cyrillic — and numbers it when that path is already taken.
      slug: parsed.data.segment,
      parentId: parsed.data.parentId ?? null,
      kind: parsed.data.kind,
      body: parsed.data.body,
      summary: parsed.data.summary ?? null,
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidateWiki();
  redirect(spacePageHref(space.key, created.id));
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
    segment: formString(formData, 'segment'),
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
  let spaceId: string;

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

    const updated = await updatePage({
      workspaceId: session.workspace.id,
      pageId: parsed.data.pageId,
      actor: { type: 'user', id: session.userId },
      title: parsed.data.title,
      path: parsed.data.segment,
      parentId: parsed.data.parentId ?? null,
      kind: parsed.data.kind,
      body: parsed.data.body,
      summary: parsed.data.summary ?? null,
      claimId,
      // The form carries the hash it was rendered from, so a save built on a
      // page someone else has since changed is refused rather than winning.
      baseContentHash: parsed.data.baseContentHash,
    });
    spaceId = updated.spaceId;
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

  const space = await getSpaceById(session.workspace.id, spaceId);
  revalidateWiki();
  redirect(space ? spacePageHref(space.key, parsed.data.pageId) : '/');
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

  const page = await getPageById(session.workspace.id, parsed.data.pageId);
  if (!page) return { error: 'not_found' };
  const space = await getSpaceById(session.workspace.id, page.spaceId);

  try {
    await deletePage({
      workspaceId: session.workspace.id,
      pageId: parsed.data.pageId,
      actor: { type: 'user', id: session.userId },
      overrideClaims: session.role === 'admin',
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidateWiki();
  redirect(space ? spaceHref(space.key) : '/');
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

  revalidateWiki();
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
