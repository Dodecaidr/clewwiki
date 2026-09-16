'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { issueAgentToken, revokeAgentToken } from '@/lib/agent-tokens';
import { recordAudit } from '@/lib/audit';
import { AGENT_SCOPES, normalizeScopes } from '@/lib/scopes';
import { getSessionContext } from '@/lib/session';

export interface TokenFormState {
  error?: 'forbidden' | 'name' | 'scopes' | 'generic';
  /** Present exactly once, right after a token is issued. */
  issuedToken?: string;
  issuedName?: string;
  revoked?: boolean;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.coerce.number().int().min(0).max(3650),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
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
    expiresInDays: formData.get('expiresInDays') ?? '0',
    scopes: normalizeScopes(formData.getAll('scopes').map(String)),
  });

  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    if (fieldErrors.scopes) return { error: 'scopes' };
    if (fieldErrors.name) return { error: 'name' };
    return { error: 'generic' };
  }

  try {
    const issued = await issueAgentToken({
      workspaceId: session.workspace.id,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresInDays: parsed.data.expiresInDays > 0 ? parsed.data.expiresInDays : null,
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
