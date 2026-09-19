import { getSchema } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Schema } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { bindDocument, parseMarkdown, serializeDocument } from '../markdown-bridge';
import type { ParsedMarkdown } from '../markdown-bridge';
import { createEditorExtensions } from '../schema';

/** The name of the Yjs fragment the editor document lives in. */
export const COLLAB_FIELD = 'default';

let cached: Schema | null = null;

/** The editor's schema without its React views: enough to build and check documents. */
function schema(): Schema {
  cached ??= getSchema(createEditorExtensions({ history: false }));
  return cached;
}

/** What the editor does to a document it is given: real nodes, checked, read back. */
export function normalizeDocument(doc: JSONContent): JSONContent {
  const node = ProseMirrorNode.fromJSON(schema(), doc);
  node.check();
  return node.toJSON() as JSONContent;
}

/**
 * The page's Markdown parsed and bound to itself.
 *
 * In a live session the document on screen may already carry other people's
 * edits when this browser arrives, so the source segments cannot be bound to
 * it the way a solo editor binds them to the document it has just opened. They
 * are bound to the page's own parse instead: a block of the shared document
 * that still equals a block of the saved page is written back as that page's
 * bytes, whoever is looking and whenever they joined.
 *
 * Returns null when the page cannot be kept byte for byte, which is the same
 * condition under which the solo editor falls back to the Markdown tab.
 */
export function bindBase(markdown: string): ParsedMarkdown | null {
  try {
    const parsed = parseMarkdown(markdown);
    const own = normalizeDocument(parsed.doc);
    if (!bindDocument(parsed, own)) return null;
    return serializeDocument(own, parsed) === markdown ? parsed : null;
  } catch {
    return null;
  }
}

/** The shared document's first state: the page, as the editor would open it. */
export function buildInitialState(markdown: string): Uint8Array {
  const doc = prosemirrorJSONToYDoc(schema(), normalizeDocument(parseMarkdown(markdown).doc), COLLAB_FIELD);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** The shared document as the editor's JSON. */
export function sharedDocument(doc: Y.Doc): JSONContent {
  return normalizeDocument(yDocToProsemirrorJSON(doc, COLLAB_FIELD) as JSONContent);
}

/**
 * Makes the shared document say what this Markdown says.
 *
 * This is how text typed in the Markdown tab gets into a session. It is written
 * into the existing fragment as a difference — blocks that did not change are
 * left alone — so it is an edit like any other, and applying the same Markdown
 * twice changes nothing the second time.
 */
export function applyMarkdown(doc: Y.Doc, markdown: string): void {
  const next = normalizeDocument(parseMarkdown(markdown).doc);
  if (JSON.stringify(next) === JSON.stringify(sharedDocument(doc))) return;
  doc.transact(() => {
    prosemirrorJSONToYXmlFragment(schema(), next, doc.getXmlFragment(COLLAB_FIELD));
  });
}

/** The shared document as Markdown, unchanged blocks written back as the saved page has them. */
export function serializeShared(doc: Y.Doc, parsed: ParsedMarkdown): string {
  return serializeDocument(sharedDocument(doc), parsed);
}
