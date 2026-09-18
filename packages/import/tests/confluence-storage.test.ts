import { describe, expect, it } from 'vitest';

import { convertStorageToMarkdown } from '../src/confluence/storage';
import { parseXml, textOf } from '../src/confluence/xml';

/**
 * One test per construct the converter claims to support, then one realistic
 * page that mixes them — because the interesting failures are at the seams, not
 * inside a single element.
 */

const pageIdByTitle = new Map([
  ['Deployment', '111'],
  ['Runbook', '222'],
]);

function convert(storage: string): ReturnType<typeof convertStorageToMarkdown> {
  return convertStorageToMarkdown(storage, {
    baseUrl: 'https://example.atlassian.net',
    pageId: '999',
    pageIdByTitle,
  });
}

describe('storage-format reader', () => {
  it('reads unclosed tags without throwing', () => {
    const tree = parseXml('<p>one<br>two<p>three');
    expect(textOf(tree)).toBe('onetwothree');
  });

  it('expands the entities a storage document carries', () => {
    expect(textOf(parseXml('<p>a &amp; b &nbsp;&mdash; c &#8212; d &#x2014;</p>'))).toBe(
      'a & b  — c — d —',
    );
  });

  it('keeps CDATA verbatim', () => {
    expect(textOf(parseXml('<p><![CDATA[a < b && c > d]]></p>'))).toBe('a < b && c > d');
  });

  it('drops a script body instead of reading it as content', () => {
    const result = convert('<p>before</p><script>alert(1)</script><p>after</p>');
    expect(result.markdown).not.toContain('alert');
    expect(result.markdown).toContain('before');
    expect(result.markdown).toContain('after');
  });
});

describe('storage format to Markdown', () => {
  it('converts headings and paragraphs', () => {
    const result = convert('<h1>Title</h1><h3>Detail</h3><p>Body text.</p>');
    expect(result.markdown).toBe('# Title\n\n### Detail\n\nBody text.\n');
  });

  it('converts emphasis and inline code', () => {
    const result = convert('<p><strong>bold</strong> <em>italic</em> <code>x = 1</code> <del>gone</del></p>');
    expect(result.markdown.trim()).toBe('**bold** *italic* `x = 1` ~~gone~~');
  });

  it('converts nested lists', () => {
    const result = convert(
      '<ul><li>Gateway<ul><li>rate limiting</li></ul></li><li>Worker</li></ul>',
    );
    expect(result.markdown).toBe('- Gateway\n  - rate limiting\n- Worker\n');
  });

  it('converts ordered lists', () => {
    expect(convert('<ol><li>one</li><li>two</li></ol>').markdown).toBe('1. one\n2. two\n');
  });

  it('converts a task list', () => {
    const storage =
      '<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Migrated</ac:task-body></ac:task>' +
      '<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>Smoke tested</ac:task-body></ac:task></ac:task-list>';
    expect(convert(storage).markdown).toBe('- [x] Migrated\n- [ ] Smoke tested\n');
  });

  it('converts a table with a header row', () => {
    const storage =
      '<table><tbody><tr><th>Endpoint</th><th>p95</th></tr><tr><td>/pages</td><td>42</td></tr></tbody></table>';
    expect(convert(storage).markdown).toBe(
      '| Endpoint | p95 |\n| --- | --- |\n| /pages | 42 |\n',
    );
  });

  it('gives a header-less table an empty header row', () => {
    const storage = '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
    expect(convert(storage).markdown).toBe('|  |  |\n| --- | --- |\n| a | b |\n');
  });

  it('converts the code macro to a fence with its language', () => {
    const storage =
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">Java</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[int a = 1;]]></ac:plain-text-body></ac:structured-macro>';
    expect(convert(storage).markdown).toBe('```java\nint a = 1;\n```\n');
  });

  it('converts the noformat macro to a text fence', () => {
    const storage =
      '<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[raw  spacing]]></ac:plain-text-body></ac:structured-macro>';
    expect(convert(storage).markdown).toBe('```text\nraw  spacing\n```\n');
  });

  it.each([
    ['info', 'NOTE'],
    ['note', 'IMPORTANT'],
    ['tip', 'TIP'],
    ['warning', 'WARNING'],
  ])('converts the %s panel to a %s alert', (macro, kind) => {
    const storage = `<ac:structured-macro ac:name="${macro}"><ac:rich-text-body><p>Careful.</p></ac:rich-text-body></ac:structured-macro>`;
    expect(convert(storage).markdown).toBe(`> [!${kind}]\n> Careful.\n`);
  });

  it('keeps a panel title above its body', () => {
    const storage =
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Before you start</ac:parameter>' +
      '<ac:rich-text-body><p>Take the lease.</p></ac:rich-text-body></ac:structured-macro>';
    expect(convert(storage).markdown).toBe(
      '> [!NOTE]\n> **Before you start**\n>\n> Take the lease.\n',
    );
  });

  it('names an unsupported macro in a visible note and warns', () => {
    const storage = '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">API-1</ac:parameter></ac:structured-macro>';
    const result = convert(storage);
    expect(result.markdown).toContain('> [!NOTE]');
    expect(result.markdown).toContain('`jira`');
    expect(result.warnings).toContainEqual({ code: 'unsupported-macro', detail: 'jira' });
  });

  it('drops the table-of-contents macro, which regenerates itself', () => {
    expect(convert('<ac:structured-macro ac:name="toc"/><p>Body</p>').markdown).toBe('Body\n');
  });

  it('rewrites an image attachment to its absolute Confluence URL and warns', () => {
    const storage =
      '<ac:image ac:alt="Flow"><ri:attachment ri:filename="flow.png"/></ac:image>';
    const result = convert(storage);
    expect(result.markdown.trim()).toBe(
      '![Flow](https://example.atlassian.net/download/attachments/999/flow.png)',
    );
    expect(result.warnings).toContainEqual({ code: 'external-attachment', detail: 'flow.png' });
    expect(result.attachments).toEqual(['flow.png']);
  });

  it('keeps an external image URL as it is', () => {
    const storage = '<ac:image><ri:url ri:value="https://example.com/a.png"/></ac:image>';
    expect(convert(storage).markdown.trim()).toBe('![](https://example.com/a.png)');
  });

  it('turns a link to another imported page into a placeholder', () => {
    const storage =
      '<p>See <ac:link><ri:page ri:content-title="Runbook"/><ac:link-body>the runbook</ac:link-body></ac:link>.</p>';
    expect(convert(storage).markdown.trim()).toBe('See [the runbook](clewwiki-import:222).');
  });

  it('flattens a link to a page outside the import and warns', () => {
    const storage = '<p><ac:link><ri:page ri:content-title="Elsewhere"/></ac:link></p>';
    const result = convert(storage);
    expect(result.markdown.trim()).toBe('Elsewhere');
    expect(result.warnings).toContainEqual({ code: 'unresolved-link', detail: 'Elsewhere' });
  });

  it('keeps an ordinary external link', () => {
    expect(convert('<p><a href="https://example.com/x">docs</a></p>').markdown.trim()).toBe(
      '[docs](https://example.com/x)',
    );
  });

  it('escapes text that would otherwise become markup', () => {
    expect(convert('<p>Use * for a bullet and _ inside names.</p>').markdown.trim()).toBe(
      'Use \\* for a bullet and \\_ inside names.',
    );
  });

  it('converts a blockquote and a horizontal rule', () => {
    expect(convert('<blockquote><p>Quoted.</p></blockquote><hr/>').markdown).toBe('> Quoted.\n\n---\n');
  });

  it('converts a realistic page end to end', () => {
    const storage = `
      <ac:layout><ac:layout-section ac:type="single"><ac:layout-cell>
        <p>The gateway terminates TLS and forwards to the workers.</p>
        <h2>Deploying</h2>
        <ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Take a claim before editing.</p></ac:rich-text-body></ac:structured-macro>
        <ol><li>Tag the release.</li><li>Run <code>deploy.sh</code>.</li></ol>
        <ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[./deploy.sh --env prod]]></ac:plain-text-body></ac:structured-macro>
        <h2>Limits</h2>
        <table><tbody><tr><th>Setting</th><th>Value</th></tr><tr><td>Timeout</td><td>30s</td></tr></tbody></table>
        <p>See also <ac:link><ri:page ri:content-title="Deployment"/><ac:link-body>Deployment</ac:link-body></ac:link>.</p>
        <ac:structured-macro ac:name="pagetree"/>
      </ac:layout-cell></ac:layout-section></ac:layout>`;

    const result = convert(storage);
    expect(result.markdown).toBe(
      [
        'The gateway terminates TLS and forwards to the workers.',
        '',
        '## Deploying',
        '',
        '> [!WARNING]',
        '> Take a claim before editing.',
        '',
        '1. Tag the release.',
        '2. Run `deploy.sh`.',
        '',
        '```bash',
        './deploy.sh --env prod',
        '```',
        '',
        '## Limits',
        '',
        '| Setting | Value |',
        '| --- | --- |',
        '| Timeout | 30s |',
        '',
        'See also [Deployment](clewwiki-import:111).',
        '',
        '> [!NOTE]',
        '> Unsupported Confluence macro `pagetree`. It rendered dynamic content that could not be imported; the original page still has it.',
        '',
      ].join('\n'),
    );
    expect(result.warnings).toContainEqual({ code: 'unsupported-macro', detail: 'pagetree' });
  });
});
