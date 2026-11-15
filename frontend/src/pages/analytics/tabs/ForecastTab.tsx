/**
 * Forecast explorer (Opportunity Lab) - GET /api/analytics/forecast/{code} (hs6 or hsn8).
 *
 * Pick a product (typeahead, typed code, or one of the quick picks; `?code=` in the URL),
 * then read history 2018-2024 as solid lines and the 2025-2026 log-linear forecast as dashed lines
 * that start from the last actual point, with the 95 % band drawn as a light wash (stacked-area band
 * trick: an invisible lower series plus the band width). One US$ axis, never two.
 */
import { useMemo, useState } from 'react';
import type { EChartsOption, LineSeriesOption } from 'echarts';
import { LineChart } from 'lucide-react';
import { normalizeCode } from '@/api/client';
import type { ForecastPoint, ForecastResponse } from '@/api/types';
import { Card, CodeLink, DataTable, EChart, EmptyState, HsnSearchBox, ModelEstimateTag, QueryState, SegmentedControl, type Column } from '@/components';
import { fmtCode, fmtNum, fmtPct, fmtUSD, NA_SHORT } from '@/lib/format';
import { useSearchParamState } from '@/lib/hooks';
import { routeForCode } from '@/lib/routes';
import { BASE_GRID, CATEGORICAL, withAlpha } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { useForecast } from '../api';
import { usdTick } from '../shared/chart';
import { MethodNote, MODEL_PROVENANCE, SourceNote, useTradeProvenance } from '../shared/ui';

/** Frequently requested HS2022 subheadings, offered as quick picks. */
const QUICK_PICKS: ReadonlyArray<{ code: string; label: string }> = [
  { code: '401110', label: 'Car tyres' },
  { code: '400121', label: 'Natural rubber sheets' },
  { code: '610910', label: 'Cotton T-shirts' },
  { code: '870810', label: 'Bumpers' },
  { code: '851713', label: 'Smartphones' },
  { code: '854143', label: 'Solar PV modules' },
];

type Flow = 'both' | 'exports' | 'imports';

/** Optional fields the API adds to the SPEC forecast shape. */
interface ForecastExtras {
  /** Fitted annual trend growth of the log-linear model (fraction), per flow. */
  trend_growth?: { exports?: number | null; imports?: number | null } | null;
  /** 'hs6' or an aggregate level when the code is a heading / chapter. */
  trade_level?: string | null;
  n_hs6?: number | null;
}

interface Row {
  year: number;
  exports: number | null;
  imports: number | null;
  ex_fc: ForecastPoint | null;
  im_fc: ForecastPoint | null;
}

function buildOption(d: ForecastResponse, flow: Flow, mode: 'light' | 'dark'): EChartsOption {
  const histYears = d.history.map((h) => h.year);
  const fcYears = [...new Set([...d.forecast.exports, ...d.forecast.imports].map((p) => p.year))].filter((y) => !histYears.includes(y));
  const years = [...histYears, ...fcYears].sort((a, b) => a - b);
  const lastYear = histYears.length ? Math.max(...histYears) : null;

  const series: LineSeriesOption[] = [];
  const flows: Array<{ key: 'exports' | 'imports'; name: string; color: string }> = [
    { key: 'exports', name: 'Exports', color: CATEGORICAL[mode][0] },
    { key: 'imports', name: 'Imports', color: CATEGORICAL[mode][1] },
  ];

  for (const f of flows) {
    if (flow !== 'both' && flow !== f.key) continue;
    const hist = new Map(d.history.map((h) => [h.year, h[f.key]]));
    const fc = new Map(d.forecast[f.key].map((p) => [p.year, p]));
    const last = lastYear !== null ? (hist.get(lastYear) ?? null) : null;

    series.push({
      type: 'line',
      name: `${f.name} (actual)`,
      data: years.map((y) => hist.get(y) ?? null),
      itemStyle: { color: f.color },
      lineStyle: { color: f.color, width: 2 },
      symbolSize: 7,
      connectNulls: false,
    });
    if (fc.size) {
      series.push({
        type: 'line',
        name: `${f.name} (forecast)`,
        data: years.map((y) => (y === lastYear ? last : (fc.get(y)?.value ?? null))),
        itemStyle: { color: f.color },
        lineStyle: { color: f.color, width: 2, type: 'dashed' },
        symbol: 'emptyCircle',
        symbolSize: 7,
        connectNulls: true,
      });
      // 95 % band: invisible lower bound + stacked band width.
      const stack = `band-${f.key}`;
      series.push({
        type: 'line',
        name: `${f.name} band low`,
        data: years.map((y) => (y === lastYear ? last : (fc.get(y)?.lo ?? null))),
        lineStyle: { opacity: 0 },
        symbol: 'none',
        stack,
        silent: true,
        tooltip: { show: false },
        connectNulls: true,
      });
      series.push({
        type: 'line',
        name: `${f.name} 95% band`,
        data: years.map((y) => {
          if (y === lastYear) return 0;
          const p = fc.get(y);
          return p && p.hi !== null && p.lo !== null ? p.hi - p.lo : null;
        }),
        lineStyle: { opacity: 0 },
        symbol: 'none',
        stack,
        areaStyle: { color: withAlpha(f.color, 0.14) },
        silent: true,
        tooltip: { show: false },
        connectNulls: true,
      });
    }
  }

  return {
    grid: { ...BASE_GRID, top: 40 },
    legend: { top: 0, left: 0, data: series.filter((s) => !String(s.name).includes('band')).map((s) => String(s.name)) },
    tooltip: {
      trigger: 'axis',
      formatter: (raw: unknown) => {
        const rows = (Array.isArray(raw) ? raw : [raw]) as Array<{ axisValue: string; seriesName: string; value: number | null; marker: string }>;
        const year = Number(rows[0]?.axisValue);
        const lines = rows
          .filter((r) => !r.seriesName.includes('band'))
          .filter((r) => !(r.seriesName.includes('forecast') && year === lastYear))
          .map((r) => `${r.marker}${r.seriesName}: <b>${fmtUSD(r.value)}</b>`);
        const bands = flows
          .filter((f) => flow === 'both' || flow === f.key)
          .map((f) => {
            const p = d.forecast[f.key].find((x) => x.year === year);
            return p && year !== lastYear ? `<span style="opacity:.75">${f.name} 95% band: ${fmtUSD(p.lo)} – ${fmtUSD(p.hi)}</span>` : '';
          })
          .filter(Boolean);
        return [`<b>${year}</b>`, ...lines, ...bands].join('<br/>');
      },
    },
    xAxis: { type: 'category', data: years.map(String), boundaryGap: false },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => usdTick(v) } },
    series,
  };
}

export function ForecastTab() {
  const [code, setCode] = useSearchParamState('code', '');
  const [flow, setFlow] = useState<Flow>('both');
  const q = useForecast(code);
  const trade = useTradeProvenance();
  const { mode } = useTheme();

  const pick = (raw: string) => {
    const c = normalizeCode(raw);
    if (/^\d{6}(\d{2})?$/.test(c)) setCode(c);
  };

  return (
    <div className="space-y-6">
      <Card padding="sm">
        <div className="flex flex-wrap items-center gap-3 px-1">
          <HsnSearchBox
            className="w-full sm:w-96"
            placeholder="Search a product or type a 6/8-digit HS code…"
            onSelect={(s) => pick(s.hsn8)}
            onSubmit={pick}
            clearOnSelect
            ariaLabel="Choose a product to forecast"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Pilot products:</span>
            {QUICK_PICKS.map((p) => (
              <button
                key={p.code}
                type="button"
                onClick={() => setCode(p.code)}
                className={
                  code === p.code
                    ? 'h-7 rounded-full border border-brand bg-brand-soft px-2.5 text-xs font-medium text-brand-ink'
                    : 'h-7 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-ink-2 hover:border-line-strong hover:text-ink'
                }
                title={`HS ${fmtCode(p.code)}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {!code ? (
        <EmptyState icon={LineChart} title="Choose a product to forecast" message="Search by name or HS code, or start from one of the quick picks above." />
      ) : (
        <QueryState query={q} isEmpty={(d) => !d.history.length} emptyTitle="No trade history for this code" emptyMessage="Forecasts need at least three years of positive trade.">
          {(d) => <ForecastBody d={d} flow={flow} setFlow={setFlow} mode={mode} trade={trade} />}
        </QueryState>
      )}
    </div>
  );
}

function ForecastBody({
  d,
  flow,
  setFlow,
  mode,
  trade,
}: {
  d: ForecastResponse;
  flow: Flow;
  setFlow: (f: Flow) => void;
  mode: 'light' | 'dark';
  trade: ReturnType<typeof useTradeProvenance>;
}) {
  const option = useMemo(() => buildOption(d, flow, mode), [d, flow, mode]);
  const rows = useMemo<Row[]>(() => {
    const years = [...new Set([...d.history.map((h) => h.year), ...d.forecast.exports.map((p) => p.year), ...d.forecast.imports.map((p) => p.year)])].sort((a, b) => a - b);
    return years.map((y) => {
      const h = d.history.find((x) => x.year === y);
      return {
        year: y,
        exports: h?.exports ?? null,
        imports: h?.imports ?? null,
        ex_fc: d.forecast.exports.find((p) => p.year === y) ?? null,
        im_fc: d.forecast.imports.find((p) => p.year === y) ?? null,
      };
    });
  }, [d]);
  const band = (p: ForecastPoint | null) =>
    p ? (
      <span className="whitespace-nowrap">
        {fmtUSD(p.value, { na: NA_SHORT })}
        <span className="ml-1 text-[11.5px] text-muted">
          {fmtUSD(p.lo, { na: NA_SHORT, sig: 2 })}–{fmtUSD(p.hi, { na: NA_SHORT, sig: 2 })}
        </span>
      </span>
    ) : (
      <span className="text-muted">{NA_SHORT}</span>
    );
  const columns: Column<Row>[] = [
    { key: 'year', header: 'Year', value: (r) => r.year, render: (r) => <span className="font-medium">{r.year}</span>, firstSort: 'asc' },
    { key: 'exports', header: 'Exports (actual)', align: 'right', value: (r) => r.exports, render: (r) => fmtUSD(r.exports, { na: NA_SHORT }) },
    { key: 'ex_fc', header: 'Exports forecast (95% band)', align: 'right', value: (r) => r.ex_fc?.value ?? null, render: (r) => band(r.ex_fc), csv: (r) => r.ex_fc?.value ?? null },
    { key: 'imports', header: 'Imports (actual)', align: 'right', value: (r) => r.imports, render: (r) => fmtUSD(r.imports, { na: NA_SHORT }) },
    { key: 'im_fc', header: 'Imports forecast (95% band)', align: 'right', value: (r) => r.im_fc?.value ?? null, render: (r) => band(r.im_fc), csv: (r) => r.im_fc?.value ?? null },
  ];
  const to = routeForCode(d.code);
  const extras = d as ForecastResponse & ForecastExtras;
  const growth = extras.trend_growth ?? null;
  const missing = (['exports', 'imports'] as const).filter((k) => !d.forecast[k].length);
  // Years with recorded trade: codes created in a recent HS edition (e.g. 8517.13 in HS 2022) start late.
  const traded = d.history.filter((h) => (h.exports ?? 0) > 0 || (h.imports ?? 0) > 0).map((h) => h.year);
  const firstYear = traded.length ? Math.min(...traded) : null;
  const lastYear = traded.length ? Math.max(...traded) : null;
  const span = firstYear !== null && lastYear !== null ? (firstYear === lastYear ? `${firstYear}` : `${firstYear}–${lastYear}`) : '2018–2024';
  const shortHistory = firstYear !== null && firstYear > 2018;
  return (
    <div className="space-y-6">
      <Card
        title={
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <CodeLink code={d.code} to={to ?? undefined} />
            <span>{d.description}</span>
          </span>
        }
        subtitle={`India's exports and imports, actual ${span} and forecast with a 95% band (US$)`}
        actions={
          <>
            <SegmentedControl
              value={flow}
              onChange={setFlow}
              ariaLabel="Trade flow"
              options={[
                { value: 'both', label: 'Both' },
                { value: 'exports', label: 'Exports' },
                { value: 'imports', label: 'Imports' },
              ]}
            />
            <ModelEstimateTag method={d.method} />
          </>
        }
        footer={<SourceNote provenances={[trade, MODEL_PROVENANCE]} />}
      >
        <EChart option={option} height={360} ariaLabel={`Trade history and forecast for HS ${d.code}`} />
      </Card>
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Values" subtitle="Actuals and forecasts with the 95% band" padding="md">
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.year} pagination={false} maxHeight={null} dense csvFilename={`atlas-forecast-${d.code}`} />
        </Card>
        <MethodNote title="Forecast method" method={d.method} className="self-start">
          <p>{d.method}</p>
          {growth && (typeof growth.exports === 'number' || typeof growth.imports === 'number') ? (
            <p className="mt-2">
              Fitted trend: exports <b>{fmtPct(growth.exports ?? null, { signed: true })}</b> a year, imports{' '}
              <b>{fmtPct(growth.imports ?? null, { signed: true })}</b> a year
              {extras.n_hs6 && extras.n_hs6 > 1 ? ` (sum of ${extras.n_hs6} HS6 subheadings)` : ''}.
            </p>
          ) : null}
          {missing.length ? (
            <p className="mt-2">
              No {missing.join(' or ')} forecast: the model needs at least three years with positive trade.
            </p>
          ) : null}
          {shortHistory ? (
            <p className="mt-2">
              Trade in this code is recorded from {firstYear} only (it may be new in the HS nomenclature), so the trend rests on {fmtNum(traded.length)}{' '}
              {traded.length === 1 ? 'year' : 'years'} and the band is wide.
            </p>
          ) : null}
          <p className="mt-2">
            The band widens with how irregular the past series was. Forecasts extrapolate the {span} trend and cannot anticipate policy changes,
            new capacity or shocks.
          </p>
        </MethodNote>
      </div>
    </div>
  );
}
