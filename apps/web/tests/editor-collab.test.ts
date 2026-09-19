import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSchema } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { bindDocument, parseMarkdown, serializeDocument } from '@/components/editor/markdown-bridge';
import { createEditorExtensions } from '@/components/editor/schema';
import {
  COLLAB_FIELD,
  applyMarkdown,
  bindBase,
  buildInitialState,
  sharedDocument,
} from '@/components/editor/collab/initial-state';

const schema = getSchema(createEditorExtensions());
const normalize = (doc: JSONContent): JSONContent => {
  const node = ProseMirrorNode.fromJSON(schema, doc);
  node.check();
  return node.toJSON() as JSONContent;
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent-markdown');
const fixtures = readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => [n, readFileSync(path.join(dir, n), 'utf8')] as const);

/** Peer A opens the page and publishes it; peer B receives it over the wire and saves. */
function viaSecondPeer(markdown: string): { output: string; bound: boolean } {
  const a = prosemirrorJSONToYDoc(schema, normalize(parseMarkdown(markdown).doc), 'default');
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const received = normalize(yDocToProsemirrorJSON(b, 'default') as JSONContent);

  // B knows the base Markdown of the session and binds its own segments to it.
  const parsed = parseMarkdown(markdown);
  const bound = bindDocument(parsed, normalize(parsed.doc));
  return { output: serializeDocument(received, parsed), bound };
}

describe('byte-for-byte through Yjs', () => {
  it.each(fixtures)('%s', (_name, markdown) => {
    const result = viaSecondPeer(markdown);
    expect(result.bound).toBe(true);
    expect(result.output).toBe(markdown);
  });

  it('an edit by one peer re-serialises only the block it touched, on the other peer', () => {
    const markdown = fixtures.map(([, text]) => text).find((text) => text.split('\n\n').length > 6)!;
    const parsedA = parseMarkdown(markdown);
    const docA = normalize(parsedA.doc);
    const a = prosemirrorJSONToYDoc(schema, docA, 'default');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // A types into the first paragraph it can find; B receives the delta only.
    const fragment = a.getXmlFragment('default');
    const stateBefore = Y.encodeStateVector(b);
    let touched = false;
    fragment.forEach((child) => {
      if (touched || !(child instanceof Y.XmlElement) || child.nodeName !== 'paragraph') return;
      const text = child.get(0);
      if (text instanceof Y.XmlText) {
        text.insert(0, 'EDITED ');
        touched = true;
      }
    });
    expect(touched).toBe(true);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, stateBefore));

    const parsedB = parseMarkdown(markdown);
    bindDocument(parsedB, normalize(parsedB.doc));
    const output = serializeDocument(normalize(yDocToProsemirrorJSON(b, 'default') as JSONContent), parsedB);

    const before = markdown.split('\n');
    const after = output.split('\n');
    const changed = after.filter((line, index) => line !== before[index]);
    expect(output).toContain('EDITED ');
    expect(after.length).toBe(before.length);
    expect(changed.length).toBe(1);
  });
});

describe('the session’s document', () => {
  const page = '# Title\n\nFirst paragraph.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';

  it('is built from the page, and a second browser saves it back byte for byte', () => {
    const room = new Y.Doc();
    Y.applyUpdate(room, buildInitialState(page));
    const parsed = bindBase(page);
    expect(parsed).not.toBeNull();
    expect(serializeDocument(sharedDocument(room), parsed!)).toBe(page);
  });

  it.each(fixtures)('can bind %s, so it is edited in a session rather than under a lease', (_name, markdown) => {
    expect(bindBase(markdown)).not.toBeNull();
  });

  it('takes Markdown typed in the Markdown tab as a difference, not a replacement', () => {
    const room = new Y.Doc();
    Y.applyUpdate(room, buildInitialState(page));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(room));

    const updates: Uint8Array[] = [];
    room.on('update', (update: Uint8Array) => updates.push(update));

    const edited = page.replace('First paragraph.', 'First paragraph, edited.');
    applyMarkdown(room, edited);
    expect(updates).toHaveLength(1);
    // The difference is one paragraph, not the page again.
    expect(updates[0]!.byteLength).toBeLessThan(buildInitialState(page).byteLength / 2);

    for (const update of updates) Y.applyUpdate(peer, update);
    expect(serializeDocument(sharedDocument(peer), bindBase(page)!)).toBe(edited);

    applyMarkdown(room, edited);
    expect(updates).toHaveLength(1);
    expect(room.getXmlFragment(COLLAB_FIELD).length).toBe(peer.getXmlFragment(COLLAB_FIELD).length);
  });
});
