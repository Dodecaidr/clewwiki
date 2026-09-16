import type { ActorKind } from '@clewwiki/db';

import type { ClaimNoteRecord, ClaimRecord, PresenceEntry } from './service';

/**
 * Wire shapes for claims and notes, in the snake_case `docs/mcp.md` describes.
 *
 * As with pages, they are produced in one place so that REST today and the MCP
 * wrapper later cannot answer with two different versions of the same
 * resource. A note's text is content written by a caller: it travels with its
 * author and its timestamps, and is never merged into anything that reads as
 * an instruction.
 */

export interface ClaimNoteResource {
  note_id: string;
  text: string;
  author: string;
  author_type: ActorKind;
  created_at: string;
  expires_at: string;
}

export interface ClaimResource {
  claim_id: string;
  page_id: string;
  section_id?: string;
  held_by: string;
  actor_type: ActorKind;
  holder_id: string;
  since: string;
  expires_at: string;
  base_content_hash: string;
  path?: string;
  title?: string;
  notes?: ClaimNoteResource[];
}

export function toClaimNoteResource(note: ClaimNoteRecord): ClaimNoteResource {
  return {
    note_id: note.id,
    text: note.text,
    author: note.authorLabel,
    author_type: note.authorType,
    created_at: note.createdAt.toISOString(),
    expires_at: note.expiresAt.toISOString(),
  };
}

export interface ClaimResourceExtras {
  path?: string;
  title?: string;
  notes?: ClaimNoteRecord[];
}

export function toClaimResource(
  claim: ClaimRecord,
  extras: ClaimResourceExtras = {},
): ClaimResource {
  const resource: ClaimResource = {
    claim_id: claim.id,
    page_id: claim.pageId,
    held_by: claim.holderLabel,
    actor_type: claim.holderType,
    holder_id: claim.holderId,
    since: claim.createdAt.toISOString(),
    expires_at: claim.expiresAt.toISOString(),
    base_content_hash: claim.baseContentHash,
  };

  // Omitted rather than null when the claim covers the whole page: the
  // contract spells the field `section_id?`, and "absent" is what a page-level
  // claim means.
  if (claim.sectionId !== null) resource.section_id = claim.sectionId;
  if (extras.path !== undefined) resource.path = extras.path;
  if (extras.title !== undefined) resource.title = extras.title;
  if (extras.notes !== undefined) resource.notes = extras.notes.map(toClaimNoteResource);
  return resource;
}

export function toPresenceResource(entry: PresenceEntry): ClaimResource {
  return toClaimResource(entry.claim, {
    path: entry.path,
    title: entry.title,
    notes: entry.notes,
  });
}
