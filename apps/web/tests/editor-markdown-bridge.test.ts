import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSchema } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '@/lib/pages/markdown';
import {
  bindDocument,
  parseMarkdown,
  roundTrip,
  serializeDocument,
  serializeNodes,
} from '@/components/editor/markdown-bridge';
import { createEditorExtensions } from '@/components/editor/schema';

const schema = getSchema(createEditorExtensions());

/** What the editor does to a document it is given: build real nodes, check them, read them back. */
function normalize(doc: JSONContent): JSONContent {
  const node = ProseMirrorNode.fromJSON(schema, doc);
  node.check();
  return node.toJSON() as JSONContent;
}

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agent-markdown');
const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => [name, readFileSync(path.join(fixturesDir, name), 'utf8')] as const);

/** Opens `markdown`, lets `edit` change the document, and saves. */
function edited(markdown: string, edit: (doc: JSONContent) => void): string {
  const { parsed, doc } = roundTrip(markdown, normalize);
  const copy = structuredClone(doc);
  edit(copy);
  return serializeDocument(normalize(copy), parsed);
}

describe('opening and saving without an edit', () => {
  it('has a representative corpus', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtures)('keeps %s byte for byte', (_name, markdown) => {
    const result = roundTrip(markdown, normalize);
    expect(result.bound).toBe(true);
    expect(result.output).toBe(markdown);
  });

  it.each(fixtures)('builds a valid editor document for %s', (_name, markdown) => {
    expect(() => normalize(parseMarkdown(markdown).doc)).not.toThrow();
  });

  it('refuses to bind when the editor document does not line up with the source', () => {
    const parsed = parseMarkdown('one\n\ntwo\n');
    expect(bindDocument(parsed, { type: 'doc', content: [{ type: 'paragraph' }] })).toBe(false);
  });
});

describe('what the visual editor sees', () => {
  it('maps agent constructs onto editor nodes rather than raw source', () => {
    const { doc, parsed } = roundTrip(
      readFileSync(path.join(fixturesDir, '13-mixed-agent-page.md'), 'utf8'),
      normalize,
    );
    expect(parsed.rawBlocks).toBe(0);
    expect(doc.content?.map((node) => node.type)).toEqual([
      'heading',
      'blockquote',
      'heading',
      'table',
      'heading',
      'orderedList',
      'codeBlock',
      'horizontalRule',
      'paragraph',
    ]);
  });

  it('reads GitHub alerts as callouts, mermaid and chart fences as their own blocks', () => {
    const { doc } = roundTrip(
      '> [!WARNING]\n> Careful.\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\n```chart\n{}\n```\n',
      normalize,
    );
    expect(doc.content?.[0]).toMatchObject({ type: 'callout', attrs: { kind: 'WARNING' } });
    expect(doc.content?.[1]).toMatchObject({ type: 'mermaidBlock', attrs: { source: 'flowchart LR\n  A-->B' } });
    expect(doc.content?.[2]).toMatchObject({ type: 'chartBlock', attrs: { source: '{}' } });
  });

  it('keeps code block info strings', () => {
    const { doc } = roundTrip('```ts title="src/auth.ts"\nconst a = 1;\n```', normalize);
    expect(doc.content?.[0]).toMatchObject({ type: 'codeBlock', attrs: { language: 'ts', meta: 'title="src/auth.ts"' } });
  });

  it('keeps what it has no visual form for as verbatim source', () => {
    const { doc, parsed } = roundTrip(
      '<details>\n<summary>x</summary>\n</details>\n\n[ref]: https://example.com\n\n- [x] done\n- plain\n',
      normalize,
    );
    expect(doc.content?.map((node) => node.type)).toEqual(['rawBlock', 'rawBlock', 'rawBlock']);
    expect(parsed.rawBlocks).toBe(3);
  });

  it('keeps inline HTML and references as inline source inside an editable paragraph', () => {
    const { doc } = roundTrip('Press <kbd>Ctrl</kbd> or see [the doc][ref].\n\n[ref]: https://example.com\n', normalize);
    const paragraph = doc.content?.[0];
    expect(paragraph?.type).toBe('paragraph');
    expect(paragraph?.content?.filter((node) => node.type === 'rawInline').map((node) => node.attrs?.source)).toEqual([
      '<kbd>',
      '</kbd>',
      '[the doc][ref]',
    ]);
  });
});

describe('saving after an edit', () => {
  const page = [
    '# Payments',
    '',
    '* star bullet',
    '* another',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'Closing paragraph.',
    '',
  ].join('\n');

  it('rewrites only the block that changed, in the page\'s own style', () => {
    const output = edited(page, (doc) => {
      const list = doc.content![1]!;
      list.content![1]!.content![0]!.content = [{ type: 'text', text: 'changed' }];
    });
    expect(output).toBe(page.replace('* another', '* changed'));
  });

  it('writes an edited table with a conventional delimiter row and alignment', () => {
    const output = edited(page, (doc) => {
      const table = doc.content![2]!;
      table.content![1]!.content![1]!.content = [{ type: 'paragraph', content: [{ type: 'text', text: '3 | 4' }] }];
      table.content![0]!.content![1]!.attrs = { ...table.content![0]!.content![1]!.attrs, align: 'right' };
    });
    expect(output).toContain('| a | b |\n| --- | ---: |\n| 1 | 3 \\| 4 |');
    expect(output.startsWith('# Payments\n\n* star bullet\n* another\n\n')).toBe(true);
    expect(output.endsWith('\n\nClosing paragraph.\n')).toBe(true);
  });

  it('adds new blocks between untouched ones with a blank line', () => {
    const output = edited(page, (doc) => {
      doc.content!.splice(1, 0, { type: 'paragraph', content: [{ type: 'text', text: 'Inserted.' }] });
    });
    expect(output).toBe(page.replace('# Payments\n\n', '# Payments\n\nInserted.\n\n'));
  });

  it('drops a deleted block and its separator', () => {
    const output = edited(page, (doc) => {
      doc.content!.splice(2, 1);
    });
    expect(output).toBe('# Payments\n\n* star bullet\n* another\n\nClosing paragraph.\n');
  });

  it('keeps the absence of a trailing newline when the last block is edited', () => {
    const output = edited('First\n\nLast', (doc) => {
      doc.content![1]!.content = [{ type: 'text', text: 'Changed' }];
    });
    expect(output).toBe('First\n\nChanged');
  });

  it('escapes HTML typed as text, so it stays text', async () => {
    const output = edited('Intro\n', (doc) => {
      doc.content![0]!.content = [{ type: 'text', text: 'Use <script>alert(1)</script> and a < b' }];
    });
    expect(output).toBe('Use \\<script>alert(1)\\</script> and a < b\n');
    const html = await renderMarkdown(output);
    expect(html).not.toContain('<script');
    expect(html).toContain('&#x3C;script>');
  });

  it('keeps inline source nodes when their paragraph is edited', () => {
    const output = edited('Press <kbd>Ctrl</kbd> now.\n', (doc) => {
      doc.content![0]!.content!.push({ type: 'text', text: '!' });
    });
    expect(output).toBe('Press <kbd>Ctrl</kbd> now.!\n');
  });

  it('writes an empty document as an empty body', () => {
    expect(edited('# Title\n', (doc) => { doc.content = [{ type: 'paragraph' }]; })).toBe('');
  });
});

describe('serialising new content', () => {
  const style = { bullet: '-', emphasis: '*', strong: '*', rule: '-', fence: '`' } as const;

  it('writes callouts as GitHub alerts', () => {
    expect(
      serializeNodes(
        [
          {
            type: 'callout',
            attrs: { kind: 'CAUTION' },
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Never paste a token.' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Rotate it.' }] },
            ],
          },
        ],
        style,
      ),
    ).toBe('> [!CAUTION]\n> Never paste a token.\n>\n> Rotate it.');
  });

  it('writes an empty callout as its marker alone', () => {
    expect(serializeNodes([{ type: 'callout', attrs: { kind: 'TIP' }, content: [{ type: 'paragraph' }] }], style)).toBe('> [!TIP]');
  });

  it('writes mermaid and chart blocks as fenced blocks', () => {
    expect(
      serializeNodes(
        [
          { type: 'mermaidBlock', attrs: { source: 'flowchart LR\n  A --> B', meta: null } },
          { type: 'chartBlock', attrs: { source: '{\n  "type": "pie"\n}', meta: null } },
        ],
        style,
      ),
    ).toBe('```mermaid\nflowchart LR\n  A --> B\n```\n\n```chart\n{\n  "type": "pie"\n}\n```');
  });

  it('writes nested marks, links around code, task lists and images', () => {
    expect(
      serializeNodes(
        [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'See ' },
              { type: 'text', text: 'wiki.claim', marks: [{ type: 'link', attrs: { href: 'https://example.com', title: null } }, { type: 'code' }] },
              { type: 'text', text: ', ' },
              { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
              { type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] },
              { type: 'text', text: ' and ' },
              { type: 'image', attrs: { src: 'https://example.com/a.png', alt: 'A', title: null } },
            ],
          },
          {
            type: 'taskList',
            attrs: { spread: false },
            content: [
              { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }] },
              { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'todo' }] }] },
            ],
          },
          {
            type: 'codeBlock',
            attrs: { language: 'ts', meta: 'title="a.ts"' },
            content: [{ type: 'text', text: 'const a = 1;' }],
          },
          { type: 'horizontalRule' },
        ],
        style,
      ),
    ).toBe(
      'See [`wiki.claim`](https://example.com), **bold *both*** and ![A](https://example.com/a.png)\n\n- [x] done\n- [ ] todo\n\n```ts title="a.ts"\nconst a = 1;\n```\n\n---',
    );
  });

  it('round-trips what it writes', () => {
    const markdown = '> [!NOTE]\n> Text with **bold**.\n\n| Name | Value |\n| :--- | ---: |\n| a | 1 |\n';
    const { output, parsed } = roundTrip(markdown, normalize);
    expect(output).toBe(markdown);
    expect(serializeNodes(normalize(parsed.doc).content ?? [], parsed.style)).toBe(markdown.trimEnd());
  });
});
