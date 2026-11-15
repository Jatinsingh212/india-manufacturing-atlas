/**
 * TrendChart - India's exports and imports 2018-2024 on one US$ axis (no dual axes), with the model's
 * 2025-26 forecast drawn as a dashed continuation and its 95 % band as a light wash, when
 * scores.forecast exists. A shaded region marks the forecast years. "Both / Exports / Imports" lets a
 * small flow be read on its own scale; the "Table" toggle shows every number (the chart's table view).
 */
import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { ChartLine, Table2 } from 'lucide-react';
import type { ForecastPoint, ForecastSet, Provenance, TradeSeriesPoint } from '@/api/types';
import { Card, EChart, EmptyState, ModelEstimateTag, ProvenanceBadge, SegmentedControl } from '@/components';
import { fmtUSD } from '@/lib/format';
import { BASE_GRID, CHART_TOKENS, categorical, withAlpha } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';

type Flow = 'exports' | 'imports';
type View = 'both' | Flow;

const FLOW_LABEL: Record<Flow, string> = { exports: 'Exports', imports: 'Imports' };

export interface TrendChartProps {
  series: TradeSeriesPoint[];
  forecast: ForecastSet | null | undefined;
  provenance: Provenance;
}

function validPoints(points: ForecastPoint[] | undefined, after: number): ForecastPoint[] {
  return (points ?? []).filter((p) => p.year > after && typeof p.value === 'number' && Number.isFinite(p.value)).sort((a, b) => a.year - b.year);
}

export function TrendChart({ series, forecast, provenance }: TrendChartProps) {
  const [view, setView] = useState<View>('both');
  const [showTable, setShowTable] = useState(false);
  const { mode } = useTheme();
  const tokens = CHART_TOKENS[mode];

  const history = useMemo(() => [...series].sort((a, b) => a.year - b.year), [series]);
  const lastYear = history.at(-1)?.year ?? 2024;
  const fc = useMemo(
    () => ({ exports: validPoints(forecast?.exports, lastYear), imports: validPoints(forecast?.imports, lastYear) }),
    [forecast, lastYear],
  );
  const hasForecast = fc.exports.length > 0 || fc.imports.length > 0;
  const hasHistory = history.some((h) => typeof h.exports === 'number' || typeof h.imports === 'number');

  const years = useMemo(() => {
    const ys = new Set(history.map((h) => h.year));
    fc.exports.forEach((p) => ys.add(p.year));
    fc.imports.forEach((p) => ys.add(p.year));
    return [...ys].sort((a, b) => a - b);
  }, [history, fc]);

  const option = useMemo<EChartsOption>(() => {
    const flows: Flow[] = view === 'both' ? ['exports', 'imports'] : [view];
    const histMap = new Map(history.map((h) => [h.year, h]));
    const out: NonNullable<EChartsOption['series']> = [];
    const legend: string[] = [];

    flows.forEach((f, idx) => {
      const color = categorical(f === 'exports' ? 0 : 1, mode);
      const actual = years.map((y) => (y <= lastYear ? (histMap.get(y)?.[f] ?? null) : null));
      out.push({
        type: 'line',
        name: FLOW_LABEL[f],
        data: actual,
        itemStyle: { color },
        lineStyle: { color, width: 2 },
        symbolSize: 7,
        connectNulls: false,
        z: 3,
        markArea:
          idx === 0 && hasForecast
            ? {
                silent: true,
                itemStyle: { color: withAlpha(mode === 'dark' ? '#ffffff' : '#0b1f3a', 0.04) },
                label: { show: true, position: 'insideTop', color: tokens.muted, fontSize: 11, formatter: 'Forecast' },
                data: [[{ xAxis: String(lastYear) }, { xAxis: String(years.at(-1)) }]],
              }
            : undefined,
      });
      legend.push(FLOW_LABEL[f]);

      const pts = fc[f];
      const last = histMap.get(lastYear)?.[f];
      if (pts.length && typeof last === 'number') {
        const byYear = new Map(pts.map((p) => [p.year, p]));
        const at = (y: number, key: 'value' | 'lo' | 'hi') => (y === lastYear ? last : (byYear.get(y)?.[key] ?? null));
        out.push({
          type: 'line',
          name: `${FLOW_LABEL[f]} forecast`,
          data: years.map((y) => (y >= lastYear ? at(y, 'value') : null)),
          itemStyle: { color },
          lineStyle: { color, width: 2, type: 'dashed' },
          symbol: 'emptyCircle',
          symbolSize: 7,
          connectNulls: false,
          z: 3,
        });
        legend.push(`${FLOW_LABEL[f]} forecast`);
        // 95 % band: transparent lower bound + stacked (hi - lo) wash.
        out.push({
          type: 'line',
          name: `${FLOW_LABEL[f]} band base`,
          stack: `band-${f}`,
          data: years.map((y) => (y >= lastYear ? at(y, 'lo') : null)),
          lineStyle: { opacity: 0 },
          symbol: 'none',
          silent: true,
          z: 1,
        });
        out.push({
          type: 'line',
          name: `${FLOW_LABEL[f]} 95% range`,
          stack: `band-${f}`,
          data: years.map((y) => {
            if (y < lastYear) return null;
            const lo = at(y, 'lo');
            const hi = at(y, 'hi');
            return typeof lo === 'number' && typeof hi === 'number' ? Math.max(0, hi - lo) : null;
          }),
          lineStyle: { opacity: 0 },
          areaStyle: { color: withAlpha(color, 0.16) },
          symbol: 'none',
          silent: true,
          z: 1,
        });
      }
    });

    return {
      grid: { ...BASE_GRID, top: 36 },
      legend: { top: 0, left: 0, data: legend },
      tooltip: {
        trigger: 'axis',
        formatter: (raw: unknown) => {
          const params = (Array.isArray(raw) ? raw : [raw]) as Array<{ dataIndex: number }>;
          const i = params[0]?.dataIndex ?? 0;
          const y = years[i];
          const lines = [`<div style="font-weight:600;margin-bottom:4px">${y}${y > lastYear ? ' · model forecast' : ''}</div>`];
          for (const f of flows) {
            const color = categorical(f === 'exports' ? 0 : 1, mode);
            const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`;
            if (y <= lastYear) {
              lines.push(`${dot}${FLOW_LABEL[f]}: <b>${fmtUSD(histMap.get(y)?.[f] ?? null)}</b>`);
            } else {
              const p = fc[f].find((x) => x.year === y);
              if (p) lines.push(`${dot}${FLOW_LABEL[f]} forecast: <b>${fmtUSD(p.value)}</b><br/><span style="color:${tokens.muted};margin-left:14px">95% range ${fmtUSD(p.lo)} – ${fmtUSD(p.hi)}</span>`);
            }
          }
          return lines.join('<br/>');
        },
      },
      xAxis: { type: 'category', data: years.map(String), boundaryGap: false },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtUSD(v, { sig: 2 }) } },
      series: out,
    } as EChartsOption;
  }, [view, history, years, lastYear, fc, hasForecast, mode, tokens]);

  const tableRows = useMemo(() => {
    const rows: Array<{ year: number; exports: string; imports: string; world: string; forecast: boolean }> = history.map((h) => ({
      year: h.year,
      exports: fmtUSD(h.exports),
      imports: fmtUSD(h.imports),
      world: fmtUSD(h.world_trade ?? null),
      forecast: false,
    }));
    for (const y of years.filter((yy) => yy > lastYear)) {
      const e = fc.exports.find((p) => p.year === y);
      const m = fc.imports.find((p) => p.year === y);
      rows.push({
        year: y,
        exports: e ? `${fmtUSD(e.value)} (${fmtUSD(e.lo)} – ${fmtUSD(e.hi)})` : 'Not available',
        imports: m ? `${fmtUSD(m.value)} (${fmtUSD(m.lo)} – ${fmtUSD(m.hi)})` : 'Not available',
        world: 'Not forecast',
        forecast: true,
      });
    }
    return rows;
  }, [history, years, lastYear, fc]);

  return (
    <Card
      title="Trade trend"
      subtitle={
        hasForecast
          ? `India's exports and imports, US$, ${history[0]?.year ?? 2018}–${lastYear}; dashed = ${lastYear + 1}–${years.at(-1)} forecast with 95% band`
          : `India's exports and imports, US$, ${history[0]?.year ?? 2018}–${lastYear}`
      }
      icon={ChartLine}
      actions={hasForecast ? <ModelEstimateTag method="Log-linear OLS trend on 2018-2024, 95% band = ±1.96 σ of residuals" /> : undefined}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <ProvenanceBadge provenance={provenance} size="xs" />
          <span>India&rsquo;s official DGCIS TRADESTAT figures, financial years (2024 = FY2024-25).</span>
        </div>
      }
    >
      {hasHistory ? (
        <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
          <SegmentedControl<View>
            value={view}
            onChange={setView}
            size="xs"
            ariaLabel="Flows shown"
            options={[
              { value: 'both', label: 'Both' },
              { value: 'exports', label: 'Exports' },
              { value: 'imports', label: 'Imports' },
            ]}
          />
          <SegmentedControl<'chart' | 'table'>
            value={showTable ? 'table' : 'chart'}
            onChange={(v) => setShowTable(v === 'table')}
            size="xs"
            ariaLabel="Chart or table"
            options={[
              { value: 'chart', label: <ChartLine className="size-3.5" aria-label="Chart view" />, title: 'Chart view' },
              { value: 'table', label: <Table2 className="size-3.5" aria-label="Table view" />, title: 'Table view' },
            ]}
          />
        </div>
      ) : null}
      {!hasHistory ? (
        <EmptyState compact icon={ChartLine} title="No trade recorded for this line" message="DGCIS TRADESTAT reports no India exports or imports for FY2018-19 to FY2024-25." />
      ) : showTable ? (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-[12.5px]">
            <caption className="sr-only">Trade by year</caption>
            <thead className="bg-surface-2 text-[11px] tracking-wide text-ink-2 uppercase">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-semibold">Year</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Exports</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Imports</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">World trade</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => (
                <tr key={r.year} className={r.forecast ? 'border-t border-line bg-surface-2 italic' : 'border-t border-line'}>
                  <td className="px-3 py-1.5 atlas-num">
                    {r.year}
                    {r.forecast ? <span className="ml-1.5 text-[11px] text-muted not-italic">forecast</span> : null}
                  </td>
                  <td className="px-3 py-1.5 text-right atlas-num">{r.exports}</td>
                  <td className="px-3 py-1.5 text-right atlas-num">{r.imports}</td>
                  <td className="px-3 py-1.5 text-right atlas-num text-muted">{r.world}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EChart option={option} height={320} ariaLabel="Line chart of India's exports and imports by year with forecast" />
      )}
    </Card>
  );
}
