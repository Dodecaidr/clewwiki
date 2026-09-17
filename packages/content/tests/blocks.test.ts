import { describe, expect, it } from 'vitest';

import { describeBlockIssue, findContentBlocks, validateContentBlocks } from '../src/blocks';

describe('findContentBlocks', () => {
  it('finds chart and mermaid fences anywhere, with their line and order', () => {
    const body = [
      '# Title',
      '',
      '```mermaid',
      'graph TD;',
      '```',
      '',
      '- item',
      '',
      '  ```chart',
      '  {"type": "line", "x": ["a"], "series": [{"name": "s", "data": [1]}]}',
      '  ```',
      '',
      '> ~~~chart',
      '> {}',
      '> ~~~',
      '',
      '```ts',
      'const chart = 1;',
      '```',
    ].join('\n');
    expect(findContentBlocks(body).map(({ index, line, language }) => ({ index, line, language }))).toEqual([
      { index: 0, line: 3, language: 'mermaid' },
      { index: 1, line: 9, language: 'chart' },
      { index: 2, line: 13, language: 'chart' },
    ]);
  });

  it('ignores text that only mentions a fence', () => {
    expect(findContentBlocks('Write `` ```chart `` to add a chart.\n\n    ```chart\n    {}\n    ```')).toEqual([]);
  });
});

describe('validateContentBlocks', () => {
  it('reports every invalid block with block_index, line and errors', () => {
    const body = [
      '```chart',
      '{"type": "bar", "x": ["a", "b"], "series": [{"name": "s", "data": [1]}]}',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      '  A-->B',
      '```',
      '',
      '```mermaid',
      'not a diagram',
      '```',
    ].join('\n');
    const issues = validateContentBlocks(body);
    expect(issues).toEqual([
      {
        block_index: 0,
        line: 1,
        language: 'chart',
        errors: [{ path: 'series.0.data', message: 'series 0 ("s") has 1 values but x has 2 labels; they must be equal' }],
      },
      {
        block_index: 2,
        line: 10,
        language: 'mermaid',
        errors: [expect.objectContaining({ path: '', message: expect.stringContaining('unknown diagram type "not"') })],
      },
    ]);
    expect(describeBlockIssue(issues[0]!)).toBe(
      'Chart block 0 at line 1 is not valid: series.0.data: series 0 ("s") has 1 values but x has 2 labels; they must be equal',
    );
  });

  it('passes a body without blocks, and callouts need no validation', () => {
    expect(validateContentBlocks('> [!NOTE]\n> text\n\n> [!NOPE]\n> text')).toEqual([]);
  });
});
