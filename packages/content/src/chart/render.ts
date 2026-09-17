import type {
  CategoricalChartSpec,
  ChartSpec,
  PartToWholeChartSpec,
  ScatterChartSpec,
} from './schema';

/**
 * Chart rendering: a validated chart spec in, an SVG out.
 *
 * Pure layout arithmetic — no DOM, no fonts, no runtime library — so the same
 * function draws a chart in the page view, in the editor preview and in the
 * HTML export, and an exported file shows its charts with scripting off and
 * when printed.
 *
 * The output is an element tree first and a string second. The tree is what
 * the Markdown pipeline turns into HTML nodes (and passes through the
 * sanitiser); the string is for anything that wants a standalone SVG. Both
 * come from one layout, so they cannot disagree.
 *
 * Colours are carried twice on purpose: every mark has a CSS class that the
 * application's stylesheet maps onto its light and dark tokens, and a plain
 * presentation attribute as the fallback for an SVG opened on its own. A CSS
 * rule beats a presentation attribute, so the class wins wherever a
 * stylesheet is present.
 */

/** Every element the renderer can emit. The sanitiser allowlist is this list. */
export const CHART_SVG_TAGS = ['svg', 'g', 'title', 'desc', 'path', 'rect', 'line', 'circle', 'text'] as const;
export type ChartSvgTag = (typeof CHART_SVG_TAGS)[number];

/** Every attribute the renderer can emit, by its SVG attribute name. */
export const CHART_SVG_ATTRIBUTES = [
  'class',
  'viewBox',
  'role',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'width',
  'height',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linejoin',
  'stroke-linecap',
  'text-anchor',
  'dominant-baseline',
  'font-size',
  'font-weight',
  'transform',
] as const;
export type ChartSvgAttribute = (typeof CHART_SVG_ATTRIBUTES)[number];

export interface ChartSvgNode {
  tag: ChartSvgTag;
  attrs: Partial<Record<ChartSvgAttribute, string>>;
  children: Array<ChartSvgNode | string>;
}

export interface ChartTheme {
  /** Which fallback colours the presentation attributes carry. Default light. */
  mode?: 'light' | 'dark';
}

/**
 * A fixed, ordered categorical palette of eight. The order is part of the
 * contract: series `n` is always colour `n`, and neighbouring colours stay
 * apart for the common forms of colour-blindness. Light and dark are separate
 * steps of the same hues rather than one set reused on both surfaces.
 */
export const CHART_PALETTE = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
} as const;

const INK = {
  light: { surface: '#fcfcfb', primary: '#0b0b0b', secondary: '#52514e', grid: '#e1e0d9', axis: '#c3c2b7' },
  dark: { surface: '#1a1a19', primary: '#ffffff', secondary: '#c3c2b7', grid: '#2c2c2a', axis: '#383835' },
} as const;

const WIDTH = 640;
const HEIGHT = 360;
const PIE_HEIGHT = 320;
const FONT_SIZE = 12;
const TITLE_SIZE = 14;
/** Average advance of one character at 12px in a system sans, for layout. */
const CHAR_WIDTH = 6.6;
const MAX_BAR_WIDTH = 24;
const BAR_RADIUS = 4;
/** Above this many marks, per-mark hover titles are left out to keep the SVG small. */
const MAX_MARK_TITLES = 400;

function el(
  tag: ChartSvgTag,
  attrs: Partial<Record<ChartSvgAttribute, string | number | undefined>> = {},
  children: Array<ChartSvgNode | string> = [],
): ChartSvgNode {
  const clean: Partial<Record<ChartSvgAttribute, string>> = {};
  for (const [key, value] of Object.entries(attrs) as Array<[ChartSvgAttribute, string | number | undefined]>) {
    if (value === undefined) continue;
    clean[key] = typeof value === 'number' ? fmt(value) : value;
  }
  return { tag, attrs: clean, children };
}

/** Coordinates to two decimals: exact enough, and stable across platforms. */
function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** A value as a reader sees it: grouped, compact when large, never in exponent form. */
export function formatChartValue(value: number): string {
  const abs = Math.abs(value);
  const compact = (divisor: number, suffix: string) =>
    `${(value / divisor).toLocaleString('en-US', { maximumFractionDigits: 1 })}${suffix}`;
  if (abs >= 1e9) return compact(1e9, 'B');
  if (abs >= 1e6) return compact(1e6, 'M');
  if (abs >= 1e5) return compact(1e3, 'k');
  if (abs > 0 && abs < 0.01) return value.toPrecision(2);
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function withUnit(value: number, unit: string | undefined): string {
  if (!unit) return formatChartValue(value);
  // Percent and degree signs sit against the number; words take a space.
  return /^[%°‰]/.test(unit) ? `${formatChartValue(value)}${unit}` : `${formatChartValue(value)} ${unit}`;
}

function textWidth(text: string, size = FONT_SIZE): number {
  return text.length * CHAR_WIDTH * (size / FONT_SIZE);
}

function truncate(text: string, maxWidth: number, size = FONT_SIZE): string {
  if (textWidth(text, size) <= maxWidth) return text;
  const chars = Math.max(1, Math.floor(maxWidth / (CHAR_WIDTH * (size / FONT_SIZE))) - 1);
  return `${text.slice(0, chars)}…`;
}

/* ------------------------------------------------------------------ */
/* Scales                                                              */
/* ------------------------------------------------------------------ */

function niceNumber(range: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let nice: number;
  if (round) nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  else nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

export interface NiceScale {
  min: number;
  max: number;
  ticks: number[];
}

/**
 * A domain widened to round numbers, with ticks at a 1-2-5 step. An explicit
 * minimum or maximum is kept as given; only the free ends are rounded.
 */
export function niceScale(
  dataMin: number,
  dataMax: number,
  fixed: { min?: number; max?: number } = {},
  maxTicks = 6,
): NiceScale {
  let low = fixed.min ?? dataMin;
  let high = fixed.max ?? dataMax;
  if (high < low) [low, high] = [high, low];
  if (high === low) {
    const pad = low === 0 ? 1 : Math.abs(low) * 0.5;
    if (fixed.min === undefined) low -= fixed.max === undefined ? pad : 2 * pad;
    if (fixed.max === undefined) high += fixed.min === undefined ? pad : 2 * pad;
  }
  const step = niceNumber(niceNumber(high - low, false) / (maxTicks - 1), true);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const round = (value: number) => Number(value.toFixed(Math.min(decimals, 12)));
  const min = fixed.min ?? round(Math.floor(low / step) * step);
  const max = fixed.max ?? round(Math.ceil(high / step) * step);
  const ticks: number[] = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k += 1) {
    ticks.push(round(k * step));
    if (ticks.length > 50) break;
  }
  return { min, max, ticks };
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

interface Context {
  mode: 'light' | 'dark';
  marks: number;
}

function seriesColor(ctx: Context, index: number): string {
  const palette = CHART_PALETTE[ctx.mode];
  return palette[index % palette.length] ?? palette[0];
}

function typeName(type: ChartSpec['type']): string {
  switch (type) {
    case 'stacked-bar':
      return 'Stacked bar chart';
    case 'donut':
      return 'Donut chart';
    default:
      return `${type.charAt(0).toUpperCase()}${type.slice(1)} chart`;
  }
}

function describe(spec: ChartSpec): string {
  const parts: string[] = [typeName(spec.type)];
  if (spec.type === 'scatter') {
    parts.push(`with ${spec.series.length} series: ${spec.series.map((entry) => `${entry.name} (${entry.data.length} points)`).join('; ')}.`);
  } else {
    const [first] = spec.series;
    if (spec.type === 'pie' || spec.type === 'donut') {
      parts.push(`of ${spec.x.length} slices:`);
      parts.push(
        `${spec.x
          .map((label, index) => `${label} ${withUnit(first?.data[index] ?? 0, spec.unit)}`)
          .join('; ')}.`,
      );
    } else {
      parts.push(`with ${spec.series.length} series over ${spec.x.length} categories.`);
      if (spec.x.length <= 24) {
        for (const entry of spec.series) {
          parts.push(
            `${entry.name}: ${entry.data
              .map((value, index) => `${spec.x[index] ?? ''} ${withUnit(value, spec.unit)}`)
              .join('; ')}.`,
          );
        }
      }
    }
  }
  return parts.join(' ');
}

interface Frame {
  width: number;
  height: number;
  top: number;
}

function header(spec: ChartSpec, ctx: Context, frame: Frame): ChartSvgNode[] {
  const ink = INK[ctx.mode];
  const nodes: ChartSvgNode[] = [
    el('title', {}, [spec.title ?? typeName(spec.type)]),
    el('desc', {}, [describe(spec)]),
    el('rect', {
      class: 'chart-surface',
      x: 0,
      y: 0,
      width: frame.width,
      height: frame.height,
      fill: ink.surface,
    }),
  ];
  if (spec.title) {
    nodes.push(
      el(
        'text',
        {
          class: 'chart-title',
          x: 16,
          y: 24,
          'font-size': TITLE_SIZE,
          'font-weight': '600',
          fill: ink.primary,
        },
        [truncate(spec.title, frame.width - 32, TITLE_SIZE)],
      ),
    );
  }
  return nodes;
}

interface LegendItem {
  label: string;
  colorIndex: number;
}

function legendRows(items: LegendItem[], maxWidth: number): LegendItem[][] {
  const rows: LegendItem[][] = [[]];
  let used = 0;
  for (const item of items) {
    const width = 18 + textWidth(truncate(item.label, maxWidth - 18)) + 16;
    const row = rows[rows.length - 1] as LegendItem[];
    if (used + width > maxWidth && row.length > 0) {
      rows.push([item]);
      used = width;
    } else {
      row.push(item);
      used += width;
    }
  }
  return rows;
}

const LEGEND_ROW = 20;

function legend(items: LegendItem[], ctx: Context, frame: Frame, top: number): ChartSvgNode {
  const ink = INK[ctx.mode];
  const maxWidth = frame.width - 32;
  const children: ChartSvgNode[] = [];
  legendRows(items, maxWidth).forEach((row, rowIndex) => {
    let x = 16;
    const y = top + rowIndex * LEGEND_ROW;
    for (const item of row) {
      const label = truncate(item.label, maxWidth - 18);
      children.push(
        el('rect', {
          class: `chart-fill-${(item.colorIndex % 8) + 1}`,
          x,
          y: y - 9,
          width: 10,
          height: 10,
          fill: seriesColor(ctx, item.colorIndex),
        }),
        el('text', { class: 'chart-label', x: x + 16, y, 'font-size': FONT_SIZE, fill: ink.secondary }, [label]),
      );
      x += 18 + textWidth(label) + 16;
    }
  });
  return el('g', { class: 'chart-legend' }, children);
}

function legendHeight(items: LegendItem[], frame: Frame): number {
  return items.length === 0 ? 0 : legendRows(items, frame.width - 32).length * LEGEND_ROW + 8;
}

function svgRoot(frame: Frame, children: ChartSvgNode[], type: string): ChartSvgNode {
  return el(
    'svg',
    {
      class: `chart chart-${type}`,
      viewBox: `0 0 ${frame.width} ${frame.height}`,
      role: 'img',
    },
    children,
  );
}

function markTitle(ctx: Context, text: string): ChartSvgNode[] {
  return ctx.marks <= MAX_MARK_TITLES ? [el('title', {}, [text])] : [];
}

/** A bar with a rounded data end and a square end on the baseline. */
function barPath(x: number, width: number, base: number, end: number): string {
  const height = Math.abs(base - end);
  const r = Math.min(BAR_RADIUS, width / 2, height);
  if (height === 0 || width <= 0) return `M${fmt(x)} ${fmt(base)}h${fmt(Math.max(width, 0))}`;
  if (end < base) {
    return `M${fmt(x)} ${fmt(base)}V${fmt(end + r)}Q${fmt(x)} ${fmt(end)} ${fmt(x + r)} ${fmt(end)}H${fmt(x + width - r)}Q${fmt(x + width)} ${fmt(end)} ${fmt(x + width)} ${fmt(end + r)}V${fmt(base)}Z`;
  }
  return `M${fmt(x)} ${fmt(base)}V${fmt(end - r)}Q${fmt(x)} ${fmt(end)} ${fmt(x + r)} ${fmt(end)}H${fmt(x + width - r)}Q${fmt(x + width)} ${fmt(end)} ${fmt(x + width)} ${fmt(end - r)}V${fmt(base)}Z`;
}

/* ------------------------------------------------------------------ */
/* Cartesian charts                                                    */
/* ------------------------------------------------------------------ */

interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function yTitleOf(spec: CategoricalChartSpec | ScatterChartSpec): string | undefined {
  const label = spec.y?.label;
  if (label && spec.unit) return `${label} (${spec.unit})`;
  return label ?? spec.unit;
}

function valueAxis(
  scale: NiceScale,
  y: (value: number) => number,
  plot: Plot,
  ctx: Context,
  title: string | undefined,
  titleX: number,
): ChartSvgNode[] {
  const ink = INK[ctx.mode];
  const nodes: ChartSvgNode[] = [];
  const grid: ChartSvgNode[] = [];
  const labels: ChartSvgNode[] = [];
  for (const tick of scale.ticks) {
    const ty = y(tick);
    grid.push(
      el('line', {
        class: tick === 0 ? 'chart-axis' : 'chart-grid',
        x1: plot.left,
        x2: plot.right,
        y1: ty,
        y2: ty,
        stroke: tick === 0 ? ink.axis : ink.grid,
        'stroke-width': 1,
      }),
    );
    labels.push(
      el(
        'text',
        {
          class: 'chart-tick',
          x: plot.left - 8,
          y: ty,
          'text-anchor': 'end',
          'dominant-baseline': 'middle',
          'font-size': FONT_SIZE,
          fill: ink.secondary,
        },
        [formatChartValue(tick)],
      ),
    );
  }
  nodes.push(el('g', { class: 'chart-gridlines' }, grid), el('g', { class: 'chart-ticks' }, labels));
  if (title) {
    const cy = (plot.top + plot.bottom) / 2;
    nodes.push(
      el(
        'text',
        {
          class: 'chart-label',
          x: titleX,
          y: cy,
          'text-anchor': 'middle',
          'font-size': FONT_SIZE,
          fill: ink.secondary,
          transform: `rotate(-90 ${fmt(titleX)} ${fmt(cy)})`,
        },
        [truncate(title, plot.bottom - plot.top)],
      ),
    );
  }
  return nodes;
}

function renderCategorical(spec: CategoricalChartSpec, ctx: Context): ChartSvgNode {
  const frame: Frame = { width: WIDTH, height: HEIGHT, top: spec.title ? 44 : 16 };
  const ink = INK[ctx.mode];
  const n = spec.x.length;
  const stacked = spec.type === 'stacked-bar';

  let dataMin = Infinity;
  let dataMax = -Infinity;
  if (stacked) {
    for (let i = 0; i < n; i += 1) {
      const total = spec.series.reduce((sum, entry) => sum + (entry.data[i] ?? 0), 0);
      dataMax = Math.max(dataMax, total);
    }
    dataMin = 0;
  } else {
    for (const entry of spec.series) {
      for (const value of entry.data) {
        dataMin = Math.min(dataMin, value);
        dataMax = Math.max(dataMax, value);
      }
    }
  }
  // Bars and areas are read by their length from zero, so zero is always on
  // the axis; a line is read by its shape, so its axis follows the data.
  if (spec.type !== 'line') {
    dataMin = Math.min(dataMin, 0);
    dataMax = Math.max(dataMax, 0);
  }
  const scale = niceScale(dataMin, dataMax, { min: spec.y?.min, max: spec.y?.max });

  const legendItems: LegendItem[] =
    spec.series.length > 1 ? spec.series.map((entry, index) => ({ label: entry.name, colorIndex: index })) : [];
  const legendSpace = legendHeight(legendItems, frame);
  const yTitle = yTitleOf(spec);
  const tickWidth = Math.max(...scale.ticks.map((tick) => textWidth(formatChartValue(tick))));
  const left = 16 + (yTitle ? 20 : 0) + tickWidth + 8;
  const right = WIDTH - 16;
  const plotWidth = right - left;
  const band = plotWidth / n;

  // Category labels: level when they fit, tilted when they do not, and thinned
  // out when there are more categories than room for any label at all.
  const every = Math.max(1, Math.ceil((n * 16) / plotWidth));
  const shownLabels = spec.x.filter((_, index) => index % every === 0);
  const widest = Math.max(0, ...shownLabels.map((label) => textWidth(label)));
  const tilted = widest > band * every - 6;
  const labelChars = 18;
  const tiltedHeight = Math.min(widest, labelChars * CHAR_WIDTH) * Math.sin(Math.PI / 4.5) + 14;
  const xLabelSpace = tilted ? tiltedHeight + 8 : 24;

  const plot: Plot = {
    left,
    right,
    top: frame.top + 8,
    bottom: HEIGHT - 8 - legendSpace - xLabelSpace,
  };
  const y = (value: number) => {
    const clamped = Math.min(Math.max(value, scale.min), scale.max);
    return plot.bottom - ((clamped - scale.min) / (scale.max - scale.min)) * (plot.bottom - plot.top);
  };
  const center = (index: number) => left + band * (index + 0.5);
  const baseline = y(Math.min(Math.max(0, scale.min), scale.max));

  const children: ChartSvgNode[] = header(spec, ctx, frame);
  children.push(...valueAxis(scale, y, plot, ctx, yTitle, 16 + 6));

  const marks: ChartSvgNode[] = [];
  if (spec.type === 'bar') {
    const count = spec.series.length;
    const gap = count > 1 ? 2 : 0;
    const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, (band * 0.72 - gap * (count - 1)) / count));
    const groupWidth = barWidth * count + gap * (count - 1);
    spec.series.forEach((entry, seriesIndex) => {
      const bars = entry.data.map((value, index) => {
        const x = center(index) - groupWidth / 2 + seriesIndex * (barWidth + gap);
        return el('path', { d: barPath(x, barWidth, baseline, y(value)) }, markTitle(ctx, `${entry.name} · ${spec.x[index] ?? ''}: ${withUnit(value, spec.unit)}`));
      });
      marks.push(
        el('g', { class: `chart-series chart-fill-${seriesIndex + 1}`, fill: seriesColor(ctx, seriesIndex) }, bars),
      );
    });
  } else if (stacked) {
    const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH * 1.5, band * 0.6));
    const offsets = new Array<number>(n).fill(0);
    const totals = spec.x.map((_, index) => spec.series.reduce((sum, entry) => sum + (entry.data[index] ?? 0), 0));
    spec.series.forEach((entry, seriesIndex) => {
      const segments: ChartSvgNode[] = [];
      entry.data.forEach((value, index) => {
        if (value <= 0) return;
        const from = offsets[index] ?? 0;
        const to = from + value;
        offsets[index] = to;
        const x = center(index) - barWidth / 2;
        const bottomY = y(from);
        const topY = y(to);
        const isTop = to >= (totals[index] ?? 0) - 1e-9;
        // Segments are separated by a strip of surface rather than by an
        // outline; the topmost carries the rounded end.
        const lowerY = from > 0 ? bottomY - 1 : bottomY;
        const upperY = isTop ? topY : Math.min(topY + 1, lowerY);
        const d = isTop
          ? barPath(x, barWidth, lowerY, upperY)
          : `M${fmt(x)} ${fmt(lowerY)}V${fmt(upperY)}H${fmt(x + barWidth)}V${fmt(lowerY)}Z`;
        segments.push(el('path', { d }, markTitle(ctx, `${entry.name} · ${spec.x[index] ?? ''}: ${withUnit(value, spec.unit)}`)));
      });
      marks.push(
        el('g', { class: `chart-series chart-fill-${seriesIndex + 1}`, fill: seriesColor(ctx, seriesIndex) }, segments),
      );
    });
  } else {
    const showMarkers = n <= 40;
    spec.series.forEach((entry, seriesIndex) => {
      const color = seriesColor(ctx, seriesIndex);
      const points = entry.data.map((value, index) => [center(index), y(value)] as const);
      const line = points.map(([px, py], index) => `${index === 0 ? 'M' : 'L'}${fmt(px)} ${fmt(py)}`).join('');
      const group: ChartSvgNode[] = [];
      if (spec.type === 'area') {
        const first = points[0];
        const last = points[points.length - 1];
        if (first && last) {
          group.push(
            el('path', {
              class: `chart-fill-${seriesIndex + 1}`,
              d: `${line}L${fmt(last[0])} ${fmt(baseline)}L${fmt(first[0])} ${fmt(baseline)}Z`,
              fill: color,
              'fill-opacity': '0.12',
            }),
          );
        }
      }
      group.push(
        el('path', {
          class: `chart-stroke-${seriesIndex + 1}`,
          d: points.length === 1 ? `${line}h0.01` : line,
          fill: 'none',
          stroke: color,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        }),
      );
      if (showMarkers) {
        group.push(
          el(
            'g',
            { class: `chart-fill-${seriesIndex + 1} chart-ring`, fill: color, stroke: ink.surface, 'stroke-width': 2 },
            entry.data.map((value, index) =>
              el('circle', { cx: center(index), cy: y(value), r: 4 }, markTitle(ctx, `${entry.name} · ${spec.x[index] ?? ''}: ${withUnit(value, spec.unit)}`)),
            ),
          ),
        );
      }
      marks.push(el('g', { class: 'chart-series' }, group));
    });
  }
  children.push(el('g', { class: 'chart-marks' }, marks));

  const labelNodes: ChartSvgNode[] = [];
  spec.x.forEach((label, index) => {
    if (index % every !== 0) return;
    const cx = center(index);
    const ly = plot.bottom + 16;
    if (tilted) {
      labelNodes.push(
        el(
          'text',
          {
            class: 'chart-tick',
            x: cx,
            y: ly,
            'text-anchor': 'end',
            'font-size': FONT_SIZE,
            fill: ink.secondary,
            transform: `rotate(-40 ${fmt(cx)} ${fmt(ly)})`,
          },
          [truncate(label, labelChars * CHAR_WIDTH)],
        ),
      );
    } else {
      labelNodes.push(
        el(
          'text',
          { class: 'chart-tick', x: cx, y: ly, 'text-anchor': 'middle', 'font-size': FONT_SIZE, fill: ink.secondary },
          [label],
        ),
      );
    }
  });
  children.push(el('g', { class: 'chart-ticks' }, labelNodes));
  if (legendItems.length > 0) children.push(legend(legendItems, ctx, frame, HEIGHT - legendSpace + 12));

  return svgRoot(frame, children, spec.type);
}

function renderScatter(spec: ScatterChartSpec, ctx: Context): ChartSvgNode {
  const frame: Frame = { width: WIDTH, height: HEIGHT, top: spec.title ? 44 : 16 };
  const ink = INK[ctx.mode];
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const entry of spec.series) {
    for (const [px, py] of entry.data) {
      xMin = Math.min(xMin, px);
      xMax = Math.max(xMax, px);
      yMin = Math.min(yMin, py);
      yMax = Math.max(yMax, py);
    }
  }
  const yScale = niceScale(yMin, yMax, { min: spec.y?.min, max: spec.y?.max });
  const xScale = niceScale(xMin, xMax, {}, 7);

  const legendItems: LegendItem[] =
    spec.series.length > 1 ? spec.series.map((entry, index) => ({ label: entry.name, colorIndex: index })) : [];
  const legendSpace = legendHeight(legendItems, frame);
  const yTitle = yTitleOf(spec);
  const tickWidth = Math.max(...yScale.ticks.map((tick) => textWidth(formatChartValue(tick))));
  const plot: Plot = {
    left: 16 + (yTitle ? 20 : 0) + tickWidth + 8,
    right: WIDTH - 24,
    top: frame.top + 8,
    bottom: HEIGHT - 8 - legendSpace - 24,
  };
  const x = (value: number) =>
    plot.left + ((value - xScale.min) / (xScale.max - xScale.min)) * (plot.right - plot.left);
  const y = (value: number) => {
    const clamped = Math.min(Math.max(value, yScale.min), yScale.max);
    return plot.bottom - ((clamped - yScale.min) / (yScale.max - yScale.min)) * (plot.bottom - plot.top);
  };

  const children = header(spec, ctx, frame);
  children.push(...valueAxis(yScale, y, plot, ctx, yTitle, 22));
  children.push(
    el('line', {
      class: 'chart-axis',
      x1: plot.left,
      x2: plot.right,
      y1: plot.bottom,
      y2: plot.bottom,
      stroke: ink.axis,
      'stroke-width': 1,
    }),
    el(
      'g',
      { class: 'chart-ticks' },
      xScale.ticks.map((tick) =>
        el(
          'text',
          { class: 'chart-tick', x: x(tick), y: plot.bottom + 16, 'text-anchor': 'middle', 'font-size': FONT_SIZE, fill: ink.secondary },
          [formatChartValue(tick)],
        ),
      ),
    ),
  );
  children.push(
    el(
      'g',
      { class: 'chart-marks' },
      spec.series.map((entry, seriesIndex) =>
        el(
          'g',
          {
            class: `chart-series chart-fill-${seriesIndex + 1} chart-ring`,
            fill: seriesColor(ctx, seriesIndex),
            stroke: ink.surface,
            'stroke-width': 2,
          },
          entry.data.map(([px, py]) =>
            el('circle', { cx: x(px), cy: y(py), r: 4 }, markTitle(ctx, `${entry.name}: ${formatChartValue(px)}, ${withUnit(py, spec.unit)}`)),
          ),
        ),
      ),
    ),
  );
  if (legendItems.length > 0) children.push(legend(legendItems, ctx, frame, HEIGHT - legendSpace + 12));
  return svgRoot(frame, children, spec.type);
}

/* ------------------------------------------------------------------ */
/* Pie and donut                                                       */
/* ------------------------------------------------------------------ */

function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function slicePath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, outer, start);
  const [x1, y1] = polar(cx, cy, outer, end);
  if (inner <= 0) {
    return `M${fmt(cx)} ${fmt(cy)}L${fmt(x0)} ${fmt(y0)}A${fmt(outer)} ${fmt(outer)} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)}Z`;
  }
  const [x2, y2] = polar(cx, cy, inner, end);
  const [x3, y3] = polar(cx, cy, inner, start);
  return `M${fmt(x0)} ${fmt(y0)}A${fmt(outer)} ${fmt(outer)} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)}L${fmt(x2)} ${fmt(y2)}A${fmt(inner)} ${fmt(inner)} 0 ${large} 0 ${fmt(x3)} ${fmt(y3)}Z`;
}

function renderPartToWhole(spec: PartToWholeChartSpec, ctx: Context): ChartSvgNode {
  const frame: Frame = { width: WIDTH, height: PIE_HEIGHT, top: spec.title ? 44 : 16 };
  const ink = INK[ctx.mode];
  const values = spec.series[0]?.data ?? [];
  const total = values.reduce((sum, value) => sum + value, 0);
  const percent = (value: number) => `${((value / total) * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

  const legendItems: LegendItem[] = spec.x.map((label, index) => ({
    label: `${label} — ${withUnit(values[index] ?? 0, spec.unit)} (${percent(values[index] ?? 0)})`,
    colorIndex: index,
  }));
  const legendSpace = legendHeight(legendItems, frame);
  const available = PIE_HEIGHT - frame.top - 8 - legendSpace - 8;
  const outer = Math.max(24, Math.min(available / 2, 130));
  const inner = spec.type === 'donut' ? outer * 0.6 : 0;
  const cx = WIDTH / 2;
  const cy = frame.top + 8 + available / 2;

  const children = header(spec, ctx, frame);
  const slices: ChartSvgNode[] = [];
  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    if (value <= 0) return;
    const sweep = (value / total) * Math.PI * 2;
    const label = `${spec.x[index] ?? ''}: ${withUnit(value, spec.unit)} (${percent(value)})`;
    const attrs = {
      class: `chart-fill-${index + 1} chart-ring`,
      fill: seriesColor(ctx, index),
      stroke: ink.surface,
      'stroke-width': 2,
    };
    if (sweep >= Math.PI * 2 - 1e-6) {
      // A single slice is the whole circle, which one arc cannot draw.
      slices.push(
        inner > 0
          ? el('path', {
              ...attrs,
              d: `${slicePath(cx, cy, outer, inner, angle, angle + Math.PI)}${slicePath(cx, cy, outer, inner, angle + Math.PI, angle + Math.PI * 2)}`,
            }, markTitle(ctx, label))
          : el('circle', { ...attrs, cx, cy, r: outer }, markTitle(ctx, label)),
      );
    } else {
      slices.push(el('path', { ...attrs, d: slicePath(cx, cy, outer, inner, angle, angle + sweep) }, markTitle(ctx, label)));
    }
    angle += sweep;
  });
  children.push(el('g', { class: 'chart-marks' }, slices));
  if (inner > 0) {
    children.push(
      el(
        'text',
        {
          class: 'chart-title',
          x: cx,
          y: cy,
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
          'font-size': TITLE_SIZE,
          'font-weight': '600',
          fill: ink.primary,
        },
        [withUnit(total, spec.unit)],
      ),
    );
  }
  children.push(legend(legendItems, ctx, frame, PIE_HEIGHT - legendSpace + 12));
  return svgRoot(frame, children, spec.type);
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

function countMarks(spec: ChartSpec): number {
  if (spec.type === 'pie' || spec.type === 'donut') return spec.x.length;
  return spec.series.reduce((sum, entry) => sum + entry.data.length, 0);
}

/** Lays a validated chart out as an SVG element tree. */
export function buildChartTree(spec: ChartSpec, theme: ChartTheme = {}): ChartSvgNode {
  const ctx: Context = { mode: theme.mode ?? 'light', marks: countMarks(spec) };
  switch (spec.type) {
    case 'pie':
    case 'donut':
      return renderPartToWhole(spec, ctx);
    case 'scatter':
      return renderScatter(spec, ctx);
    default:
      return renderCategorical(spec, ctx);
  }
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;');
}

function serialize(node: ChartSvgNode, root: boolean): string {
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join('');
  const namespace = root ? ' xmlns="http://www.w3.org/2000/svg"' : '';
  const children = node.children
    .map((child) => (typeof child === 'string' ? escapeText(child) : serialize(child, false)))
    .join('');
  return `<${node.tag}${namespace}${attrs}>${children}</${node.tag}>`;
}

/** Renders a validated chart to a standalone SVG document string. */
export function renderChartSvg(spec: ChartSpec, theme: ChartTheme = {}): string {
  return serialize(buildChartTree(spec, theme), true);
}
