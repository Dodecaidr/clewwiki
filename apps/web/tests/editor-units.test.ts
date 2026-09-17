import { CHART_EXAMPLES, parseChartSource } from '@clewwiki/content/chart';
import { describe, expect, it } from 'vitest';

import { filterBlockItems } from '@/components/editor/block-items';
import {
  changeType,
  draftFromSource,
  draftFromType,
  draftToSource,
  sameChartSource,
} from '@/components/editor/chart-draft';
import { isAllowedLinkTarget } from '@/components/editor/commands';
import { isAllowedImageSource } from '@/components/editor/schema';

describe('chart editor draft', () => {
  it('turns every example into a draft and back into the same chart', () => {
    for (const spec of Object.values(CHART_EXAMPLES)) {
      const source = JSON.stringify(spec);
      const draft = draftFromSource(source);
      expect(draft).not.toBeNull();
      expect(sameChartSource(draftToSource(draft!), source)).toBe(true);
    }
  });

  it('reports a cell that is not a number with the schema path the server uses', () => {
    const draft = draftFromType('bar');
    draft.series[0]!.values[1] = '12,5';
    const result = parseChartSource(draftToSource(draft));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe('series.0.data.1');
  });

  it('carries data across when the chart type changes', () => {
    const bar = draftFromType('bar');
    const scatter = changeType(bar, 'scatter');
    expect(scatter.series[0]!.points).toEqual([
      ['1', '180'],
      ['2', '420'],
      ['3', '260'],
    ]);
    expect(parseChartSource(draftToSource(scatter)).ok).toBe(true);

    const pie = changeType(bar, 'pie');
    expect(pie.series).toHaveLength(1);
    expect(parseChartSource(draftToSource(pie)).ok).toBe(true);

    const back = changeType(scatter, 'line');
    expect(back.x).toEqual(['1', '2', '3']);
    expect(parseChartSource(draftToSource(back)).ok).toBe(true);
  });

  it('treats reformatted JSON as the same chart, and changed data as a different one', () => {
    expect(sameChartSource('{"type":"pie","x":["a"],"series":[{"name":"s","data":[1]}]}', '{\n  "series": [{ "data": [1], "name": "s" }],\n  "x": ["a"],\n  "type": "pie"\n}')).toBe(true);
    expect(sameChartSource('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameChartSource('not json', 'not json')).toBe(false);
  });

  it('opens JSON that is not an object in the JSON tab', () => {
    expect(draftFromSource('[1, 2]')).toBeNull();
    expect(draftFromSource('{ broken')).toBeNull();
  });
});

describe('link and image addresses', () => {
  it('allows web, mail and in-wiki addresses', () => {
    for (const href of ['https://example.com', 'http://example.com/a', 'mailto:a@example.com', '/spaces/API', '#section', 'relative/page']) {
      expect(isAllowedLinkTarget(href)).toBe(true);
    }
  });

  it('refuses script and data addresses', () => {
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', '']) {
      expect(isAllowedLinkTarget(href)).toBe(false);
    }
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.example/x.png', '']) {
      expect(isAllowedImageSource(src)).toBe(false);
    }
    expect(isAllowedImageSource('https://example.com/x.png')).toBe(true);
  });
});

describe('slash menu', () => {
  const label = (item: { labelKey: string }) => item.labelKey;

  it('offers every block when nothing is typed', () => {
    const ids = filterBlockItems('', label).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['h1', 'h2', 'h3', 'table', 'mermaid', 'chart', 'callout-warning', 'task', 'image', 'code', 'rule']));
  });

  it('matches English and Russian keywords', () => {
    expect(filterBlockItems('diagram', label).map((item) => item.id)).toContain('mermaid');
    expect(filterBlockItems('cha', label).map((item) => item.id)[0]).toBe('chart');
    expect(filterBlockItems('таблица', label).map((item) => item.id)).toEqual(['table']);
    expect(filterBlockItems('warning', label).map((item) => item.id)).toContain('callout-warning');
  });
});
