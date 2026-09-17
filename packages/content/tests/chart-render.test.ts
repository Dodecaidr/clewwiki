import { describe, expect, it } from 'vitest';

import {
  buildChartTree,
  CHART_EXAMPLES,
  CHART_SVG_ATTRIBUTES,
  CHART_SVG_TAGS,
  CHART_TYPES,
  formatChartValue,
  niceScale,
  renderChartSvg,
} from '../src/chart';
import type { ChartSpec, ChartSvgNode } from '../src/chart';

function walk(node: ChartSvgNode, visit: (node: ChartSvgNode) => void): void {
  visit(node);
  for (const child of node.children) if (typeof child !== 'string') walk(child, visit);
}

describe('niceScale', () => {
  it('widens a range to round numbers with a 1-2-5 step', () => {
    expect(niceScale(0, 410)).toEqual({ min: 0, max: 500, ticks: [0, 100, 200, 300, 400, 500] });
    expect(niceScale(-3, 7).ticks).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceScale(0.1, 0.9).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('keeps explicit bounds and survives a flat series', () => {
    expect(niceScale(10, 20, { min: 0, max: 50 })).toMatchObject({ min: 0, max: 50 });
    const flat = niceScale(5, 5);
    expect(flat.max).toBeGreaterThan(flat.min);
  });
});

describe('formatChartValue', () => {
  it('groups, compacts and never uses exponents', () => {
    expect(formatChartValue(1284)).toBe('1,284');
    expect(formatChartValue(250_000)).toBe('250k');
    expect(formatChartValue(4_200_000)).toBe('4.2M');
    expect(formatChartValue(0.5)).toBe('0.5');
  });
});

describe('renderChartSvg', () => {
  it.each(CHART_TYPES)('draws the %s example as an accessible SVG', (type) => {
    const svg = renderChartSvg(CHART_EXAMPLES[type]);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toMatch(/<title>[^<]+<\/title><desc>[^<]+<\/desc>/);
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('undefined');
  });

  it('emits only the elements and attributes the sanitiser allows', () => {
    const tags = new Set<string>(CHART_SVG_TAGS);
    const attributes = new Set<string>(CHART_SVG_ATTRIBUTES);
    for (const type of CHART_TYPES) {
      walk(buildChartTree(CHART_EXAMPLES[type], { mode: 'dark' }), (node) => {
        expect(tags.has(node.tag)).toBe(true);
        for (const key of Object.keys(node.attrs)) expect(attributes.has(key)).toBe(true);
      });
    }
  });

  it('escapes text taken from the spec', () => {
    const spec: ChartSpec = {
      type: 'bar',
      title: '<script>alert(1)</script>',
      x: ['"><img src=x onerror=alert(1)>'],
      series: [{ name: 'a & b', data: [1] }],
    };
    const svg = renderChartSvg(spec);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('a &amp; b');
  });

  it('writes percent signs against the number and other units after a space', () => {
    expect(renderChartSvg(CHART_EXAMPLES.donut)).toContain('Spent — 28% (28%)');
    expect(renderChartSvg(CHART_EXAMPLES.bar)).toContain('API 180 ms');
  });

  it('is deterministic', () => {
    expect(renderChartSvg(CHART_EXAMPLES.bar)).toBe(renderChartSvg(CHART_EXAMPLES.bar));
  });

  it('describes the data in <desc> for screen readers', () => {
    const svg = renderChartSvg(CHART_EXAMPLES.bar);
    expect(svg).toContain('Before: API 180 ms; Worker 420 ms; Search 260 ms.');
  });

  it('draws a single full slice as a circle and a legend with percentages', () => {
    const svg = renderChartSvg({ type: 'pie', x: ['All'], series: [{ name: 's', data: [3] }] });
    expect(svg).toContain('<circle');
    expect(svg).toContain('All — 3 (100%)');
  });

  it('marks series with palette classes for light and dark styling', () => {
    const light = renderChartSvg(CHART_EXAMPLES['stacked-bar']);
    const dark = renderChartSvg(CHART_EXAMPLES['stacked-bar'], { mode: 'dark' });
    expect(light).toContain('chart-fill-3');
    expect(light).toContain('#2a78d6');
    expect(dark).toContain('#3987e5');
  });

  it('handles large series without per-mark titles', () => {
    const data = Array.from({ length: 1000 }, (_, index) => Math.sin(index / 20) * 100);
    const svg = renderChartSvg({ type: 'line', x: data.map((_, index) => String(index)), series: [{ name: 'wave', data }] });
    expect(svg.match(/<title>/g)).toHaveLength(1);
    expect(svg).not.toContain('NaN');
  });
});
