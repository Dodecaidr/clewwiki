'use client';

import { useEffect, useState } from 'react';

import type { ParsedMarkdown } from '../markdown-bridge';
import type { SessionProvider, SessionSnapshot } from './provider';

/**
 * How a page is being edited.
 *
 * - `checking` — deciding; nothing is editable yet.
 * - `session` — in the page's live session, with whoever else is there.
 * - `solo` — the page cannot be kept byte for byte by the visual editor, so it
 *   is edited as Markdown under an ordinary exclusive lease, as it always was.
 *   A CRDT of a document the editor cannot represent faithfully would reformat
 *   the page for everybody at once.
 */
export type EditingMode = 'checking' | 'session' | 'solo';

export interface LiveSession {
  mode: EditingMode;
  provider: SessionProvider | null;
  snapshot: SessionSnapshot | null;
  /** The saved page bound to itself; null until the session says what the page is. */
  parsed: ParsedMarkdown | null;
  /** True when this browser is the only one in the session. */
  alone: boolean;
  /** Writes Markdown typed in the Markdown tab into the shared document. */
  applyMarkdown: ((markdown: string) => void) | null;
  /** The shared document as Markdown, for showing it while others are editing. */
  markdown: MarkdownStore | null;
}

/** A `useSyncExternalStore` source: the shared document, serialised on demand. */
export interface MarkdownStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => string;
}

interface SessionState {
  mode: EditingMode;
  provider: SessionProvider | null;
  snapshot: SessionSnapshot | null;
  parsed: ParsedMarkdown | null;
  applyMarkdown: ((markdown: string) => void) | null;
  markdown: MarkdownStore | null;
}

const EMPTY = { provider: null, snapshot: null, parsed: null, applyMarkdown: null, markdown: null };
const CHECKING: SessionState = { mode: 'checking', ...EMPTY };
const SOLO: SessionState = { mode: 'solo', ...EMPTY };

/**
 * Joins the live session of a page for as long as the component is mounted.
 *
 * Everything heavy — Yjs, the editor schema, the Markdown bridge — is imported
 * here, on demand, so that it is not part of any page that does not edit.
 */
export function useLiveSession(pageId: string | undefined, initialBody: string): LiveSession {
  const [state, setState] = useState<SessionState>(pageId ? CHECKING : SOLO);

  useEffect(() => {
    if (!pageId) return;
    let cancelled = false;
    let created: SessionProvider | null = null;

    void Promise.all([import('./initial-state'), import('./provider')]).then(([initial, transport]) => {
      if (cancelled) return;
      if (initial.bindBase(initialBody) === null) {
        setState(SOLO);
        return;
      }

      let boundHash: string | null = null;
      let parsed: ParsedMarkdown | null = null;
      const provider = new transport.SessionProvider({
        pageId,
        buildInitialState: initial.buildInitialState,
        onChange: (snapshot) => {
          if (cancelled) return;
          // The base moves whenever anybody saves; the saved page is bound to
          // itself again each time, and only then.
          if (snapshot.base && snapshot.base.contentHash !== boundHash) {
            boundHash = snapshot.base.contentHash;
            parsed = initial.bindBase(snapshot.base.body);
            if (parsed === null) {
              // Somebody saved a page this editor cannot keep byte for byte:
              // leave the session to the people in it and fall back to the lease.
              cancelled = true;
              provider.destroy();
              setState(SOLO);
              return;
            }
          }
          setState({ mode: 'session', provider, snapshot, parsed, applyMarkdown, markdown });
        },
      });
      created = provider;

      const applyMarkdown = (text: string): void => initial.applyMarkdown(provider.doc, text);
      // Serialised lazily and at most once per change: a snapshot has to be the
      // same string until the document moves, or React renders for ever.
      let stale = true;
      let cachedMarkdown = '';
      const markdown: MarkdownStore = {
        subscribe: (listener) => {
          const onUpdate = (): void => {
            stale = true;
            listener();
          };
          provider.doc.on('update', onUpdate);
          return () => provider.doc.off('update', onUpdate);
        },
        getSnapshot: () => {
          if (stale && parsed) {
            cachedMarkdown = initial.serializeShared(provider.doc, parsed);
            stale = false;
          }
          return cachedMarkdown;
        },
      };
      setState({ mode: 'session', provider, snapshot: provider.state, parsed: null, applyMarkdown, markdown });
    });

    return () => {
      cancelled = true;
      created?.destroy();
    };
    // The body the form was rendered with decides once; later bases come from the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  return {
    ...state,
    alone: (state.snapshot?.participants.length ?? 1) <= 1,
  };
}
