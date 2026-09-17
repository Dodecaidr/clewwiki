import { z } from 'zod';

/**
 * The chart block contract.
 *
 * A chart is a fenced block whose info string is `chart` and whose body is one
 * JSON object. This schema is the only definition of that object: the server
 * validates writes with it, the page view and the HTML export render what it
 * accepts, the editor builds its form from it, and `wiki.format_guide` quotes
 * its limits and its JSON Schema. Nothing else may restate the rules.
 *
 * The block is data. There are no expressions, no functions, no formatting
 * strings and no colours in it — the renderer decides how a chart looks, so an
 * author (a person or an agent) only has to get the numbers right.
 */

export const CHART_LANGUAGE = 'chart';

export const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'scatter', 'stacked-bar'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Chart types whose data points share the category labels in `x`. */
export const CATEGORICAL_CHART_TYPES = ['bar', 'line', 'area', 'stacked-bar'] as const;
/** Chart types that divide one whole into slices. */
export const PART_TO_WHOLE_CHART_TYPES = ['pie', 'donut'] as const;

export const CHART_LIMITS = {
  /**
   * Series per chart. Every series gets its own colour from a fixed, ordered
   * palette of eight that stays distinguishable for colour-blind readers; a
   * ninth series would have to reuse a colour, so there is none.
   */
  maxSeries: 8,
  /** Values per series, and labels in `x`. */
  maxPoints: 1000,
  /** Slices of a pie or donut — the same palette bound as series. */
  maxSlices: 8,
  maxTitleLength: 120,
  maxLabelLength: 80,
  maxSeriesNameLength: 60,
  maxUnitLength: 16,
  maxAxisLabelLength: 60,
  /** Bytes of JSON in one block. */
  maxSourceBytes: 100_000,
} as const;

const label = z.string().max(CHART_LIMITS.maxLabelLength);
const title = z.string().trim().min(1).max(CHART_LIMITS.maxTitleLength);
const unit = z.string().trim().min(1).max(CHART_LIMITS.maxUnitLength);
const seriesName = z.string().trim().min(1).max(CHART_LIMITS.maxSeriesNameLength);
// Zod 4 refuses NaN and ±Infinity for every number schema, which matters for
// values built in code; JSON cannot express them anyway.
const finite = z.number();

const yAxis = z
  .strictObject({
    min: finite.optional(),
    max: finite.optional(),
    label: z.string().trim().min(1).max(CHART_LIMITS.maxAxisLabelLength).optional(),
  })
  .check((ctx) => {
    if (ctx.issues.length > 0) return;
    const { min, max } = ctx.value;
    if (min !== undefined && max !== undefined && min >= max) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['max'],
        message: `y.max (${max}) must be greater than y.min (${min})`,
      });
    }
  });

const categoricalSeries = z.strictObject({
  name: seriesName,
  data: z.array(finite).min(1).max(CHART_LIMITS.maxPoints),
});

const scatterSeries = z.strictObject({
  name: seriesName,
  data: z
    .array(z.tuple([finite, finite]), {
      error: 'scatter data is a list of [x, y] pairs of numbers',
    })
    .min(1)
    .max(CHART_LIMITS.maxPoints),
});

const common = {
  title: title.optional(),
  unit: unit.optional(),
  y: yAxis.optional(),
};

type CategoricalShape = {
  type: string;
  x: string[];
  series: Array<{ name: string; data: number[] }>;
};

/** `x` and every series must line up point for point. */
function checkLengths(ctx: z.core.ParsePayload<CategoricalShape>): void {
  const { x, series } = ctx.value;
  series.forEach((entry, index) => {
    if (entry.data.length !== x.length) {
      ctx.issues.push({
        code: 'custom',
        input: entry.data,
        path: ['series', index, 'data'],
        message: `series ${index} ("${entry.name}") has ${entry.data.length} values but x has ${x.length} labels; they must be equal`,
      });
    }
  });
}

function checkNonNegative(ctx: z.core.ParsePayload<CategoricalShape>, why: string): void {
  ctx.value.series.forEach((entry, seriesIndex) => {
    entry.data.forEach((value, pointIndex) => {
      if (value < 0) {
        ctx.issues.push({
          code: 'custom',
          input: value,
          path: ['series', seriesIndex, 'data', pointIndex],
          message: `${value} is negative; ${why}`,
        });
      }
    });
  });
}

function categorical<T extends 'bar' | 'line' | 'area' | 'stacked-bar'>(type: T) {
  return z
    .strictObject({
      type: z.literal(type),
      ...common,
      x: z.array(label).min(1).max(CHART_LIMITS.maxPoints),
      series: z.array(categoricalSeries).min(1).max(CHART_LIMITS.maxSeries),
    })
    .check((ctx) => {
      // Cross-field rules only make sense on a value whose fields are right.
      if (ctx.issues.length > 0) return;
      checkLengths(ctx);
      if (type === 'stacked-bar') {
        checkNonNegative(ctx, 'stacked bars add values up, so every value must be 0 or more');
      }
    });
}

function partToWhole<T extends 'pie' | 'donut'>(type: T) {
  return z
    .strictObject({
      type: z.literal(type),
      title: common.title,
      unit: common.unit,
      x: z.array(label).min(1).max(CHART_LIMITS.maxSlices),
      series: z
        .array(categoricalSeries)
        .length(1, { error: `a ${type} chart has exactly one series: the slice values` }),
    })
    .check((ctx) => {
      if (ctx.issues.length > 0) return;
      checkLengths(ctx);
      checkNonNegative(ctx, `a ${type} slice cannot be negative`);
      const total = ctx.value.series[0]?.data.reduce((sum, value) => sum + value, 0) ?? 0;
      if (ctx.value.series[0] && total <= 0) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value.series[0].data,
          path: ['series', 0, 'data'],
          message: `the slice values of a ${type} chart must add up to more than 0`,
        });
      }
    });
}

const scatter = z.strictObject({
  type: z.literal('scatter'),
  ...common,
  series: z.array(scatterSeries).min(1).max(CHART_LIMITS.maxSeries),
});

export const chartSpecSchema = z.discriminatedUnion(
  'type',
  [
    categorical('bar'),
    categorical('line'),
    categorical('area'),
    categorical('stacked-bar'),
    partToWhole('pie'),
    partToWhole('donut'),
    scatter,
  ],
  { error: `type must be one of: ${CHART_TYPES.join(', ')}` },
);

export type ChartSpec = z.infer<typeof chartSpecSchema>;
export type CategoricalChartSpec = Extract<ChartSpec, { type: 'bar' | 'line' | 'area' | 'stacked-bar' }>;
export type PartToWholeChartSpec = Extract<ChartSpec, { type: 'pie' | 'donut' }>;
export type ScatterChartSpec = Extract<ChartSpec, { type: 'scatter' }>;

/** One problem with a block, addressed by a dotted path inside it. */
export interface ContentIssue {
  /** `series.0.data`, or an empty string for the block as a whole. */
  path: string;
  message: string;
}

export type ChartParseResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; errors: ContentIssue[] };

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Parses and validates the body of a chart block.
 *
 * Errors are phrased for whoever has to fix the block — often an agent that
 * will read the message and write again — so each names the field and says
 * what was expected rather than only that something failed.
 */
export function parseChartSource(source: string): ChartParseResult {
  if (utf8Length(source) > CHART_LIMITS.maxSourceBytes) {
    return {
      ok: false,
      errors: [
        {
          path: '',
          message: `the chart block is larger than ${CHART_LIMITS.maxSourceBytes} bytes`,
        },
      ],
    };
  }
  if (source.trim() === '') {
    return {
      ok: false,
      errors: [{ path: '', message: 'the chart block is empty; it must hold one JSON object' }],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [{ path: '', message: `not valid JSON (${detail}); a chart block holds one JSON object` }],
    };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: '', message: 'a chart block holds one JSON object' }] };
  }

  const parsed = chartSpecSchema.safeParse(raw);
  if (parsed.success) return { ok: true, spec: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

/** The JSON Schema of a chart block, for agents that validate before writing. */
export function chartJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(chartSpecSchema, { unrepresentable: 'any' }) as Record<string, unknown>;
}
