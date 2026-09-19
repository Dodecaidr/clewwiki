import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * The browser's end of a live editing session.
 *
 * It is a Yjs provider whose transport is the plainest one a browser has: an
 * `EventSource` for what arrives, `fetch` for what is sent. There is no socket
 * to keep alive and nothing for a reverse proxy to upgrade; when the stream
 * drops the browser reconnects it by itself, the server greets the connection
 * again, and the two sides exchange what each is missing.
 *
 * Three things here are not what a generic provider would do:
 *
 * - **The document is built once.** A room starts empty, and whichever browser
 *   the server asks (`hello.seed`, or a later `seed` event) builds it from the
 *   page. Everybody else waits for it. Two browsers building the same page
 *   would produce the page twice.
 * - **Updates leave in order, one request at a time**, merged while one is in
 *   flight. A typing burst becomes a handful of requests, and a refusal — the
 *   session is paused because somebody else holds the page — stops the queue
 *   with the edits still in it instead of dropping them.
 * - **Names and colours come from the server.** Awareness carries cursors; who
 *   a cursor belongs to is read from the participant list the server sends,
 *   keyed by Yjs client id, never from what another browser says about itself.
 */

export type SessionStatus = 'connecting' | 'live' | 'paused' | 'offline' | 'reset';

export interface Participant {
  client_id: string;
  y_client_id: number;
  user_id: string;
  name: string;
  colour: string;
}

export interface SessionBase {
  version: number;
  contentHash: string;
  body: string;
  title: string;
}

export interface SessionSnapshot {
  status: SessionStatus;
  /** Who holds the page instead, while paused because somebody else does. */
  heldBy: string | null;
  participants: Participant[];
  base: SessionBase | null;
  /** True once the shared document holds the page and can be edited. */
  ready: boolean;
  /** True while the session holds text that no revision has. */
  unsaved: boolean;
  /** Set when a save by anybody lands; the editor rebinds to the new base. */
  lastSavedBy: string | null;
}

export interface SessionProviderOptions {
  pageId: string;
  /** Builds the shared document's first state from the page's Markdown. */
  buildInitialState: (markdown: string) => Uint8Array;
  onChange: (snapshot: SessionSnapshot) => void;
}

const FLUSH_AFTER_MS = 80;
const AWARENESS_AFTER_MS = 120;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export class SessionProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly clientId = crypto.randomUUID();

  private readonly url: string;
  private source: EventSource | null = null;
  private snapshot: SessionSnapshot = {
    status: 'connecting',
    heldBy: null,
    participants: [],
    base: null,
    ready: false,
    unsaved: false,
    lastSavedBy: null,
  };
  private outgoing: Uint8Array[] = [];
  private sending = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly options: SessionProviderOptions) {
    this.url = `/api/v1/pages/${options.pageId}/collab`;
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
    this.connect();
  }

  get state(): SessionSnapshot {
    return this.snapshot;
  }

  /** The name and colour of the person a cursor belongs to, as the server knows them. */
  participantOf(yClientId: number): Participant | undefined {
    return this.snapshot.participants.find((entry) => entry.y_client_id === yClientId);
  }

  private set(patch: Partial<SessionSnapshot>): void {
    // A reset is final. The stream that announces it and the request that was
    // refused because of it finish in either order, and the refusal must not
    // turn "this document is gone, load the page again" back into "paused".
    const next = this.snapshot.status === 'reset' ? { ...patch, status: 'reset' as const, ready: false } : patch;
    this.snapshot = { ...this.snapshot, ...next };
    if (!this.destroyed) this.options.onChange(this.snapshot);
  }

  /* ---------------- incoming ---------------- */

  private connect(): void {
    const source = new EventSource(`${this.url}?client=${this.clientId}&y=${this.doc.clientID}`);
    this.source = source;
    const on = (name: string, handler: (data: Record<string, unknown>) => void): void =>
      source.addEventListener(name, (event) => {
        try {
          handler(JSON.parse((event as MessageEvent<string>).data) as Record<string, unknown>);
        } catch (error) {
          console.error('[collab] bad event', name, error);
        }
      });

    on('hello', (data) => this.onHello(data));
    on('update', (data) => Y.applyUpdate(this.doc, fromBase64(String(data.update)), this));
    on('awareness', (data) => applyAwarenessUpdate(this.awareness, fromBase64(String(data.update)), this));
    on('participants', (data) => this.set({ participants: data.participants as Participant[] }));
    on('seed', () => this.seed());
    on('status', (data) => {
      this.set({ status: data.status as SessionStatus, heldBy: (data.held_by as string | null) ?? null });
      if (data.status === 'live') this.scheduleFlush();
    });
    on('saved', (data) =>
      this.set({
        base: {
          version: Number(data.version),
          contentHash: String(data.content_hash),
          body: String(data.body),
          title: String(data.title),
        },
        unsaved: Boolean(data.unsaved),
        lastSavedBy: String((data.by as { name?: string } | undefined)?.name ?? ''),
      }),
    );
    on('reset', () => {
      this.set({ status: 'reset', ready: false });
      this.close();
    });

    source.onerror = () => {
      // The browser retries by itself; a closed source means the server said no.
      if (this.snapshot.status === 'reset') return;
      if (source.readyState === EventSource.CLOSED) this.set({ status: 'offline' });
      else if (this.snapshot.status !== 'connecting') this.set({ status: 'offline' });
    };
  }

  private onHello(data: Record<string, unknown>): void {
    const base = data.base as { version: number; content_hash: string; body: string; title: string };
    const state = typeof data.state === 'string' ? fromBase64(data.state) : null;
    if (state) Y.applyUpdate(this.doc, state, this);
    if (typeof data.awareness === 'string') {
      applyAwarenessUpdate(this.awareness, fromBase64(data.awareness), this);
    }

    this.set({
      status: data.status as SessionStatus,
      heldBy: (data.held_by as string | null) ?? null,
      participants: data.participants as Participant[],
      base: { version: base.version, contentHash: base.content_hash, body: base.body, title: base.title },
      ready: Boolean(data.seeded),
      unsaved: Boolean(data.unsaved),
    });

    if (state) {
      // A reconnect: whatever was typed while the stream was down is in this
      // document and not in the server's. Send exactly that.
      const missing = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVectorFromUpdate(state));
      if (missing.byteLength > 2) this.enqueue(missing);
    }
    if (data.seed === true) this.seed();
    // Let everybody know where this cursor is, again, after a reconnect.
    if (this.awareness.getLocalState() !== null) this.scheduleAwareness();
  }

  /** Builds the document from the page, or offers the one this browser already has. */
  private seed(): void {
    const base = this.snapshot.base;
    if (!base || this.snapshot.ready) return;
    const local = Y.encodeStateAsUpdate(this.doc);
    // After a server restart the room is empty and this browser is not: its
    // document is the session, and building a second one would double the page.
    const update = local.byteLength > 2 ? local : this.options.buildInitialState(base.body);
    if (local.byteLength <= 2) Y.applyUpdate(this.doc, update, this);
    void this.post({ kind: 'seed', update: toBase64(update) }).then((response) => {
      if (response?.ok) this.set({ ready: true });
    });
  }

  /* ---------------- outgoing ---------------- */

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    this.enqueue(update);
    this.set({ unsaved: true });
  };

  private enqueue(update: Uint8Array): void {
    this.outgoing.push(update);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.destroyed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_AFTER_MS);
  }

  private async flush(): Promise<void> {
    if (this.sending || this.outgoing.length === 0 || !this.snapshot.ready) return;
    this.sending = true;
    const batch = this.outgoing.splice(0);
    const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    const response = await this.post({ kind: 'update', update: toBase64(merged) });
    this.sending = false;

    if (!response?.ok) {
      // Kept, in order, for when the session is live again or the stream is back.
      this.outgoing.unshift(merged);
      if (response?.status === 409) {
        const details = (await response.json().catch(() => null)) as {
          error?: { details?: { held_by?: string | null } };
        } | null;
        this.set({ status: 'paused', heldBy: details?.error?.details?.held_by ?? null });
      } else if (response?.status === 404) {
        // The server no longer knows this connection; the stream's reconnect
        // will greet it again and the queue goes out after that.
        this.set({ status: 'offline' });
      }
      return;
    }
    if (this.outgoing.length > 0) this.scheduleFlush();
  }

  private onAwarenessUpdate = (_changes: unknown, origin: unknown): void => {
    if (origin === this) return;
    this.scheduleAwareness();
  };

  private scheduleAwareness(): void {
    if (this.awarenessTimer || this.destroyed) return;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      // Only ever this browser's own state: the server refuses anything else.
      const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
      void this.post({ kind: 'awareness', update: toBase64(update) });
    }, AWARENESS_AFTER_MS);
  }

  private async post(message: Record<string, unknown>): Promise<Response | null> {
    if (this.destroyed) return null;
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: this.clientId, ...message }),
        // A cursor or an edit is not worth keeping a closing tab alive for.
        keepalive: false,
      });
    } catch {
      return null;
    }
  }

  /** Asks for the page back after a pause. */
  async resume(): Promise<boolean> {
    const response = await this.post({ kind: 'resume' });
    if (!response?.ok) return false;
    const body = (await response.json()) as { status: SessionStatus };
    this.set({ status: body.status });
    if (body.status === 'live') this.scheduleFlush();
    return body.status === 'live';
  }

  /**
   * Saves the session's text as a revision by this person. `body` is the shared
   * document as Markdown, serialised by the caller just now; the state vector
   * says exactly which document that was, so that what somebody else typed a
   * moment later is not reported as saved.
   */
  async save(body: string, fields: { title?: string; summary?: string | null } = {}): Promise<Response | null> {
    // What is still queued is part of the text being saved: send it first.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    return this.post({
      kind: 'save',
      body,
      state_vector: toBase64(Y.encodeStateVector(this.doc)),
      ...fields,
    });
  }

  /** The state vector of this browser's document, for a save made through the page form. */
  stateVector(): string {
    return toBase64(Y.encodeStateVector(this.doc));
  }

  /** Sends what is queued now; the page form calls it before it submits. */
  async drain(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  private close(): void {
    this.source?.close();
    this.source = null;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    this.close();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }
}
