import 'server-only';

import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { agentTokens, memberships, mentions, users } from '@clewwiki/db';

import { getDatabase } from '../db';
import type { DbExecutor } from '../db';
import { mentionKey, mentionSyntax, parseMentions } from './parse';

/**
 * Turning the names in a text into the people and agents they name.
 *
 * Resolved once, when the text is posted, inside the transaction that posts it
 * — a mention is part of the message, and a message that failed to be written
 * addressed nobody. A name matches a member of the workspace by their display
 * name and a live agent token by its name, ignoring case. Two members with the
 * same name are both addressed: the alternative is addressing neither, and a
 * question that reaches one person too many is a smaller failure than one that
 * reaches nobody.
 *
 * A name that matches nobody is not an error. Text is text, `@` appears in it
 * for other reasons, and refusing a comment over it would make the feature
 * something people work around. What resolved comes back to the caller
 * (`mentioned`), so an agent can tell that its `@gateway-team` reached no one.
 */

export type MentionActor = { type: 'user' | 'agent'; id: string };

export interface MentionedActor {
  type: 'user' | 'agent';
  id: string;
  label: string;
}

/** Everybody who can be addressed in this workspace: its members and its live tokens. */
export async function listMentionable(
  workspaceId: string,
  executor: DbExecutor = getDatabase(),
  now: Date = new Date(),
): Promise<MentionedActor[]> {
  const [people, agents] = await Promise.all([
    executor
      .select({ id: users.id, label: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, workspaceId)),
    executor
      .select({ id: agentTokens.id, label: agentTokens.name })
      .from(agentTokens)
      .where(
        and(
          eq(agentTokens.workspaceId, workspaceId),
          isNull(agentTokens.revokedAt),
          or(isNull(agentTokens.expiresAt), gt(agentTokens.expiresAt, now)),
        ),
      ),
  ]);
  return [
    ...people.map((row) => ({ type: 'user' as const, ...row })),
    ...agents.map((row) => ({ type: 'agent' as const, ...row })),
  ].sort((a, b) => a.label.localeCompare(b.label));
}

export interface RecordMentionsInput {
  workspaceId: string;
  source: { messageId: string } | { commentId: string };
  /** Whoever wrote the text. Nobody is told that they mentioned themselves. */
  author: MentionActor;
  body: string;
}

/** Stores who `body` addresses, and returns them. Call it inside the transaction that wrote the text. */
export async function recordMentions(executor: DbExecutor, input: RecordMentionsInput): Promise<MentionedActor[]> {
  const names = parseMentions(input.body);
  if (names.length === 0) return [];

  const wanted = new Set(names.map(mentionKey));
  const resolved = (await listMentionable(input.workspaceId, executor)).filter(
    (actor) =>
      wanted.has(mentionKey(actor.label)) && !(actor.type === input.author.type && actor.id === input.author.id),
  );
  if (resolved.length === 0) return [];

  await executor
    .insert(mentions)
    .values(
      resolved.map((actor) => ({
        workspaceId: input.workspaceId,
        messageId: 'messageId' in input.source ? input.source.messageId : null,
        commentId: 'commentId' in input.source ? input.source.commentId : null,
        actorType: actor.type,
        actorId: actor.id,
      })),
    )
    .onConflictDoNothing();
  return resolved;
}

/** The names a form can offer, already spelled the way a mention is written. */
export async function listMentionSyntax(workspaceId: string, except?: MentionActor): Promise<string[]> {
  const all = await listMentionable(workspaceId);
  return [
    ...new Set(
      all
        .filter((actor) => !(except && actor.type === except.type && actor.id === except.id))
        .map((actor) => mentionSyntax(actor.label)),
    ),
  ];
}
