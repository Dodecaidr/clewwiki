'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';

import {
  STREAM_STATES,
  createRelease,
  createStream,
  ensureDocsPage,
  shipRelease,
  syncStreams,
  updateStream,
} from '@/lib/development/service';
import { PageServiceError } from '@/lib/pages/errors';
import { getWriterSession } from '@/lib/session';
import { spaceDevelopmentHref, spaceStreamHref } from '@/lib/spaces/urls';
import { findSpaceByKey } from '@/lib/spaces/visibility';

export interface DevelopmentFormState {
  error?: string;
  message?: string;
  details?: string[];
}

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

async function context(formData: FormData) {
  const session = await getWriterSession();
  if (!session) return null;
  const space = await findSpaceByKey(session, text(formData, 'spaceKey'));
  if (!space) return null;
  return { session, space, actor: { type: 'user' as const, id: session.userId } };
}

function failure(error: unknown): DevelopmentFormState {
  if (error instanceof PageServiceError) {
    const missing = (error.details?.missing as string[] | undefined) ?? undefined;
    return { error: error.code, message: error.message, details: missing };
  }
  console.error('[development] action failed', error);
  return { error: 'generic' };
}

export async function syncStreamsAction(_previous: DevelopmentFormState, formData: FormData): Promise<DevelopmentFormState> {
  const ctx = await context(formData);
  if (!ctx) return { error: 'forbidden' };
  try {
    const result = await syncStreams(ctx.session.workspace.id, ctx.space.id, ctx.actor);
    const t = await getTranslations('development');
    revalidatePath(spaceDevelopmentHref(ctx.space.key));
    return {
      message: t('syncDone', {
        created: result.created.length,
        merged: result.merged.length,
        gone: result.gone.length,
        skipped: result.skippedHistory,
      }),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function createStreamAction(_previous: DevelopmentFormState, formData: FormData): Promise<DevelopmentFormState> {
  const ctx = await context(formData);
  if (!ctx) return { error: 'forbidden' };
  let id: string;
  try {
    const stream = await createStream(ctx.session.workspace.id, ctx.space.id, ctx.actor, {
      title: text(formData, 'title'),
      ref: text(formData, 'branch') || null,
      state: 'planned',
      goal: text(formData, 'goal'),
      releaseId: text(formData, 'releaseId') || null,
    });
    id = stream.id;
  } catch (error) {
    return failure(error);
  }
  redirect(spaceStreamHref(ctx.space.key, id));
}

export async function createReleaseAction(_previous: DevelopmentFormState, formData: FormData): Promise<DevelopmentFormState> {
  const ctx = await context(formData);
  if (!ctx) return { error: 'forbidden' };
  try {
    await createRelease(ctx.session.workspace.id, ctx.space.id, ctx.actor, {
      name: text(formData, 'name'),
      dueOn: text(formData, 'dueOn') || null,
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(spaceDevelopmentHref(ctx.space.key));
  return {};
}

export async function shipReleaseAction(_previous: DevelopmentFormState, formData: FormData): Promise<DevelopmentFormState> {
  const ctx = await context(formData);
  if (!ctx) return { error: 'forbidden' };
  const releaseId = z.uuid().safeParse(text(formData, 'releaseId'));
  if (!releaseId.success) return { error: 'not_found' };
  try {
    await shipRelease(ctx.session.workspace.id, releaseId.data, ctx.actor, text(formData, 'force') === 'yes');
  } catch (error) {
    return failure(error);
  }
  revalidatePath(spaceDevelopmentHref(ctx.space.key));
  return {};
}

const updateSchema = z.object({
  streamId: z.uuid(),
  title: z.string().optional(),
  branch: z.string().optional(),
  state: z.enum(STREAM_STATES).optional(),
  goal: z.string().optional(),
  issueKeys: z.string().optional(),
  releaseId: z.string().optional(),
});

export async function updateStreamAction(_previous: DevelopmentFormState, formData: FormData): Promise<DevelopmentFormState> {
  const ctx = await context(formData);
  if (!ctx) return { error: 'forbidden' };
  const field = (name: string) => (formData.has(name) ? text(formData, name) : undefined);
  const parsed = updateSchema.safeParse({
    streamId: text(formData, 'streamId'),
    title: field('title'),
    branch: field('branch'),
    state: field('state') || undefined,
    goal: field('goal'),
    issueKeys: field('issueKeys'),
    releaseId: field('releaseId'),
  });
  if (!parsed.success) return { error: 'validation', message: parsed.error.issues[0]?.message };
  try {
    await updateStream(ctx.session.workspace.id, parsed.data.streamId, ctx.actor, {
      title: parsed.data.title,
      ref: parsed.data.branch === undefined ? undefined : parsed.data.branch || null,
      state: parsed.data.state,
      goal: parsed.data.goal,
      issueKeys: parsed.data.issueKeys === undefined ? undefined : parsed.data.issueKeys.split(/[\s,;]+/).filter(Boolean),
      releaseId: parsed.data.releaseId === undefined ? undefined : parsed.data.releaseId || null,
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(spaceDevelopmentHref(ctx.space.key), 'layout');
  return { message: 'saved' };
}

export async function ensureDocsPageAction(_previous: DevelopmentFormState, formData: FormData): Promise<DevelopmentFormState> {
  const ctx = await context(formData);
  if (!ctx) return { error: 'forbidden' };
  const streamId = z.uuid().safeParse(text(formData, 'streamId'));
  if (!streamId.success) return { error: 'not_found' };
  const t = await getTranslations('development');
  try {
    await ensureDocsPage(ctx.session.workspace.id, streamId.data, ctx.actor, {
      rootTitle: t('docsRootTitle'),
      rootBody: t('docsRootBody'),
      pageTitle: (name) => t('docsPageTitle', { name }),
      pageBody: (goal) => t('docsPageBody', { goal }),
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(spaceStreamHref(ctx.space.key, streamId.data));
  revalidatePath('/', 'layout');
  return {};
}
