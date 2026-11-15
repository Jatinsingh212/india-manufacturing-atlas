/**
 * ECharts option builders shared by the D3 pages. They follow the Atlas dataviz specs that the
 * foundation theme encodes (lib/theme.ts): one value axis, <= 20 px horizontal bars with 4 px rounded
 * data-ends, a legend for two or more series, values at the bar ends, hairline grid.
 */
import type { BarSeriesOption, EChartsOption } from 'echarts';
import { fmtUSD, truncate } from '@/lib/format';
import { BASE_GRID } from '@/lib/theme';

/** Escape text for ECharts HTML tooltips. */
export function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Compact US$ for axis ticks ("$2 bn"). */
export function usdTick(v: number): string {
  return v === 0 ? '0' : fmtUSD(v, { sig: 2 });
}

export interface HBarSeries {
  name: string;
  values: Array<number | null>;
  color: string;
}

/**
 * Horizontal grouped bars (category on y, inverse so the first row is on top) for one or more series
 * that share a unit. With a single series no legend is drawn (the card title names it).
 */
export function groupedHBarOption(params: {
  categories: string[];
  /** Full labels for tooltips (defaults to categories). */
  fullLabels?: string[];
  series: HBarSeries[];
  valueFormatter?: (v: number) => string;
  /** Axis tick formatter (default: compact US$ when no valueFormatter is given, else valueFormatter). */
  axisFormatter?: (v: number) => string;
  /** Characters kept on the y-axis labels (default 34). */
  labelMax?: number;
  showLabels?: boolean;
}): EChartsOption {
  const { categories, fullLabels, series, labelMax = 34, showLabels = true } = params;
  const valueFormatter = params.valueFormatter ?? ((v: number) => fmtUSD(v));
  const axisFormatter = params.axisFormatter ?? (params.valueFormatter ? params.valueFormatter : usdTick);
  const multi = series.length > 1;
  return {
    grid: { ...BASE_GRID, top: multi ? 30 : 8, right: showLabels ? 64 : 16 },
    legend: multi ? { top: 0, left: 0 } : undefined,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (raw: unknown) => {
        const rows = (Array.isArray(raw) ? raw : [raw]) as Array<{ dataIndex: number; seriesName: string; value: number | null; marker: string }>;
        if (!rows.length) return '';
        const label = escapeHtml((fullLabels ?? categories)[rows[0].dataIndex] ?? '');
        const lines = rows.map((r) => `${r.marker}${escapeHtml(r.seriesName)}: <b>${typeof r.value === 'number' ? valueFormatter(r.value) : 'Not available'}</b>`);
        return `<div style="max-width:300px;white-space:normal"><b>${label}</b></div>${lines.join('<br/>')}`;
      },
    },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => axisFormatter(v) } },
    yAxis: {
      type: 'category',
      data: categories.map((c) => truncate(c, labelMax)),
      inverse: true,
      splitLine: { show: false },
      axisLabel: { width: 220, overflow: 'truncate' },
    },
    series: series.map<BarSeriesOption>((s) => ({
      type: 'bar',
      name: s.name,
      data: s.values,
      barMaxWidth: multi ? 12 : 18,
      barGap: '20%',
      itemStyle: { color: s.color, borderRadius: [0, 4, 4, 0] },
      label: showLabels
        ? {
            show: true,
            position: 'right',
            fontSize: 10.5,
            formatter: (p) => (typeof p.value === 'number' ? valueFormatter(p.value) : ''),
          }
        : undefined,
    })),
  };
}
