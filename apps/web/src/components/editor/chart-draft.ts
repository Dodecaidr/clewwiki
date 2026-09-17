import { CHART_EXAMPLES, CHART_TYPES } from '@clewwiki/content/chart';
import type { ChartType } from '@clewwiki/content/chart';

/**
 * The chart editor's working copy.
 *
 * Grid cells hold what was typed, as text, so "-" or "1." can be on the way to
 * a number without being thrown away. The draft is turned into chart JSON on
 * every change and that JSON is validated with the chart schema, so a cell that
 * is not a number is reported by the same rule, with the same path, that the
 * server would use.
 */

export interface ChartDraft {
  type: ChartType;
  title: string;
  unit: string;
  yMin: string;
  yMax: string;
  yLabel: string;
  /** Category or slice labels; unused by scatter charts. */
  x: string[];
  /** One entry per series. Categorical: one value per label. Scatter: [x, y] pairs. */
  series: Array<{ name: string; values: string[]; points: Array<[string, string]> }>;
}

export function isScatter(type: ChartType): boolean {
  return type === 'scatter';
}

export function isPartToWhole(type: ChartType): boolean {
  return type === 'pie' || type === 'donut';
}

function cell(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return '';
}

function toNumberOrText(value: string): number | string {
  const trimmed = value.trim();
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return value;
}

/** A draft from chart JSON that may or may not be valid. `null` when it is not a JSON object. */
export function draftFromSource(source: string): ChartDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const spec = raw as Record<string, unknown>;
  const type = (CHART_TYPES as readonly string[]).includes(String(spec.type)) ? (spec.type as ChartType) : 'bar';
  const y = (spec.y && typeof spec.y === 'object' ? spec.y : {}) as Record<string, unknown>;
  const x = Array.isArray(spec.x) ? spec.x.map(cell) : [];
  const series = (Array.isArray(spec.series) ? spec.series : []).map((entry) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const data = Array.isArray(record.data) ? record.data : [];
    return {
      name: cell(record.name),
      values: data.map((value) => (Array.isArray(value) ? '' : cell(value))),
      points: data
        .filter((value): value is unknown[] => Array.isArray(value))
        .map((pair): [string, string] => [cell(pair[0]), cell(pair[1])]),
    };
  });
  return {
    type,
    title: cell(spec.title),
    unit: cell(spec.unit),
    yMin: cell(y.min),
    yMax: cell(y.max),
    yLabel: cell(y.label),
    x,
    series: series.length > 0 ? series : [{ name: 'Series 1', values: x.map(() => ''), points: [] }],
  };
}

export function draftFromType(type: ChartType): ChartDraft {
  return draftFromSource(JSON.stringify(CHART_EXAMPLES[type])) as ChartDraft;
}

/** The chart JSON a draft stands for, in the field order the format guide uses. */
export function draftToSpec(draft: ChartDraft): Record<string, unknown> {
  const spec: Record<string, unknown> = { type: draft.type };
  if (draft.title.trim() !== '') spec.title = draft.title;
  if (!isScatter(draft.type)) spec.x = draft.x;
  const series = isPartToWhole(draft.type) ? draft.series.slice(0, 1) : draft.series;
  spec.series = series.map((entry) => ({
    name: entry.name,
    data: isScatter(draft.type)
      ? entry.points.map(([px, py]) => [toNumberOrText(px), toNumberOrText(py)])
      : draft.x.map((_, index) => toNumberOrText(entry.values[index] ?? '')),
  }));
  if (draft.unit.trim() !== '') spec.unit = draft.unit;
  if (!isPartToWhole(draft.type)) {
    const y: Record<string, unknown> = {};
    if (draft.yMin.trim() !== '') y.min = toNumberOrText(draft.yMin);
    if (draft.yMax.trim() !== '') y.max = toNumberOrText(draft.yMax);
    if (draft.yLabel.trim() !== '') y.label = draft.yLabel;
    if (Object.keys(y).length > 0) spec.y = y;
  }
  return spec;
}

export function draftToSource(draft: ChartDraft): string {
  return JSON.stringify(draftToSpec(draft), null, 2);
}

/**
 * Changes the chart type, carrying the data across: categories become x
 * positions for a scatter chart and back, and a pie keeps the first series.
 */
export function changeType(draft: ChartDraft, type: ChartType): ChartDraft {
  if (isScatter(type) === isScatter(draft.type)) {
    return { ...draft, type, series: isPartToWhole(type) ? draft.series.slice(0, 1) : draft.series };
  }
  if (isScatter(type)) {
    return {
      ...draft,
      type,
      series: draft.series.map((entry) => ({
        ...entry,
        points: draft.x.map((_, index): [string, string] => [String(index + 1), entry.values[index] ?? '']),
      })),
    };
  }
  const longest = Math.max(0, ...draft.series.map((entry) => entry.points.length));
  const first = draft.series[0];
  const x = Array.from({ length: longest }, (_, index) => first?.points[index]?.[0] ?? String(index + 1));
  const series = draft.series.map((entry) => ({
    ...entry,
    values: x.map((_, index) => entry.points[index]?.[1] ?? ''),
  }));
  return { ...draft, type, x, series: isPartToWhole(type) ? series.slice(0, 1) : series };
}

/** True when two chart sources hold the same data, whatever their formatting. */
export function sameChartSource(a: string, b: string): boolean {
  const canonical = (source: string): string | null => {
    try {
      const sort = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(sort);
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
          );
        }
        return value;
      };
      return JSON.stringify(sort(JSON.parse(source)));
    } catch {
      return null;
    }
  };
  const left = canonical(a);
  return left !== null && left === canonical(b);
}
