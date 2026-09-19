import 'server-only';

import type { NextResponse } from 'next/server';

import { auth } from '../auth';
import { checkSessionMutation, checkUploadMutation } from '../csrf';
import { getAuthBaseUrl } from '../env';
import { apiError } from '../api-response';
import { visibleSpaceIdsForUser } from '../spaces/visibility';
import { getMembershipForUser, getWorkspaceById } from '../workspace';
import type { ImportActor } from './service';
import type { UserIdentity } from '../api-auth';

/**
 * The gate every import endpoint passes through.
 *
 * It is not `authorizePagesRequest`, and the difference is the point: an import
 * is available to a signed-in person and to nobody else. A request carrying a
 * bearer token is refused with `forbidden` and a message that says why, rather
 * than being evaluated for scopes it could never satisfy.
 *
 * The reason is the review step. An import stages somebody else's documents and
 * a person decides what of it becomes pages; a token has no way to perform that
 * judgement, and a scope that let it skip the judgement would make the staging
 * pointless. `docs/security.md` states the same rule for operators.
 *
 * Both membership roles may import — writing pages is what an editor is for —
 * and the role is still checked here rather than assumed from the fact that
 * there are only two of them.
 */

export type ImportAuthResult =
  | { ok: true; identity: UserIdentity; actor: ImportActor; workspaceId: string }
  | { ok: false; response: NextResponse };

export interface ImportAuthOptions {
  /** True for the multipart endpoint, which cannot be JSON. */
  upload?: boolean;
}

export async function authorizeImportRequest(
  request: Request,
  options: ImportAuthOptions = {},
): Promise<ImportAuthResult> {
  if ((request.headers.get('authorization') ?? '').toLowerCase().startsWith('bearer ')) {
    return {
      ok: false,
      response: apiError(
        403,
        'forbidden',
        'Imports are available to signed-in people only. An import stages another system’s documents for a person to review before anything is written, and an agent token cannot perform that review.',
      ),
    };
  }

  const csrf = options.upload
    ? checkUploadMutation(request, getAuthBaseUrl())
    : checkSessionMutation(request, getAuthBaseUrl());
  if (!csrf.ok) {
    return { ok: false, response: apiError(403, 'forbidden', csrf.message) };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { ok: false, response: apiError(401, 'unauthenticated', 'Authentication required') };
  }

  const membership = await getMembershipForUser(session.user.id);
  if (!membership) {
    return {
      ok: false,
      response: apiError(403, 'no_workspace', 'Account is not a member of any workspace'),
    };
  }
  if (membership.role !== 'admin' && membership.role !== 'editor') {
    return {
      ok: false,
      response: apiError(403, 'forbidden', 'Only administrators and editors can import'),
    };
  }

  const workspace = await getWorkspaceById(membership.workspaceId);
  if (!workspace) {
    return {
      ok: false,
      response: apiError(403, 'no_workspace', 'Account is not a member of any workspace'),
    };
  }

  return {
    ok: true,
    identity: {
      type: 'user',
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: membership.role,
      workspaceId: workspace.id,
      workspace,
      spaceIds: await visibleSpaceIdsForUser(workspace.id, session.user.id, membership.role),
    },
    actor: { type: 'user', id: session.user.id },
    workspaceId: workspace.id,
  };
}
