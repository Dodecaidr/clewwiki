import { Extension } from '@tiptap/core';
import { yCursorPlugin } from '@tiptap/y-tiptap';

import type { SessionProvider } from './provider';

/**
 * Other people's cursors and selections.
 *
 * Awareness says where a cursor is; it does not get to say whose it is. The
 * label and the colour are looked up in the participant list the server sent,
 * by Yjs client id — a browser can put any name it likes in its own awareness
 * state, and nobody else's editor will read it. A cursor whose owner is not on
 * the list (it left a moment ago, the list has not arrived yet) is drawn
 * without a name rather than with a claimed one.
 */

const FALLBACK_COLOUR = '#6b7280';

/** Colours arrive from this application's own palette; anything else is not used as CSS. */
function safeColour(value: string | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : FALLBACK_COLOUR;
}

export function createCursorExtension(provider: SessionProvider) {
  return Extension.create({
    name: 'collabCursors',
    addProseMirrorPlugins() {
      return [
        yCursorPlugin(provider.awareness, {
          cursorBuilder: (_user: unknown, clientId: number) => {
            const owner = provider.participantOf(clientId);
            const colour = safeColour(owner?.colour);
            const caret = document.createElement('span');
            caret.className = 'collab-caret';
            caret.style.borderColor = colour;
            if (owner) {
              const label = document.createElement('span');
              label.className = 'collab-caret-label';
              label.style.backgroundColor = colour;
              // textContent, never markup: a display name is somebody's input.
              label.textContent = owner.name;
              caret.append(label);
            }
            return caret;
          },
          selectionBuilder: (_user: unknown, clientId: number) => {
            const colour = safeColour(provider.participantOf(clientId)?.colour);
            return { class: 'collab-selection', style: `background-color: ${colour}33` };
          },
        }),
      ];
    },
  });
}
