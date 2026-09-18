'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { isPageServiceError } from '@/lib/pages/errors';
import { getSessionContext } from '@/lib/session';
import { createSkill, deleteSkill, updateSkill } from '@/lib/skills/service';
import { getSpaceByKey } from '@/lib/spaces/service';
import { spaceSkillHref, spaceSkillsHref } from '@/lib/spaces/urls';

/**
 * The browser's side of the skills registry.
 *
 * Every action re-reads the session itself — a form post reaches an action
 * directly, never through the page that rendered the form — and every one goes
 * through the same service the REST endpoints use, so a skill written here is
 * validated and audited exactly like one written by an agent.
 *
 * Writing a skill is an editor's act, the same as writing a page. Deleting one
 * is an administrator's: a skill is installed on other people's machines, and
 * removing it from the registry is not the local, reversible thing deleting a
 * page is.
 */

export interface SkillFormState {
  error?: string;
  message?: string;
  saved?: boolean;
  field?: string;
}

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

/** Tags arrive as one comma- or space-separated field, which is how they read. */
function formTags(formData: FormData): string[] {
  return formText(formData, 'tags')
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

function toFormState(error: unknown): SkillFormState {
  if (isPageServiceError(error)) return { error: error.code, message: error.message };
  console.error('[skills] action failed', error);
  return { error: 'generic' };
}

const baseSchema = z.object({
  spaceKey: z.string().min(1).max(20),
  name: z.string().max(200),
  description: z.string().max(4_000),
  version: z.string().max(200),
  body: z.string().max(1_000_000),
  slug: z.string().max(200),
});

async function requireEditor() {
  const session = await getSessionContext();
  return session ?? null;
}

export async function createSkillAction(
  _previous: SkillFormState,
  formData: FormData,
): Promise<SkillFormState> {
  const session = await requireEditor();
  if (!session) return { error: 'forbidden' };

  const parsed = baseSchema.safeParse({
    spaceKey: formText(formData, 'spaceKey'),
    name: formText(formData, 'name'),
    description: formText(formData, 'description'),
    version: formText(formData, 'version'),
    body: formText(formData, 'body'),
    slug: formText(formData, 'slug'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: 'validation', message: issue?.message, field: String(issue?.path[0] ?? '') };
  }

  const space = await getSpaceByKey(session.workspace.id, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };
  if (space.archivedAt !== null) return { error: 'conflict' };

  let slug: string;
  try {
    const created = await createSkill({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      spaceKey: space.key,
      actor: { type: 'user', id: session.userId },
      name: parsed.data.name,
      description: parsed.data.description,
      version: parsed.data.version,
      tags: formTags(formData),
      body: parsed.data.body,
      slug: parsed.data.slug,
    });
    slug = created.slug;
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(spaceSkillHref(space.key, slug));
}

export async function updateSkillAction(
  _previous: SkillFormState,
  formData: FormData,
): Promise<SkillFormState> {
  const session = await requireEditor();
  if (!session) return { error: 'forbidden' };

  const parsed = baseSchema
    .extend({ currentSlug: z.string().min(1).max(200) })
    .safeParse({
      spaceKey: formText(formData, 'spaceKey'),
      currentSlug: formText(formData, 'currentSlug'),
      name: formText(formData, 'name'),
      description: formText(formData, 'description'),
      version: formText(formData, 'version'),
      body: formText(formData, 'body'),
      slug: formText(formData, 'slug'),
    });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: 'validation', message: issue?.message, field: String(issue?.path[0] ?? '') };
  }

  const space = await getSpaceByKey(session.workspace.id, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  let slug: string;
  try {
    const updated = await updateSkill({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      spaceKey: space.key,
      slug: parsed.data.currentSlug,
      actor: { type: 'user', id: session.userId },
      name: parsed.data.name,
      description: parsed.data.description,
      version: parsed.data.version,
      tags: formTags(formData),
      body: parsed.data.body,
      newSlug: parsed.data.slug.trim() === '' ? undefined : parsed.data.slug,
    });
    slug = updated.slug;
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(spaceSkillHref(space.key, slug));
}

export async function deleteSkillAction(
  _previous: SkillFormState,
  formData: FormData,
): Promise<SkillFormState> {
  const session = await getSessionContext();
  if (!session || session.role !== 'admin') return { error: 'forbidden' };

  const parsed = z
    .object({ spaceKey: z.string().min(1).max(20), slug: z.string().min(1).max(200) })
    .safeParse({ spaceKey: formText(formData, 'spaceKey'), slug: formText(formData, 'slug') });
  if (!parsed.success) return { error: 'validation' };

  const space = await getSpaceByKey(session.workspace.id, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  try {
    await deleteSkill({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      spaceKey: space.key,
      slug: parsed.data.slug,
      actor: { type: 'user', id: session.userId },
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(spaceSkillsHref(space.key));
}
