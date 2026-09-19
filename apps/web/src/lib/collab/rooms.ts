import 'server-only';

import { eq } from 'drizzle-orm';
import { pageCollabStates } from '@clewwiki/db';
import * as decoding from 'lib0/decoding';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

import { recordAudit } from '../audit';
import { acquireClaim, releaseClaim } from '../claims/service';
import type { ClaimRecord } from '../claims/service';
import { getDatabase } from '../db';
import { PageServiceError, isPageServiceError } from '../pages/errors';
import { computeContentHash } from '../pages/content';
import { lastSegment } from '../pages/paths';
import { requirePage, updatePage } from '../pages/service';
import type { PageRecord } from '../pages/service';

/**
 * Live editing sessions: several people in one page at once.
 *
 * A room is one page's shared document (a Yjs `Y.Doc`), the people connected to
 * it, and **one claim held for all of them**. That last part is what keeps this
 * feature inside the product's write protocol instead of beside it:
 *
 * - People in a room do not contend with each other — the CRDT merges their
 *   edits — and the room contends with everybody else exactly as one writer
 *   would. An agent that tries to claim the page gets the `CONFLICT` it has
 *   always got, naming the session and who is in it. Nothing about an agent's
 *   protocol changes, and an agent never joins a room.
 * - Saving is an ordinary `updatePage` under the room's claim, with the person
 *   who saved as the author: validation, revisions, audit and review all see a
 *   write like any other. The server never turns the shared document into
 *   Markdown — the browser that saves does, with the same bridge that keeps an
 *   agent's page byte for byte — so the server needs no editor schema and
 *   treats the document as opaque bytes.
 * - A room that nobody has typed in stops renewing its claim. The claim lapses
 *   by its own TTL, the room becomes `paused`, and agents get the page back; a
 *   forgotten tab cannot hold a page hostage.
 *
 * The claim's holder is an identity of the room's own (`collab:<pageId>`), not
 * a person, so nothing has to change hands when whoever opened the session
 * leaves. Its label names the people present and is what presence shows.
 *
 * Rooms live in this process's memory. Like the rate limiters, that is correct
 * for one application process, which is what an instance runs; the unsaved state
 * is also written to `page_collab_states`, so a restart loses a connection and
 * not anybody's text.
 */

/** Largest single update accepted from a browser, in bytes. */
export const MAX_UPDATE_BYTES = 1024 * 1024;
/** Largest shared document kept, as an encoded state, in bytes. */
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
/** Most connections one room takes. */
export const MAX_CLIENTS_PER_ROOM = 24;
/** Most rooms this process keeps at once. */
export const MAX_ROOMS = 200;

/** How long a room goes without an edit before it stops renewing its claim. */
const IDLE_MS = 5 * 60 * 1000;
/** How often an active room renews its claim; well inside the shortest TTL. */
const RENEW_EVERY_MS = 60 * 1000;
/** How long after the last update the unsaved state is written to the database. */
const PERSIST_AFTER_MS = 2_000;

/** Stable colours for cursors, assigned by the server in order of arrival. */
const COLOURS = ['#2a78d6', '#eb6834', '#1baf7a', '#c98500', '#d55181', '#4a3aa7', '#008300', '#e34948'];

export type RoomStatus = 'live' | 'paused';

export interface RoomUser {
  id: string;
  name: string;
}

export interface Participant {
  client_id: string;
  /** The Yjs client id of that browser's document: what a cursor is keyed by. */
  y_client_id: number;
  user_id: string;
  name: string;
  colour: string;
}

export interface RoomEvent {
  event:
    | 'hello'
    | 'update'
    | 'awareness'
    | 'participants'
    | 'seed'
    | 'saved'
    | 'status'
    | 'reset';
  data: Record<string, unknown>;
}

interface RoomClient {
  id: string;
  user: RoomUser;
  yClientId: number;
  colour: string;
  send: (event: RoomEvent) => void;
  /** Ends this browser's stream from the server's side. */
  close: () => void;
}

interface RoomBase {
  version: number;
  contentHash: string;
  /**
   * The Markdown of that version. Every browser needs it, not only the one that
   * builds the document: it is what unchanged blocks are written back from,
   * byte for byte, when somebody saves.
   */
  body: string;
  title: string;
}

interface Room {
  pageId: string;
  workspaceId: string;
  spaceId: string;
  doc: Y.Doc;
  awareness: Awareness;
  clients: Map<string, RoomClient>;
  base: RoomBase;
  /** True once the document holds the content of `base`, or edits on top of it. */
  seeded: boolean;
  /** The client asked to build the document from the page. One at a time. */
  seeder: string | null;
  claim: ClaimRecord | null;
  status: RoomStatus;
  /** Who holds the page instead, while paused because somebody else does. */
  heldBy: string | null;
  dirty: boolean;
  /** Bytes of updates taken in so far: a cheap upper bound on the document's size. */
  receivedBytes: number;
  lastEditAt: number;
  colourCursor: number;
  renewTimer: ReturnType<typeof setInterval> | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

declare global {
  var __clewwikiCollabRooms: Map<string, Room> | undefined;
}

function rooms(): Map<string, Room> {
  globalThis.__clewwikiCollabRooms ??= new Map();
  return globalThis.__clewwikiCollabRooms;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

export function fromBase64(value: string, limit: number): Uint8Array {
  // Four characters of base64 carry three bytes; refuse by length before decoding.
  if (value.length > Math.ceil(limit / 3) * 4 + 4) {
    throw new PageServiceError('validation', 'The update is larger than a live session accepts', {
      max_bytes: limit,
    });
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new PageServiceError('validation', 'The update is not base64');
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function sessionActor(room: Pick<Room, 'pageId' | 'clients'>) {
  const names = [...new Set([...room.clients.values()].map((client) => client.user.name))];
  return {
    type: 'user' as const,
    id: `collab:${room.pageId}`,
    label: names.length === 0 ? 'Live session' : `Live session: ${names.join(', ')}`.slice(0, 200),
  };
}

function participantsOf(room: Room): Participant[] {
  return [...room.clients.values()].map((client) => ({
    client_id: client.id,
    y_client_id: client.yClientId,
    user_id: client.user.id,
    name: client.user.name,
    colour: client.colour,
  }));
}

function broadcast(room: Room, event: RoomEvent, except?: string): void {
  for (const client of room.clients.values()) {
    if (client.id !== except) client.send(event);
  }
}

function statusEvent(room: Room): RoomEvent {
  return { event: 'status', data: { status: room.status, held_by: room.heldBy } };
}

/* ------------------------------------------------------------------ */
/* Claim                                                               */
/* ------------------------------------------------------------------ */

/**
 * Takes, or extends, the room's claim. Re-acquiring as the same holder is how a
 * claim is renewed *and* how its label is brought up to date with who is in the
 * room. A conflict — somebody else holds the page — pauses the room and says who.
 */
async function holdClaim(room: Room): Promise<boolean> {
  try {
    const { claim } = await acquireClaim({
      workspaceId: room.workspaceId,
      pageId: room.pageId,
      actor: sessionActor(room),
    });
    // A claim taken afresh starts from the page as it is now. If that is not
    // the page this room was editing, somebody wrote while the room had no
    // claim, and the room's document is about a text that no longer exists.
    if (claim.baseContentHash !== room.base.contentHash) {
      await releaseClaim({
        workspaceId: room.workspaceId,
        claimId: claim.id,
        actor: sessionActor(room),
      }).catch(() => undefined);
      resetRoom(room, 'page_changed');
      return false;
    }
    room.claim = claim;
    room.status = 'live';
    room.heldBy = null;
    return true;
  } catch (error) {
    if (!isPageServiceError(error)) throw error;
    room.claim = null;
    room.status = 'paused';
    const holder = error.details?.['held_by'];
    room.heldBy = typeof holder === 'string' ? holder : null;
    return false;
  }
}

async function dropClaim(room: Room): Promise<void> {
  const claim = room.claim;
  room.claim = null;
  if (!claim) return;
  await releaseClaim({
    workspaceId: room.workspaceId,
    claimId: claim.id,
    actor: sessionActor(room),
  }).catch(() => undefined);
}

/**
 * One turn of the room's clock: give the page back if nobody is typing and
 * nothing is unsaved, otherwise extend the claim.
 */
async function renewRoom(room: Room): Promise<void> {
  if (room.status !== 'live') return;
  if (Date.now() - room.lastEditAt > IDLE_MS && !room.dirty) {
    await dropClaim(room);
    room.status = 'paused';
    room.heldBy = null;
    broadcast(room, statusEvent(room));
    return;
  }
  const before = room.status;
  await holdClaim(room);
  if (rooms().has(room.pageId) && room.status !== before) broadcast(room, statusEvent(room));
}

function startRenewing(room: Room): void {
  if (room.renewTimer) return;
  room.renewTimer = setInterval(() => {
    void renewRoom(room).catch((error: unknown) => console.error('[collab] claim renewal failed', error));
  }, RENEW_EVERY_MS);
  // A timer must not keep a process alive that is otherwise done.
  room.renewTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

async function persist(room: Room): Promise<void> {
  if (!room.seeded || !room.dirty) return;
  const state = Y.encodeStateAsUpdate(room.doc);
  if (state.byteLength > MAX_STATE_BYTES) return;
  const values = {
    pageId: room.pageId,
    workspaceId: room.workspaceId,
    baseVersion: room.base.version,
    baseContentHash: room.base.contentHash,
    state,
    updatedAt: new Date(),
  };
  await getDatabase()
    .insert(pageCollabStates)
    .values(values)
    .onConflictDoUpdate({ target: pageCollabStates.pageId, set: values });
}

function schedulePersist(room: Room): void {
  if (room.persistTimer) return;
  room.persistTimer = setTimeout(() => {
    room.persistTimer = null;
    void persist(room).catch((error: unknown) => console.error('[collab] persist failed', error));
  }, PERSIST_AFTER_MS);
  room.persistTimer.unref?.();
}

async function forgetPersisted(pageId: string): Promise<void> {
  await getDatabase().delete(pageCollabStates).where(eq(pageCollabStates.pageId, pageId));
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function newRoom(page: PageRecord): Room {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // The server has no cursor of its own.
  awareness.setLocalState(null);
  return {
    pageId: page.id,
    workspaceId: page.workspaceId,
    spaceId: page.spaceId,
    doc,
    awareness,
    clients: new Map(),
    base: { version: page.version, contentHash: page.contentHash, body: page.body, title: page.title },
    seeded: false,
    seeder: null,
    claim: null,
    status: 'paused',
    heldBy: null,
    dirty: false,
    receivedBytes: 0,
    lastEditAt: Date.now(),
    colourCursor: 0,
    renewTimer: null,
    persistTimer: null,
  };
}

function destroyRoom(room: Room): void {
  if (room.renewTimer) clearInterval(room.renewTimer);
  if (room.persistTimer) clearTimeout(room.persistTimer);
  room.renewTimer = null;
  room.persistTimer = null;
  room.awareness.destroy();
  room.doc.destroy();
  rooms().delete(room.pageId);
}

/**
 * Ends a room whose document no longer describes the page — the page was
 * written by somebody else while the room held no claim. Everybody is told to
 * load the page again; there is nothing to merge a CRDT of the old text into.
 */
function resetRoom(room: Room, reason: string): void {
  broadcast(room, { event: 'reset', data: { reason } });
  void forgetPersisted(room.pageId).catch(() => undefined);
  destroyRoom(room);
}

async function openRoom(page: PageRecord): Promise<Room> {
  const existing = rooms().get(page.id);
  if (existing) return existing;
  if (rooms().size >= MAX_ROOMS) {
    throw new PageServiceError('conflict', 'This instance has too many live editing sessions open', {
      reason: 'too_many_rooms',
    });
  }

  const room = newRoom(page);
  const [saved] = await getDatabase()
    .select({
      baseContentHash: pageCollabStates.baseContentHash,
      state: pageCollabStates.state,
    })
    .from(pageCollabStates)
    .where(eq(pageCollabStates.pageId, page.id))
    .limit(1);
  if (saved) {
    if (saved.baseContentHash === page.contentHash) {
      // Somebody's unsaved text, against the very version it was typed over.
      Y.applyUpdate(room.doc, saved.state);
      room.receivedBytes = saved.state.byteLength;
      room.seeded = true;
      room.dirty = true;
    } else {
      await forgetPersisted(page.id);
    }
  }

  // Two requests can both find no room; the second one in keeps the first's.
  const raced = rooms().get(page.id);
  if (raced) {
    room.doc.destroy();
    return raced;
  }
  rooms().set(page.id, room);

  room.awareness.on(
    'update',
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      broadcast(
        room,
        { event: 'awareness', data: { update: toBase64(encodeAwarenessUpdate(room.awareness, changed)) } },
        typeof origin === 'string' ? origin : undefined,
      );
    },
  );
  return room;
}

export interface JoinInput {
  workspaceId: string;
  pageId: string;
  clientId: string;
  yClientId: number;
  user: RoomUser;
  send: (event: RoomEvent) => void;
  close: () => void;
}

/** Connects a browser to the room of a page, opening the room if it is the first. */
export async function joinRoom(input: JoinInput): Promise<void> {
  const page = await requirePage(input.workspaceId, input.pageId);
  const room = await openRoom(page);

  if (room.clients.size >= MAX_CLIENTS_PER_ROOM && !room.clients.has(input.clientId)) {
    throw new PageServiceError('conflict', 'This editing session is full', { reason: 'room_full' });
  }

  const previous = room.clients.get(input.clientId);
  const client: RoomClient = {
    id: input.clientId,
    user: input.user,
    yClientId: input.yClientId,
    colour: previous?.colour ?? COLOURS[room.colourCursor++ % COLOURS.length]!,
    send: input.send,
    close: input.close,
  };
  room.clients.set(client.id, client);

  // Joining is interest in editing: take the claim if the room has none, and
  // refresh its label with the new name either way.
  await holdClaim(room);
  if (!rooms().has(room.pageId)) return; // reset by holdClaim: the page had changed
  startRenewing(room);

  if (!room.seeded && room.seeder === null) room.seeder = client.id;

  client.send({
    event: 'hello',
    data: {
      client_id: client.id,
      base: {
        version: room.base.version,
        content_hash: room.base.contentHash,
        body: room.base.body,
        title: room.base.title,
      },
      seeded: room.seeded,
      seed: room.seeder === client.id,
      state: room.seeded ? toBase64(Y.encodeStateAsUpdate(room.doc)) : null,
      awareness: toBase64(
        encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
      ),
      unsaved: room.dirty,
      status: room.status,
      held_by: room.heldBy,
      participants: participantsOf(room),
    },
  });
  broadcast(room, { event: 'participants', data: { participants: participantsOf(room) } }, client.id);
}

/** Disconnects a browser. The last one out leaves the room to be closed. */
export async function leaveRoom(pageId: string, clientId: string, send?: RoomClient['send']): Promise<void> {
  const room = rooms().get(pageId);
  const client = room?.clients.get(clientId);
  if (!room || !client) return;
  // A reconnect replaces the connection under the same id; the old stream
  // closing afterwards must not take the new one with it.
  if (send && client.send !== send) return;

  room.clients.delete(clientId);
  removeAwarenessStates(room.awareness, [client.yClientId], 'server');

  if (room.seeder === clientId) {
    room.seeder = null;
    const next = room.seeded ? undefined : room.clients.values().next().value;
    if (next) {
      room.seeder = next.id;
      next.send({ event: 'seed', data: {} });
    }
  }

  if (room.clients.size > 0) {
    broadcast(room, { event: 'participants', data: { participants: participantsOf(room) } });
    if (room.status === 'live') await holdClaim(room);
    return;
  }

  // Nobody left. Unsaved text is written down and the claim is left to lapse by
  // its TTL, so whoever comes back within it finds the page still theirs; a
  // clean room gives the page back at once.
  if (room.dirty) {
    await persist(room).catch((error: unknown) => console.error('[collab] persist failed', error));
  } else {
    await dropClaim(room);
  }
  destroyRoom(room);
}

function requireClient(pageId: string, clientId: string, userId: string): { room: Room; client: RoomClient } {
  const room = rooms().get(pageId);
  const client = room?.clients.get(clientId);
  // One answer for "no such room", "no such client" and "not your client".
  if (!room || !client || client.user.id !== userId) {
    throw new PageServiceError('not_found', 'Not connected to this editing session', {
      reason: 'not_joined',
    });
  }
  return { room, client };
}

/* ------------------------------------------------------------------ */
/* Updates                                                             */
/* ------------------------------------------------------------------ */

export interface UpdateInput {
  pageId: string;
  clientId: string;
  userId: string;
  update: string;
  /** True for the update that builds the document from the page. */
  seed?: boolean;
}

/** Applies a browser's document update and passes it on to everybody else. */
export async function applyRoomUpdate(input: UpdateInput): Promise<void> {
  const { room, client } = requireClient(input.pageId, input.clientId, input.userId);
  const update = fromBase64(input.update, MAX_UPDATE_BYTES);

  if (input.seed) {
    // Building the document twice would double the page. Only the client that
    // was asked may seed, and only while nothing has.
    if (room.seeded || room.seeder !== client.id) return;
  } else if (!room.seeded) {
    throw new PageServiceError('conflict', 'The session has no document yet', { reason: 'not_seeded' });
  }

  if (room.status !== 'live' && !(await resumeRoom(input.pageId, input.clientId, input.userId))) {
    throw new PageServiceError('conflict', 'The page is held by somebody else; this session is paused', {
      reason: 'paused',
      held_by: room.heldBy,
    });
  }

  // Checked before the update is applied: a CRDT cannot take an update back.
  if (room.receivedBytes + update.byteLength > MAX_STATE_BYTES) {
    throw new PageServiceError(
      'validation',
      'This editing session has grown too large. Save, close the editor and open it again.',
      { reason: 'session_too_large' },
    );
  }
  try {
    Y.applyUpdate(room.doc, update, client.id);
  } catch {
    throw new PageServiceError('validation', 'The update could not be applied');
  }
  room.receivedBytes += update.byteLength;

  if (input.seed) {
    room.seeded = true;
    room.seeder = null;
  } else {
    room.dirty = true;
    room.lastEditAt = Date.now();
    schedulePersist(room);
  }
  broadcast(room, { event: 'update', data: { update: input.update, from: client.id } }, client.id);
}

/** The Yjs client ids an awareness update speaks for. */
function awarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder); // clock
    decoding.readVarString(decoder); // state
  }
  return ids;
}

/** Relays a cursor. A browser may speak for its own cursor and nobody else's. */
export function applyRoomAwareness(input: Omit<UpdateInput, 'seed'>): void {
  const { room, client } = requireClient(input.pageId, input.clientId, input.userId);
  const update = fromBase64(input.update, 64 * 1024);
  let ids: number[];
  try {
    ids = awarenessClientIds(update);
  } catch {
    throw new PageServiceError('validation', 'The awareness update could not be read');
  }
  if (ids.some((id) => id !== client.yClientId)) {
    throw new PageServiceError('forbidden', 'A client may only report its own cursor');
  }
  applyAwarenessUpdate(room.awareness, update, client.id);
}

/** Takes the claim back for a paused room. False when somebody else holds the page. */
export async function resumeRoom(pageId: string, clientId: string, userId: string): Promise<boolean> {
  const { room } = requireClient(pageId, clientId, userId);
  if (room.status === 'live') return true;
  const live = await holdClaim(room);
  if (!rooms().has(pageId)) return false;
  room.lastEditAt = Date.now();
  broadcast(room, statusEvent(room));
  return live;
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

export interface SaveInput {
  workspaceId: string;
  pageId: string;
  clientId: string;
  user: RoomUser;
  /** The Markdown the saving browser serialised the shared document to. */
  body: string;
  /**
   * The state vector of the saving browser's document when it serialised. What
   * the room has beyond it was typed by somebody else in the meantime and is
   * not in `body`, so the room stays unsaved.
   */
  stateVector: string;
  title?: string;
  summary?: string | null;
  /** The rest of the page form, passed through to the write unchanged. */
  kind?: PageRecord['kind'];
  parentId?: string | null;
  path?: string;
}

export interface SaveResult {
  page: PageRecord;
  /** False when the page already had exactly this content and nothing was written. */
  written: boolean;
}

/**
 * Writes the session's text to the page, as a revision by whoever saved.
 *
 * Several browsers autosave on the same idle timer, so the same text arrives
 * more than once; a save that would change nothing writes nothing, or the
 * history would fill with identical revisions.
 */
export async function saveRoom(input: SaveInput): Promise<SaveResult> {
  const { room } = requireClient(input.pageId, input.clientId, input.user.id);
  if (room.status !== 'live' || !room.claim) {
    if (!(await resumeRoom(input.pageId, input.clientId, input.user.id)) || !room.claim) {
      throw new PageServiceError('conflict', 'The page is held by somebody else; this session is paused', {
        reason: 'paused',
        held_by: room.heldBy,
      });
    }
  }

  let covered: boolean;
  try {
    // An update holding nothing is two bytes: no structs, no deletions.
    const missing = Y.encodeStateAsUpdate(room.doc, fromBase64(input.stateVector, 64 * 1024));
    covered = missing.byteLength <= 2;
  } catch {
    throw new PageServiceError('validation', 'The state vector could not be read');
  }

  const current = await requirePage(input.workspaceId, input.pageId);
  const unchanged =
    computeContentHash(input.body) === current.contentHash &&
    (input.title === undefined || input.title === current.title) &&
    (input.summary === undefined || (input.summary ?? null) === current.summary) &&
    (input.kind === undefined || input.kind === current.kind) &&
    (input.parentId === undefined || (input.parentId ?? null) === current.parentId) &&
    // The form always carries the page's segment; only a different one is a move.
    (input.path === undefined || input.path === '' || input.path === lastSegment(current.path));
  if (unchanged) {
    if (covered) {
      room.dirty = false;
      await forgetPersisted(room.pageId).catch(() => undefined);
    }
    return { page: current, written: false };
  }

  const page = await updatePage({
    workspaceId: input.workspaceId,
    pageId: input.pageId,
    actor: { type: 'user', id: input.user.id },
    claimActor: { type: 'user', id: sessionActor(room).id },
    body: input.body,
    title: input.title,
    summary: input.summary,
    kind: input.kind,
    parentId: input.parentId,
    path: input.path === '' ? undefined : input.path,
    claimId: room.claim.id,
    baseContentHash: room.base.contentHash,
  });

  room.base = { version: page.version, contentHash: page.contentHash, body: page.body, title: page.title };
  room.claim = { ...room.claim, baseContentHash: page.contentHash };
  room.lastEditAt = Date.now();
  if (covered) {
    room.dirty = false;
    await forgetPersisted(room.pageId).catch(() => undefined);
  } else {
    // The stored state was against the old version; re-write it against this one.
    await persist(room).catch(() => undefined);
  }

  await recordAudit({
    workspaceId: input.workspaceId,
    actorType: 'user',
    actorId: input.user.id,
    action: 'collab.saved',
    target: page.id,
    metadata: {
      result: 'saved',
      version: page.version,
      participants: [...new Set([...room.clients.values()].map((client) => client.user.id))],
    },
  }).catch(() => undefined);

  broadcast(room, {
    event: 'saved',
    data: {
      version: page.version,
      content_hash: page.contentHash,
      title: page.title,
      body: page.body,
      unsaved: room.dirty,
      by: { user_id: input.user.id, name: input.user.name },
    },
  });
  return { page, written: true };
}

/* ------------------------------------------------------------------ */
/* For tests and for the page view                                     */
/* ------------------------------------------------------------------ */

/** Who is editing a page right now; empty when nobody is. */
export function roomParticipants(pageId: string): Participant[] {
  const room = rooms().get(pageId);
  return room ? participantsOf(room) : [];
}

/**
 * Ends every live session in a space, keeping what was typed.
 *
 * Called when who may see the space changes. A stream that is already open was
 * authorised when it was opened, and would go on delivering a restricted
 * space's edits to somebody who has just been removed from it. Rather than work
 * out who may stay, everybody is disconnected: a browser reconnects by itself
 * and is authorised again — as a member, into the same document, or not at all.
 */
export async function closeRoomsInSpace(spaceId: string): Promise<number> {
  const affected = [...rooms().values()].filter((room) => room.spaceId === spaceId);
  for (const room of affected) {
    await persist(room).catch((error: unknown) => console.error('[collab] persist failed', error));
    const clients = [...room.clients.values()];
    // The room is gone before the streams are, so that their closing finds
    // nothing to leave and the claim is not released under whoever comes back.
    destroyRoom(room);
    for (const client of clients) client.close();
  }
  return affected.length;
}

/**
 * Ends the sessions of particular pages, keeping what was typed — for pages
 * that have gone to another space. A room remembers the space it was opened in
 * and the people it let in there; both are out of date once the page has moved,
 * and everybody is authorised again when their browser reconnects.
 */
export async function closeRoomsForPages(pageIds: readonly string[]): Promise<number> {
  const wanted = new Set(pageIds);
  const affected = [...rooms().values()].filter((room) => wanted.has(room.pageId));
  for (const room of affected) {
    await persist(room).catch((error: unknown) => console.error('[collab] persist failed', error));
    const clients = [...room.clients.values()];
    destroyRoom(room);
    for (const client of clients) client.close();
  }
  return affected.length;
}

/** Closes every room without saving anything. Tests use it; nothing in the application does. */
export async function closeAllRooms(): Promise<void> {
  for (const room of [...rooms().values()]) {
    await dropClaim(room);
    destroyRoom(room);
  }
}

/** Moves a room's idle clock the way time would, then runs one turn of it. Tests only. */
export async function ageRoomForTests(pageId: string, ms: number): Promise<void> {
  const room = rooms().get(pageId);
  if (!room) return;
  room.lastEditAt -= ms;
  await renewRoom(room);
}

/** Writes a room's unsaved state now instead of after the debounce. Tests only. */
export async function flushRoomForTests(pageId: string): Promise<void> {
  const room = rooms().get(pageId);
  if (room) await persist(room);
}
