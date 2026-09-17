import { describe, expect, it } from 'vitest';

import { CHART_EXAMPLES, CHART_LIMITS, CHART_TYPES, chartSpecSchema, parseChartSource } from '../src/chart';

function errorsOf(source: unknown): Array<{ path: string; message: string }> {
  const result = parseChartSource(typeof source === 'string' ? source : JSON.stringify(source));
  if (result.ok) throw new Error('expected the chart to be refused');
  return result.errors;
}

describe('chart schema', () => {
  it.each(CHART_TYPES)('accepts the %s example', (type) => {
    const result = parseChartSource(JSON.stringify(CHART_EXAMPLES[type]));
    expect(result.ok).toBe(true);
  });

  it('refuses a series whose length differs from x, naming the path', () => {
    const errors = errorsOf({ type: 'bar', x: ['a', 'b', 'c'], series: [{ name: 'API', data: [1, 2] }] });
    expect(errors).toEqual([
      { path: 'series.0.data', message: 'series 0 ("API") has 2 values but x has 3 labels; they must be equal' },
    ]);
  });

  it('refuses an unknown chart type with the list of known ones', () => {
    const errors = errorsOf({ type: 'radar', x: ['a'], series: [{ name: 's', data: [1] }] });
    expect(errors[0]?.path).toBe('type');
    expect(errors[0]?.message).toContain('bar, line, area, pie, donut, scatter, stacked-bar');
  });

  it('refuses unknown fields, so a typo is reported rather than ignored', () => {
    const errors = errorsOf({ type: 'line', x: ['a'], series: [{ name: 's', data: [1] }], colour: 'red' });
    expect(errors.some((error) => error.message.includes('colour'))).toBe(true);
  });

  it('refuses non-numeric values', () => {
    const errors = errorsOf({ type: 'line', x: ['a', 'b'], series: [{ name: 's', data: [1, '2'] }] });
    expect(errors[0]?.path).toBe('series.0.data.1');
  });

  it('refuses NaN and Infinity built in code', () => {
    const spec = { type: 'bar', x: ['a', 'b'], series: [{ name: 's', data: [Number.NaN, Number.POSITIVE_INFINITY] }] };
    const result = chartSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  it('caps series, points and string lengths', () => {
    const series = Array.from({ length: CHART_LIMITS.maxSeries + 1 }, (_, index) => ({ name: `s${index}`, data: [1] }));
    expect(errorsOf({ type: 'bar', x: ['a'], series })[0]?.path).toBe('series');

    const many = Array.from({ length: CHART_LIMITS.maxPoints + 1 }, () => 1);
    const labels = many.map((_, index) => `p${index}`);
    expect(errorsOf({ type: 'line', x: labels, series: [{ name: 's', data: many }] }).map((e) => e.path)).toContain('x');

    expect(errorsOf({ type: 'bar', title: 'x'.repeat(CHART_LIMITS.maxTitleLength + 1), x: ['a'], series: [{ name: 's', data: [1] }] })[0]?.path).toBe('title');
    expect(errorsOf({ type: 'bar', x: ['a'.repeat(CHART_LIMITS.maxLabelLength + 1)], series: [{ name: 's', data: [1] }] })[0]?.path).toBe('x.0');
  });

  it('takes scatter data as [x, y] pairs and refuses x on a scatter chart', () => {
    expect(parseChartSource(JSON.stringify({ type: 'scatter', series: [{ name: 's', data: [[1, 2], [3, 4]] }] })).ok).toBe(true);
    expect(errorsOf({ type: 'scatter', series: [{ name: 's', data: [1, 2] }] })[0]?.path).toBe('series.0.data.0');
    expect(errorsOf({ type: 'scatter', x: ['a'], series: [{ name: 's', data: [[1, 2]] }] })[0]?.message).toContain('x');
  });

  it('holds pie and donut charts to one non-negative series with a positive total', () => {
    expect(errorsOf({ type: 'pie', x: ['a', 'b'], series: [{ name: 's', data: [1, 1] }, { name: 't', data: [1, 1] }] })[0]?.path).toBe('series');
    expect(errorsOf({ type: 'donut', x: ['a', 'b'], series: [{ name: 's', data: [1, -1] }] })[0]?.path).toBe('series.0.data.1');
    expect(errorsOf({ type: 'pie', x: ['a', 'b'], series: [{ name: 's', data: [0, 0] }] })[0]?.message).toContain('add up to more than 0');
    const slices = Array.from({ length: CHART_LIMITS.maxSlices + 1 }, (_, index) => `s${index}`);
    expect(errorsOf({ type: 'pie', x: slices, series: [{ name: 's', data: slices.map(() => 1) }] })[0]?.path).toBe('x');
  });

  it('refuses negative stacked values and an inverted y range', () => {
    expect(errorsOf({ type: 'stacked-bar', x: ['a'], series: [{ name: 's', data: [-1] }] })[0]?.path).toBe('series.0.data.0');
    expect(errorsOf({ type: 'line', x: ['a'], series: [{ name: 's', data: [1] }], y: { min: 5, max: 5 } })[0]?.path).toBe('y.max');
  });

  it('explains JSON syntax errors, empty blocks and oversize blocks', () => {
    expect(errorsOf('{ "type": "bar", }')[0]?.message).toMatch(/^not valid JSON/);
    expect(errorsOf('   ')[0]?.message).toContain('empty');
    expect(errorsOf('[1, 2]')[0]?.message).toContain('one JSON object');
    expect(errorsOf(' '.repeat(CHART_LIMITS.maxSourceBytes + 1))[0]?.message).toContain('bytes');
  });
});
