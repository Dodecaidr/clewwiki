import type { ChartSpec, ChartType } from './schema';

/**
 * One minimal, valid chart per type. The format guide quotes them, the editor
 * inserts them as starting points, and a test parses every one of them with the
 * schema — so an example that stops being valid fails the build rather than
 * teaching an agent something the server refuses.
 */
export const CHART_EXAMPLES: Record<ChartType, ChartSpec> = {
  bar: {
    type: 'bar',
    title: 'p95 latency by service',
    x: ['API', 'Worker', 'Search'],
    series: [
      { name: 'Before', data: [180, 420, 260] },
      { name: 'After', data: [120, 300, 240] },
    ],
    unit: 'ms',
    y: { min: 0, label: 'Latency' },
  },
  line: {
    type: 'line',
    title: 'Weekly active users',
    x: ['W1', 'W2', 'W3', 'W4'],
    series: [{ name: 'Users', data: [1200, 1350, 1310, 1580] }],
  },
  area: {
    type: 'area',
    title: 'Storage used',
    x: ['Jan', 'Feb', 'Mar', 'Apr'],
    series: [{ name: 'Storage', data: [40, 52, 61, 75] }],
    unit: 'GB',
  },
  'stacked-bar': {
    type: 'stacked-bar',
    title: 'Requests by status',
    x: ['Mon', 'Tue', 'Wed'],
    series: [
      { name: '2xx', data: [920, 870, 990] },
      { name: '4xx', data: [40, 52, 31] },
      { name: '5xx', data: [3, 9, 2] },
    ],
  },
  pie: {
    type: 'pie',
    title: 'Pages by kind',
    x: ['Technical', 'Human'],
    series: [{ name: 'Pages', data: [64, 36] }],
  },
  donut: {
    type: 'donut',
    title: 'Error budget spent',
    x: ['Spent', 'Remaining'],
    series: [{ name: 'Budget', data: [28, 72] }],
    unit: '%',
  },
  scatter: {
    type: 'scatter',
    title: 'Page size against render time',
    series: [
      {
        name: 'Pages',
        data: [
          [2, 40],
          [8, 95],
          [15, 160],
          [21, 240],
        ],
      },
    ],
    unit: 'ms',
    y: { label: 'Render time' },
  },
};

/** An example as it is written into a page: a fenced `chart` block. */
export function chartExampleBlock(type: ChartType): string {
  return `\`\`\`chart\n${JSON.stringify(CHART_EXAMPLES[type], null, 2)}\n\`\`\``;
}
