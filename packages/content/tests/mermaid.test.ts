import { describe, expect, it } from 'vitest';

import { checkMermaidSource, MERMAID_TEMPLATES, mermaidKeywordOf } from '../src/mermaid';

describe('mermaid structural check', () => {
  it.each(MERMAID_TEMPLATES.map((template) => [template.id, template]))('accepts the %s template', (_, template) => {
    expect(checkMermaidSource(template.source)).toEqual([]);
    expect(mermaidKeywordOf(template.source)).toBe(template.keyword);
  });

  it('reads the keyword after front matter, directives and comments', () => {
    expect(mermaidKeywordOf('---\ntitle: Flow\n---\n%%{init: {"theme": "dark"}}%%\n%% a comment\n\ngraph TD;\n A-->B')).toBe('graph');
  });

  it('refuses an unknown diagram type, naming it', () => {
    const [issue] = checkMermaidSource('flowchat LR\n A-->B');
    expect(issue?.message).toContain('unknown diagram type "flowchat"');
    expect(issue?.message).toContain('sequenceDiagram');
  });

  it('refuses prose and empty blocks', () => {
    expect(checkMermaidSource('This diagram shows the flow')).toHaveLength(1);
    expect(checkMermaidSource('\n  \n')[0]?.message).toContain('empty');
  });

  it('does not accept a keyword as a mere prefix', () => {
    expect(mermaidKeywordOf('pies are round')).toBeNull();
  });
});
