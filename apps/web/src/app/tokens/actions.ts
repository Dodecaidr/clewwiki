'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { issueAgentToken, revokeAgentToken } from '@/lib/agent-tokens';
import { recordAudit } from '@/lib/audit';
import { AGENT_SCOPES, normalizeScopes } from '@/lib/scopes';
import { getSessionContext } from '@/lib/session';
import { listSpaces } from '@/lib/spaces/service';

export interface TokenFormState {
  error?: 'forbidden' | 'name' | 'scopes' | 'spaces' | 'generic';
  /** Present exactly once, right after a token is issued. */
  issuedToken?: string;
  issuedName?: string;
  revoked?: boolean;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.coerce.number().int().min(0).max(3650),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
  spaceAccess: z.enum(['all', 'selected']),
  spaceIds: z.array(z.uuid()),
});

export async function createAgentTokenAction(
  _prevState: TokenFormState,
  formData: FormData,
): Promise<TokenFormState> {
  const session = await getSessionContext();
  // Authorization is re-checked here, in the action. The page-level check is a
  // UI affordance; this one is the control.
  if (!session || session.role !== 'admin') {
    return { error: 'forbidden' };
  }

  const parsed = createSchema.safeParse({
    name: formData.get('name'),
    // A missing field means the default lifetime, not "never": a token without
    // an expiry has to be asked for explicitly.
    expiresInDays: formData.get('expiresInDays') ?? '30',
    scopes: normalizeScopes(formData.getAll('scopes').map(String)),
    // A form without the field — an older page, a script — means every
    // space, which is what a token meant before spaces existed.
    spaceAccess: formData.get('spaceAccess') === 'selected' ? 'selected' : 'all',
    spaceIds: formData.getAll('spaceIds').map(String),
  });

  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    if (fieldErrors.scopes) return { error: 'scopes' };
    if (fieldErrors.name) return { error: 'name' };
    if (fieldErrors.spaceIds) return { error: 'spaces' };
    return { error: 'generic' };
  }

  // A restriction names spaces of this workspace, and at least one: an empty
  // list would issue a token that can reach nothing, which is never what the
  // person filling in the form meant.
  let spaceIds: string[] | null = null;
  let spaceKeys: string[] | null = null;
  if (parsed.data.spaceAccess === 'selected') {
    const known = await listSpaces(session.workspace.id, { includeArchived: true });
    const chosen = known.filter((space) => parsed.data.spaceIds.includes(space.id));
    if (chosen.length === 0 || chosen.length !== new Set(parsed.data.spaceIds).size) {
      return { error: 'spaces' };
    }
    spaceIds = chosen.map((space) => space.id);
    spaceKeys = chosen.map((space) => space.key);
  }

  try {
    const issued = await issueAgentToken({
      workspaceId: session.workspace.id,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresInDays: parsed.data.expiresInDays > 0 ? parsed.data.expiresInDays : null,
      spaceIds,
      createdBy: session.userId,
    });

    await recordAudit({
      workspaceId: session.workspace.id,
      actorType: 'user',
      actorId: session.userId,
      action: 'token.issued',
      target: issued.record.id,
      metadata: {
        name: issued.record.name,
        scopes: issued.record.scopes,
        spaces: spaceKeys,
        expiresAt: issued.record.expiresAt?.toISOString() ?? null,
      },
    });

    revalidatePath('/tokens');
    return { issuedToken: issued.token, issuedName: issued.record.name };
  } catch {
    return { error: 'generic' };
  }
}

const revokeSchema = z.object({ tokenId: z.uuid() });

export async function revokeAgentTokenAction(
  _prevState: TokenFormState,
  formData: FormData,
): Promise<TokenFormState> {
  const session = await getSessionContext();
  if (!session || session.role !== 'admin') {
    return { error: 'forbidden' };
  }

  const parsed = revokeSchema.safeParse({ tokenId: formData.get('tokenId') });
  if (!parsed.success) {
    return { error: 'generic' };
  }

  // The workspace id is part of the update predicate, so an admin can only
  // revoke tokens belonging to their own workspace.
  const revoked = await revokeAgentToken(session.workspace.id, parsed.data.tokenId);
  if (!revoked) {
    return { error: 'generic' };
  }

  await recordAudit({
    workspaceId: session.workspace.id,
    actorType: 'user',
    actorId: session.userId,
    action: 'token.revoked',
    target: parsed.data.tokenId,
  });

  revalidatePath('/tokens');
  return { revoked: true };
}
