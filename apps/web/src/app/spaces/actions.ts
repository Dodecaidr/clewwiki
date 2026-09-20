'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { locales } from '@/i18n/locale';
import { recordAudit } from '@/lib/audit';
import { isPageServiceError } from '@/lib/pages/errors';
import { createPage } from '@/lib/pages/service';
import { probeRepository } from '@/lib/repository/git';
import { repositorySettingsSchema } from '@/lib/repository/settings';
import { getWriterSession } from '@/lib/session';
import {
  spaceDescriptionSchema,
  spaceIconSchema,
  spaceKeyInputSchema,
  spaceNameSchema,
} from '@/lib/spaces/keys';
import { RULES_PAGE_SLUG, rulesTemplate } from '@/lib/spaces/rules';
import { createSpace, setSpaceArchived, updateSpace } from '@/lib/spaces/service';
import { spaceHref, spaceRulesHref, spaceSettingsHref } from '@/lib/spaces/urls';
import { findSpaceByKey } from '@/lib/spaces/visibility';
import { MAX_SPACE_MEMBERS, setSpaceMembers } from '@/lib/spaces/visibility';

/**
 * The administrator's actions on spaces: create one, change it, link its
 * repository, archive it.
 *
 * Every one re-reads the session and checks the role itself — a form post
 * reaches an action directly, never through the page that rendered the form —
 * and every one goes through the same service the REST endpoints use, so a
 * space changed here is audited exactly like one changed over the API.
 */

export interface SpaceFormState {
  error?: string;
  message?: string;
  saved?: boolean;
  /** Which field the message is about, when the service or the schema said. */
  field?: string;
}

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

async function requireAdmin() {
  const session = await getWriterSession();
  if (!session || session.role !== 'admin') return null;
  return session;
}

function toFormState(error: unknown): SpaceFormState {
  if (isPageServiceError(error)) return { error: error.code, message: error.message };
  console.error('[spaces] action failed', error);
  return { error: 'generic' };
}

const createSchema = z.object({
  key: spaceKeyInputSchema,
  name: spaceNameSchema,
  description: spaceDescriptionSchema,
  icon: spaceIconSchema,
});

export async function createSpaceAction(
  _previous: SpaceFormState,
  formData: FormData,
): Promise<SpaceFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const parsed = createSchema.safeParse({
    key: formText(formData, 'key'),
    name: formText(formData, 'name'),
    description: formText(formData, 'description'),
    icon: formText(formData, 'icon'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: 'validation', message: issue?.message, field: String(issue?.path[0] ?? '') };
  }

  let key: string;
  try {
    const space = await createSpace({
      workspaceId: session.workspace.id,
      actor: { type: 'user', id: session.userId },
      key: parsed.data.key,
      name: parsed.data.name,
      description: parsed.data.description,
      icon: parsed.data.icon,
    });
    key = space.key;
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(spaceHref(key));
}

const updateSchema = z.object({
  spaceKey: z.string().min(1).max(20),
  name: spaceNameSchema,
  description: spaceDescriptionSchema,
  icon: spaceIconSchema,
  homePageId: z.union([z.uuid(), z.literal('')]),
});

export async function updateSpaceAction(
  _previous: SpaceFormState,
  formData: FormData,
): Promise<SpaceFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const parsed = updateSchema.safeParse({
    spaceKey: formText(formData, 'spaceKey'),
    name: formText(formData, 'name'),
    description: formText(formData, 'description'),
    icon: formText(formData, 'icon'),
    homePageId: formText(formData, 'homePageId'),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: 'validation', message: issue?.message, field: String(issue?.path[0] ?? '') };
  }

  const space = await findSpaceByKey(session, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  try {
    await updateSpace({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: { type: 'user', id: session.userId },
      name: parsed.data.name,
      description: parsed.data.description,
      icon: parsed.data.icon,
      homePageId: parsed.data.homePageId === '' ? null : parsed.data.homePageId,
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  return { saved: true };
}

export async function setSpaceArchivedAction(
  _previous: SpaceFormState,
  formData: FormData,
): Promise<SpaceFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const parsed = z
    .object({ spaceKey: z.string().min(1).max(20), archived: z.enum(['true', 'false']) })
    .safeParse({ spaceKey: formText(formData, 'spaceKey'), archived: formText(formData, 'archived') });
  if (!parsed.success) return { error: 'validation' };

  const space = await findSpaceByKey(session, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  try {
    await setSpaceArchived({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: { type: 'user', id: session.userId },
      archived: parsed.data.archived === 'true',
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(spaceSettingsHref(space.key));
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/**
 * Which page holds the project's rules — and, when there is none yet, creating
 * one from the starter template.
 *
 * Designating a page is an administrator's act because it decides what every
 * agent working in the space is told to follow. Editing the page afterwards is
 * an ordinary page edit by anyone who may write there, which is the point of
 * making the rules a page rather than a settings field.
 */
export async function setRulesPageAction(
  _previous: SpaceFormState,
  formData: FormData,
): Promise<SpaceFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const parsed = z
    .object({
      spaceKey: z.string().min(1).max(20),
      rulesPageId: z.union([z.uuid(), z.literal('')]),
    })
    .safeParse({
      spaceKey: formText(formData, 'spaceKey'),
      rulesPageId: formText(formData, 'rulesPageId'),
    });
  if (!parsed.success) return { error: 'validation' };

  const space = await findSpaceByKey(session, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  try {
    await updateSpace({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: { type: 'user', id: session.userId },
      rulesPageId: parsed.data.rulesPageId === '' ? null : parsed.data.rulesPageId,
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  return { saved: true };
}

/**
 * Creates the rules page from the starter template and designates it, in that
 * order, so a failure to designate leaves a page rather than nothing.
 *
 * The template is placeholders only. A rules document that arrived pre-filled
 * with plausible-looking facts about a project nobody has described would be
 * believed by the first agent that read it, which is worse than an empty
 * heading.
 */
export async function createRulesPageAction(
  _previous: SpaceFormState,
  formData: FormData,
): Promise<SpaceFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const parsed = z
    .object({ spaceKey: z.string().min(1).max(20), locale: z.enum(locales) })
    .safeParse({ spaceKey: formText(formData, 'spaceKey'), locale: formText(formData, 'locale') });
  if (!parsed.success) return { error: 'validation' };

  const space = await findSpaceByKey(session, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };
  if (space.archivedAt !== null) return { error: 'conflict' };

  const template = rulesTemplate(parsed.data.locale);
  try {
    const page = await createPage({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: { type: 'user', id: session.userId },
      title: template.title,
      body: template.body,
      kind: 'technical',
      slug: RULES_PAGE_SLUG,
    });
    await updateSpace({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: { type: 'user', id: session.userId },
      rulesPageId: page.id,
    });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  redirect(spaceRulesHref(space.key));
}

/* ------------------------------------------------------------------ */
/* Repository                                                          */
/* ------------------------------------------------------------------ */

/**
 * A space's repository setting, edited by an administrator.
 *
 * Linking a repository decides what every anchor in the space is checked
 * against, so it is a human role check rather than a scope: an agent token
 * carries scopes but no role, and no scope set makes it an administrator.
 */

export interface RepositoryFormState {
  saved?: boolean;
  error?: string;
  message?: string;
  probe?: { ok: boolean; refs?: number; commit?: string; error?: string };
}

function readRepositoryForm(formData: FormData) {
  return {
    url: String(formData.get('url') ?? ''),
    default_ref: String(formData.get('default_ref') ?? ''),
    auth_token_env: String(formData.get('auth_token_env') ?? '').trim() || undefined,
  };
}

export async function saveRepositoryAction(
  _previous: RepositoryFormState,
  formData: FormData,
): Promise<RepositoryFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const space = await findSpaceByKey(session, formText(formData, 'spaceKey'));
  if (!space) return { error: 'not_found' };

  const parsed = repositorySettingsSchema.safeParse(readRepositoryForm(formData));
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  try {
    // Audited as `space.repository_set` by the service, in the same
    // transaction as the change.
    await updateSpace({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor: { type: 'user', id: session.userId },
      repository: parsed.data,
    });
  } catch (error) {
    const state = toFormState(error);
    return { error: state.error, message: state.message };
  }

  revalidatePath('/', 'layout');
  return { saved: true };
}

/**
 * Checks the URL, the ref and the token without cloning anything.
 *
 * `ls-remote` needs no disk, so an administrator finds out that a token is
 * missing here rather than from a failed check on somebody else's page.
 */
export async function testRepositoryAction(
  _previous: RepositoryFormState,
  formData: FormData,
): Promise<RepositoryFormState> {
  const session = await requireAdmin();
  if (!session) return { error: 'forbidden' };

  const space = await findSpaceByKey(session, formText(formData, 'spaceKey'));
  if (!space) return { error: 'not_found' };

  const parsed = repositorySettingsSchema.safeParse(readRepositoryForm(formData));
  if (!parsed.success) {
    return { error: 'validation', message: parsed.error.issues[0]?.message };
  }

  const probe = await probeRepository(parsed.data);

  // Testing reaches out to the URL with the named credential, which is as much
  // an act as saving the setting is, so it leaves the same kind of record.
  await recordAudit({
    workspaceId: session.workspace.id,
    actorType: 'user',
    actorId: session.userId,
    action: 'space.repository_tested',
    target: space.id,
    metadata: {
      key: space.key,
      url: parsed.data.url,
      default_ref: parsed.data.default_ref,
      auth_token_env: parsed.data.auth_token_env ?? null,
      ok: probe.ok,
    },
  });

  return { probe };
}

const accessSchema = z.object({
  spaceKey: z.string().trim().min(1).max(20),
  restricted: z.boolean(),
  userIds: z.array(z.string().min(1).max(200)).max(MAX_SPACE_MEMBERS),
});

/**
 * Who can see a space. An administrator's act.
 *
 * The member list is saved before the restriction is switched on and the
 * restriction is lifted before the list is changed, so there is no moment at
 * which the space is closed to somebody who is about to be let in.
 */
export async function saveSpaceAccessAction(
  _previous: SpaceFormState,
  formData: FormData,
): Promise<SpaceFormState> {
  const session = await getWriterSession();
  if (!session || session.role !== 'admin') return { error: 'forbidden' };

  const parsed = accessSchema.safeParse({
    spaceKey: formText(formData, 'spaceKey'),
    restricted: formData.get('restricted') === 'on',
    userIds: formData.getAll('member').filter((value): value is string => typeof value === 'string'),
  });
  if (!parsed.success) return { error: 'validation', message: parsed.error.issues[0]?.message };

  const space = await findSpaceByKey(session, parsed.data.spaceKey);
  if (!space) return { error: 'not_found' };

  const actor = { type: 'user' as const, id: session.userId };
  const setMembers = () =>
    setSpaceMembers({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor,
      userIds: parsed.data.userIds,
    });
  const setRestricted = () =>
    updateSpace({
      workspaceId: session.workspace.id,
      spaceId: space.id,
      actor,
      restricted: parsed.data.restricted,
    });

  try {
    if (parsed.data.restricted) {
      await setMembers();
      await setRestricted();
    } else {
      await setRestricted();
      await setMembers();
    }
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/', 'layout');
  return { saved: true };
}
