'use client';

import { CHART_LIMITS, CHART_TYPES, parseChartSource } from '@clewwiki/content/chart';
import type { ChartType } from '@clewwiki/content/chart';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ChartPreview } from './chart-preview';
import {
  changeType,
  draftFromSource,
  draftFromType,
  draftToSource,
  isPartToWhole,
  isScatter,
  sameChartSource,
} from './chart-draft';
import type { ChartDraft } from './chart-draft';
import { EditorDialog } from './editor-dialog';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { cn } from '@/lib/utils';

const cellInput =
  'h-8 w-full min-w-20 rounded-(--radius-base) border border-input bg-card px-2 font-mono text-xs tabular-nums';

/**
 * The chart editor: chart type and options on the left, the data as a grid
 * (or the raw JSON) below them, and the chart drawn by the real renderer on
 * the right. Saving is only possible when the chart would pass the server's
 * validation, and a chart saved without changes keeps its JSON exactly as it
 * was written.
 */
export function ChartDialog({
  open,
  initialSource,
  mode,
  onCancel,
  onSave,
}: {
  open: boolean;
  initialSource: string | null;
  mode: 'insert' | 'edit';
  onCancel: () => void;
  onSave: (source: string) => void;
}) {
  if (!open) return null;
  return <ChartDialogBody initialSource={initialSource} mode={mode} onCancel={onCancel} onSave={onSave} />;
}

function ChartDialogBody({
  initialSource,
  mode,
  onCancel,
  onSave,
}: {
  initialSource: string | null;
  mode: 'insert' | 'edit';
  onCancel: () => void;
  onSave: (source: string) => void;
}) {
  const t = useTranslations('editor');
  const startingDraft = initialSource === null ? draftFromType('bar') : draftFromSource(initialSource);
  const [draft, setDraft] = useState<ChartDraft>(startingDraft ?? draftFromType('bar'));
  const [tab, setTab] = useState<'form' | 'json'>(startingDraft ? 'form' : 'json');
  const [json, setJson] = useState<string>(initialSource ?? draftToSource(draft));

  const source = tab === 'form' ? draftToSource(draft) : json;
  const result = parseChartSource(source);
  const scatter = isScatter(draft.type);
  const partToWhole = isPartToWhole(draft.type);

  const update = (change: (current: ChartDraft) => ChartDraft) => setDraft((current) => change(current));

  const switchTab = (next: 'form' | 'json') => {
    if (next === tab) return;
    if (next === 'json') {
      setJson(draftToSource(draft));
      setTab('json');
      return;
    }
    const parsed = draftFromSource(json);
    if (parsed) {
      setDraft(parsed);
      setTab('form');
    }
  };

  const save = () => {
    if (!result.ok) return;
    // An unchanged chart keeps the author's formatting, so opening and saving
    // it is not an edit of the page.
    onSave(initialSource !== null && sameChartSource(initialSource, source) ? initialSource : source);
  };

  const formUnavailable = tab === 'json' && draftFromSource(json) === null;

  return (
    <EditorDialog
      open
      onClose={onCancel}
      size="lg"
      title={mode === 'insert' ? t('chartInsertTitle') : t('chartEditTitle')}
      description={t('chartLimits', {
        series: CHART_LIMITS.maxSeries,
        points: CHART_LIMITS.maxPoints,
        slices: CHART_LIMITS.maxSlices,
      })}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('dialogCancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={!result.ok}>
            {mode === 'insert' ? t('chartInsert') : t('chartSave')}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <div role="tablist" aria-label={t('chartDataTabs')} className="flex gap-1">
            {(['form', 'json'] as const).map((value) => (
              <Button
                key={value}
                role="tab"
                aria-selected={tab === value}
                variant={tab === value ? 'secondary' : 'ghost'}
                size="sm"
                disabled={value === 'form' && formUnavailable}
                onClick={() => switchTab(value)}
              >
                {value === 'form' ? t('chartForm') : t('chartJson')}
              </Button>
            ))}
          </div>

          {formUnavailable ? <p className="text-xs text-muted-foreground">{t('chartJsonInvalidForm')}</p> : null}

          {tab === 'json' ? (
            <Field label={t('chartJson')} htmlFor="chart-json">
              <textarea
                id="chart-json"
                value={json}
                onChange={(event) => setJson(event.target.value)}
                spellCheck={false}
                className="min-h-80 w-full rounded-(--radius-base) border border-input bg-card p-3 font-mono text-xs leading-relaxed"
              />
            </Field>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('chartType')} htmlFor="chart-type">
                  <Select
                    id="chart-type"
                    value={draft.type}
                    onChange={(event) => update((current) => changeType(current, event.target.value as ChartType))}
                  >
                    {CHART_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`chartType_${type.replace('-', '_')}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('chartTitleField')} htmlFor="chart-title">
                  <Input
                    id="chart-title"
                    value={draft.title}
                    maxLength={CHART_LIMITS.maxTitleLength}
                    onChange={(event) => update((current) => ({ ...current, title: event.target.value }))}
                  />
                </Field>
                <Field label={t('chartUnit')} htmlFor="chart-unit">
                  <Input
                    id="chart-unit"
                    value={draft.unit}
                    maxLength={CHART_LIMITS.maxUnitLength}
                    placeholder="ms"
                    onChange={(event) => update((current) => ({ ...current, unit: event.target.value }))}
                  />
                </Field>
                {partToWhole ? null : (
                  <Field label={t('chartYLabel')} htmlFor="chart-y-label">
                    <Input
                      id="chart-y-label"
                      value={draft.yLabel}
                      maxLength={CHART_LIMITS.maxAxisLabelLength}
                      onChange={(event) => update((current) => ({ ...current, yLabel: event.target.value }))}
                    />
                  </Field>
                )}
                {partToWhole ? null : (
                  <>
                    <Field label={t('chartYMin')} htmlFor="chart-y-min">
                      <Input
                        id="chart-y-min"
                        inputMode="decimal"
                        value={draft.yMin}
                        onChange={(event) => update((current) => ({ ...current, yMin: event.target.value }))}
                      />
                    </Field>
                    <Field label={t('chartYMax')} htmlFor="chart-y-max">
                      <Input
                        id="chart-y-max"
                        inputMode="decimal"
                        value={draft.yMax}
                        onChange={(event) => update((current) => ({ ...current, yMax: event.target.value }))}
                      />
                    </Field>
                  </>
                )}
              </div>

              <div className="grid gap-2">
                <p className="text-sm font-medium">{t('chartData')}</p>
                {scatter ? <ScatterGrid draft={draft} update={update} /> : <CategoryGrid draft={draft} update={update} />}
              </div>
            </>
          )}
        </div>

        <div className="grid content-start gap-3">
          <p className="text-sm font-medium">{t('chartPreview')}</p>
          <div className="rounded-(--radius-base) border border-border p-3 [--chart-surface:var(--color-card)]">
            <ChartPreview source={source} invalidLabel={t('chartErrors')} />
          </div>
        </div>
      </div>
    </EditorDialog>
  );
}

function CategoryGrid({
  draft,
  update,
}: {
  draft: ChartDraft;
  update: (change: (current: ChartDraft) => ChartDraft) => void;
}) {
  const t = useTranslations('editor');
  const partToWhole = isPartToWhole(draft.type);
  const series = partToWhole ? draft.series.slice(0, 1) : draft.series;
  const maxRows = partToWhole ? CHART_LIMITS.maxSlices : CHART_LIMITS.maxPoints;

  const setSeries = (index: number, change: (entry: ChartDraft['series'][number]) => ChartDraft['series'][number]) =>
    update((current) => ({
      ...current,
      series: current.series.map((entry, position) => (position === index ? change(entry) : entry)),
    }));

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto rounded-(--radius-base) border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted">
              <th scope="col" className="px-2 py-1.5 text-left text-xs font-medium">
                {partToWhole ? t('chartSlice') : t('chartCategory')}
              </th>
              {series.map((entry, index) => (
                <th key={index} scope="col" className="px-2 py-1.5 text-left">
                  <div className="flex items-center gap-1">
                    <input
                      aria-label={t('chartSeriesName', { index: index + 1 })}
                      className={cellInput}
                      value={entry.name}
                      maxLength={CHART_LIMITS.maxSeriesNameLength}
                      onChange={(event) => setSeries(index, (current) => ({ ...current, name: event.target.value }))}
                    />
                    {series.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2"
                        aria-label={t('chartRemoveSeries', { name: entry.name || String(index + 1) })}
                        onClick={() =>
                          update((current) => ({
                            ...current,
                            series: current.series.filter((_, position) => position !== index),
                          }))
                        }
                      >
                        ×
                      </Button>
                    ) : null}
                  </div>
                </th>
              ))}
              <th scope="col" className="w-10">
                <span className="sr-only">{t('chartRowActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.x.map((label, row) => (
              <tr key={row} className="border-t border-border">
                <td className="px-2 py-1">
                  <input
                    aria-label={t('chartLabelCell', { row: row + 1 })}
                    className={cn(cellInput, 'font-sans')}
                    value={label}
                    maxLength={CHART_LIMITS.maxLabelLength}
                    onChange={(event) =>
                      update((current) => ({
                        ...current,
                        x: current.x.map((value, position) => (position === row ? event.target.value : value)),
                      }))
                    }
                  />
                </td>
                {series.map((entry, index) => (
                  <td key={index} className="px-2 py-1">
                    <input
                      aria-label={t('chartValueCell', { row: row + 1, series: entry.name || String(index + 1) })}
                      className={cellInput}
                      inputMode="decimal"
                      value={entry.values[row] ?? ''}
                      onChange={(event) =>
                        setSeries(index, (current) => {
                          const values = [...current.values];
                          while (values.length <= row) values.push('');
                          values[row] = event.target.value;
                          return { ...current, values };
                        })
                      }
                    />
                  </td>
                ))}
                <td className="px-1 py-1 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    aria-label={t('chartRemoveRow', { row: row + 1 })}
                    disabled={draft.x.length <= 1}
                    onClick={() =>
                      update((current) => ({
                        ...current,
                        x: current.x.filter((_, position) => position !== row),
                        series: current.series.map((entry) => ({
                          ...entry,
                          values: entry.values.filter((_, position) => position !== row),
                        })),
                      }))
                    }
                  >
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={draft.x.length >= maxRows}
          onClick={() =>
            update((current) => ({
              ...current,
              x: [...current.x, ''],
              series: current.series.map((entry) => ({ ...entry, values: [...entry.values, ''] })),
            }))
          }
        >
          {partToWhole ? t('chartAddSlice') : t('chartAddRow')}
        </Button>
        {partToWhole ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={draft.series.length >= CHART_LIMITS.maxSeries}
            onClick={() =>
              update((current) => ({
                ...current,
                series: [
                  ...current.series,
                  {
                    name: t('chartDefaultSeries', { index: current.series.length + 1 }),
                    values: current.x.map(() => ''),
                    points: [],
                  },
                ],
              }))
            }
          >
            {t('chartAddSeries')}
          </Button>
        )}
      </div>
    </div>
  );
}

function ScatterGrid({
  draft,
  update,
}: {
  draft: ChartDraft;
  update: (change: (current: ChartDraft) => ChartDraft) => void;
}) {
  const t = useTranslations('editor');

  const setPoints = (index: number, change: (points: Array<[string, string]>) => Array<[string, string]>) =>
    update((current) => ({
      ...current,
      series: current.series.map((entry, position) =>
        position === index ? { ...entry, points: change(entry.points) } : entry,
      ),
    }));

  return (
    <div className="grid gap-3">
      {draft.series.map((entry, index) => (
        <fieldset key={index} className="grid gap-2 rounded-(--radius-base) border border-border p-2">
          <legend className="sr-only">{entry.name}</legend>
          <div className="flex items-center gap-2">
            <input
              aria-label={t('chartSeriesName', { index: index + 1 })}
              className={cn(cellInput, 'font-sans')}
              value={entry.name}
              maxLength={CHART_LIMITS.maxSeriesNameLength}
              onChange={(event) =>
                update((current) => ({
                  ...current,
                  series: current.series.map((item, position) =>
                    position === index ? { ...item, name: event.target.value } : item,
                  ),
                }))
              }
            />
            {draft.series.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('chartRemoveSeries', { name: entry.name || String(index + 1) })}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    series: current.series.filter((_, position) => position !== index),
                  }))
                }
              >
                ×
              </Button>
            ) : null}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col" className="text-left text-xs font-medium">
                  {t('chartPointX')}
                </th>
                <th scope="col" className="text-left text-xs font-medium">
                  {t('chartPointY')}
                </th>
                <th scope="col">
                  <span className="sr-only">{t('chartRowActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entry.points.map(([px, py], row) => (
                <tr key={row}>
                  {[px, py].map((value, axis) => (
                    <td key={axis} className="py-0.5 pr-2">
                      <input
                        aria-label={t('chartPointCell', { row: row + 1, axis: axis === 0 ? 'X' : 'Y' })}
                        className={cellInput}
                        inputMode="decimal"
                        value={value}
                        onChange={(event) =>
                          setPoints(index, (points) =>
                            points.map((point, position) => {
                              if (position !== row) return point;
                              const next: [string, string] = [...point];
                              next[axis] = event.target.value;
                              return next;
                            }),
                          )
                        }
                      />
                    </td>
                  ))}
                  <td className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2"
                      aria-label={t('chartRemoveRow', { row: row + 1 })}
                      disabled={entry.points.length <= 1}
                      onClick={() => setPoints(index, (points) => points.filter((_, position) => position !== row))}
                    >
                      ×
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={entry.points.length >= CHART_LIMITS.maxPoints}
              onClick={() => setPoints(index, (points) => [...points, ['', '']])}
            >
              {t('chartAddPoint')}
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={draft.series.length >= CHART_LIMITS.maxSeries}
          onClick={() =>
            update((current) => ({
              ...current,
              series: [
                ...current.series,
                { name: t('chartDefaultSeries', { index: current.series.length + 1 }), values: [], points: [['', '']] },
              ],
            }))
          }
        >
          {t('chartAddSeries')}
        </Button>
      </div>
    </div>
  );
}
