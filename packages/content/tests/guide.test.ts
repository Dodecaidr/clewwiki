import { describe, expect, it } from 'vitest';

import { validateContentBlocks } from '../src/blocks';
import { CHART_LIMITS, CHART_TYPES } from '../src/chart';
import { buildFormatGuide } from '../src/guide';
import { MERMAID_KEYWORDS, MERMAID_TEMPLATES } from '../src/mermaid';

describe('format guide', () => {
  const guide = buildFormatGuide();

  it('is generated from the schema and constants it describes', () => {
    expect(guide.charts.types).toEqual(CHART_TYPES);
    expect(guide.charts.limits).toEqual(CHART_LIMITS);
    expect(guide.mermaid.keywords).toEqual(MERMAID_KEYWORDS);
    expect(guide.mermaid.templates.map((template) => template.id)).toEqual(MERMAID_TEMPLATES.map((template) => template.id));
    expect(Object.keys(guide.charts.examples).sort()).toEqual([...CHART_TYPES].sort());
    expect(JSON.stringify(guide.charts.json_schema)).toContain('stacked-bar');
  });

  it('has only examples the server accepts', () => {
    const blocks = [
      ...Object.values(guide.charts.examples).map((example) => example.markdown),
      ...guide.mermaid.templates.map((template) => template.markdown),
      ...guide.constructs.map((construct) => construct.markdown),
    ];
    for (const block of blocks) expect(validateContentBlocks(block)).toEqual([]);
  });

  it('serialises to JSON', () => {
    expect(() => JSON.stringify(guide)).not.toThrow();
  });
});
