// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { parseMarkdown, serializeDocument } from '@/components/editor/markdown-bridge';
import { cleanPastedHtml, looksLikeMarkdown } from '@/components/editor/paste';
import { createEditorExtensions } from '@/components/editor/schema';

let editor: Editor | null = null;

// jsdom has no ClipboardEvent; ProseMirror only needs one to carry the paste.
if (typeof globalThis.ClipboardEvent === 'undefined') {
  class ClipboardEventShim extends Event {
    readonly clipboardData: DataTransfer | null = null;
  }
  (globalThis as unknown as { ClipboardEvent: typeof Event }).ClipboardEvent = ClipboardEventShim;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** Pastes HTML into an empty editor the way the browser would, and saves. */
function pasteAsMarkdown(html: string): string {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: createEditorExtensions(),
    editorProps: { transformPastedHTML: cleanPastedHtml },
  });
  editor.view.pasteHTML(html);
  return serializeDocument(editor.getJSON(), parseMarkdown(''));
}

describe('pasting HTML from other applications', () => {
  it('keeps headings, emphasis, links and lists, and drops fonts and colours', () => {
    const markdown = pasteAsMarkdown(
      '<meta charset="utf-8"><h2 style="font-family: Georgia">Release notes</h2>' +
        '<p><span style="font-family: Comic Sans MS; font-size: 18pt; color: #ff0000">Read the ' +
        '<b>migration</b> <i>guide</i> at <a href="https://example.com/guide">the wiki</a>.</span></p>' +
        '<ul><li>First</li><li>Second<ol><li>nested</li></ol></li></ul>',
    );
    expect(markdown).toBe(
      '## Release notes\n\nRead the **migration** *guide* at [the wiki](https://example.com/guide).\n\n- First\n- Second\n  1. nested\n',
    );
    expect(markdown).not.toMatch(/Comic|Georgia|ff0000|font|color|style/i);
  });

  it('turns a pasted table into a GFM table with a header row', () => {
    const markdown = pasteAsMarkdown(
      '<table><tbody><tr><th>Service</th><th style="text-align: right">p95</th></tr>' +
        '<tr><td><span style="color: blue">API</span></td><td style="text-align: right">120 ms</td></tr></tbody></table>',
    );
    expect(markdown).toBe('| Service | p95 |\n| --- | ---: |\n| API | 120 ms |\n');
  });

  it('does not make a Google Docs selection bold because of its wrapper', () => {
    const markdown = pasteAsMarkdown(
      '<b style="font-weight:normal;" id="docs-internal-guid-1234"><p dir="ltr"><span style="font-weight:700">Bold</span>' +
        '<span style="font-weight:400"> and plain</span></p></b>',
    );
    expect(markdown).toBe('**Bold** and plain\n');
  });

  it('ignores Word style sheets, conditional comments and Office tags', () => {
    const markdown = pasteAsMarkdown(
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal { font-family: Calibri }</style></head>' +
        '<body><!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]-->' +
        '<p class="MsoNormal">Hello<o:p></o:p></p></body></html>',
    );
    expect(markdown).toBe('Hello\n');
  });

  it('does not turn embedded or script image sources into images', () => {
    const markdown = pasteAsMarkdown(
      '<p>a<img src="data:image/png;base64,AAAA">b<img src="javascript:alert(1)">c<img src="https://example.com/x.png" alt="x"></p>',
    );
    expect(markdown).toBe('abc![x](https://example.com/x.png)\n');
  });

  it('keeps pasted markup-like text as text', () => {
    const markdown = pasteAsMarkdown('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(markdown).toBe('\\<script>alert(1)\\</script>\n');
  });
});

describe('recognising pasted Markdown', () => {
  it('treats structured plain text as Markdown', () => {
    expect(looksLikeMarkdown('## Plan\n\n- one\n- two')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n|---|---|')).toBe(true);
    expect(looksLikeMarkdown('```ts\ncode\n```')).toBe(true);
  });

  it('leaves ordinary prose alone', () => {
    expect(looksLikeMarkdown('Just a sentence.')).toBe(false);
    expect(looksLikeMarkdown('2 * 3 = 6')).toBe(false);
  });
});
