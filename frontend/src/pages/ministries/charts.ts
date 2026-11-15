/**
 * ECharts option builders for the ministry / sector dashboards and the ministries index.
 *
 * Dataviz rules applied (see frontend/COMPONENTS.md section 8):
 * - Magnitude across categories -> horizontal bars, ONE hue (categorical slot 1) for every bar; the
 *   residual bucket / "Other" fold is the de-emphasis grey. Values are direct-labelled at the bar end.
 * - Change over time -> lines on ONE y-axis (exports = slot 1, imports = slot 2, fixed order), legend,
 *   end labels on the latest point only, axis-trigger tooltip.
 * - An optional reference value on the same axis is drawn as a hollow marker so the live bar stays primary.
 */
import type { EChartsOption } from 'echarts';
import type { TradeSeriesPoint } from '@/api/types';
import { fmtUSD, truncate } from '@/lib/format';
import { BASE_GRID, CATEGORICAL, CHART_TOKENS, OTHER_GREY, type ThemeMode } from '@/lib/theme';

/** One bar in a ranked bar chart. */
export interface BarRow {
  id: string;
  label: string;
  value: number | null;
  /** Render in the de-emphasis grey (residual bucket, "Other"). */
  muted?: boolean;
  /** Optional reference value on the same scale, shown as a hollow marker. */
  reference?: number | null;
}

/** Height that fits `n` bars plus the axis band (dataviz: the container height includes the axis). */
export function barChartHeight(n: number, perBar = 26, min = 140): number {
  return Math.max(min, n * perBar + 48);
}

/**
 * Horizontal ranked bars (category on y, inverse so the largest is on top).
 * `referenceName` turns on the hollow-marker reference series and the legend.
 */
export function rankedBarOption(params: {
  rows: BarRow[];
  mode: ThemeMode;
  format: (v: number) => string;
  seriesName: string;
  referenceName?: string;
  labelWidth?: number;
  /**
   * Hide the value axis labels and split lines. Bars are direct-labelled at their ends, so a narrow
   * chart can drop the axis instead of crowding it.
   */
  hideValueAxis?: boolean;
}): EChartsOption {
  const { rows, mode, format, seriesName, referenceName, labelWidth = 150, hideValueAxis = false } = params;
  const color = CATEGORICAL[mode][0];
  const refColor = CATEGORICAL[mode][1];
  const hasRef = Boolean(referenceName) && rows.some((r) => typeof r.reference === 'number');
  const tokens = CHART_TOKENS[mode];
  const series: NonNullable<EChartsOption['series']> = [
    {
      type: 'bar',
      name: seriesName,
      data: rows.map((r) => ({
        value: r.value ?? 0,
        itemStyle: { color: r.muted ? OTHER_GREY[mode] : color },
        // when the reference marker sits beyond the bar end, the value moves inside the bar end so the
        // marker never covers the number (a marker inside the bar leaves the outside label free)
        label:
          hasRef && typeof r.reference === 'number' && typeof r.value === 'number' && r.reference > r.value
            ? { position: 'insideRight', color: '#ffffff', fontWeight: 600 }
            : undefined,
      })),
      barMaxWidth: 18,
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      label: {
        show: true,
        position: 'right',
        distance: 5,
        fontSize: 11,
        color: tokens.ink2,
        formatter: (p) => {
          const r = rows[(p as { dataIndex: number }).dataIndex];
          return r && typeof r.value === 'number' ? format(r.value) : 'n/a';
        },
      },
    },
  ];
  if (hasRef) {
    series.push({
      type: 'scatter',
      name: referenceName,
      // [x = reference value, y = category index]; rows without a reference get no marker
      data: rows.flatMap((r, i) => (typeof r.reference === 'number' ? [[r.reference, i]] : [])),
      symbol: 'diamond',
      symbolSize: 11,
      itemStyle: { color: tokens.surface, borderColor: refColor, borderWidth: 2, opacity: 1 },
      z: 5,
    });
  }
  return {
    grid: { ...BASE_GRID, top: hasRef ? 30 : 8, right: 64 },
    // On phones the two legend labels wrap; reserve the second line so it never overlaps the first bar.
    media: [
      {
        query: { maxWidth: 280 },
        option: { grid: { ...BASE_GRID, top: hasRef ? 52 : 8, right: 64 } },
      },
    ],
    legend: hasRef ? { top: 0, left: 0, data: [seriesName, referenceName as string] } : undefined,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (raw) => {
        const items = (Array.isArray(raw) ? raw : [raw]) as Array<{ dataIndex: number; seriesName: string; marker: string; value: unknown }>;
        const r = rows[items[0]?.dataIndex ?? 0];
        if (!r) return '';
        const lines = [`<div style="font-weight:600;margin-bottom:2px">${escapeHtml(r.label)}</div>`];
        lines.push(`${items[0]?.marker ?? ''}${escapeHtml(seriesName)}: <b>${typeof r.value === 'number' ? format(r.value) : 'Not available'}</b>`);
        if (hasRef && typeof r.reference === 'number') lines.push(`${escapeHtml(referenceName ?? '')}: <b>${format(r.reference)}</b>`);
        return lines.join('<br/>');
      },
    },
    xAxis: hideValueAxis
      ? { type: 'value', axisLabel: { show: false }, splitLine: { show: false }, axisTick: { show: false } }
      : { type: 'value', axisLabel: { formatter: (v: number) => format(v), hideOverlap: true }, splitNumber: 4 },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.label),
      axisLabel: { width: labelWidth, overflow: 'truncate', fontSize: 11.5, color: tokens.ink2 },
      axisLine: { show: false },
    },
    series,
  };
}

/** Exports / imports trend lines on one axis with end labels on the latest point. */
export function tradeTrendOption(trend: ReadonlyArray<TradeSeriesPoint>, mode: ThemeMode): EChartsOption {
  const pts = [...trend].sort((a, b) => a.year - b.year);
  const [cx, cm] = CATEGORICAL[mode];
  const val = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const endLabel = { show: true, fontSize: 11, formatter: (p: { value: unknown }) => (typeof p.value === 'number' ? fmtUSD(p.value) : '') };
  return {
    grid: { ...BASE_GRID, top: 36, right: 72 },
    legend: { top: 0, left: 0, data: ['India exports', 'India imports'] },
    tooltip: { trigger: 'axis', valueFormatter: (v) => (typeof v === 'number' ? fmtUSD(v) : 'Not available') },
    xAxis: { type: 'category', data: pts.map((p) => String(p.year)), boundaryGap: false },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtUSD(v, { sig: 2 }) }, splitNumber: 4 },
    series: [
      {
        type: 'line',
        name: 'India exports',
        data: pts.map((p) => val(p.exports)),
        color: cx,
        connectNulls: false,
        areaStyle: { opacity: 0.08 },
        endLabel: { ...endLabel, color: CHART_TOKENS[mode].ink2 },
      },
      {
        type: 'line',
        name: 'India imports',
        data: pts.map((p) => val(p.imports)),
        color: cm,
        connectNulls: false,
        endLabel: { ...endLabel, color: CHART_TOKENS[mode].ink2 },
      },
    ],
  };
}

/** Fold rows beyond `limit` into a muted "Other" bar (never a 9th hue). */
export function foldRows(rows: BarRow[], limit: number, otherLabel = 'All other'): BarRow[] {
  if (rows.length <= limit) return rows;
  const head = rows.slice(0, limit);
  const tail = rows.slice(limit);
  const sum = tail.reduce((s, r) => s + (r.value ?? 0), 0);
  return [...head, { id: '__other__', label: `${otherLabel} (${tail.length})`, value: sum, muted: true }];
}

/** Chart axis label for a chapter row: "61 · Articles of apparel, knitted…". */
export function chapterLabel(hs2: string, description: string | null | undefined, max = 30): string {
  return `${hs2} · ${truncate(description ?? '', max)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
