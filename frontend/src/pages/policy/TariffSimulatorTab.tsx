/**
 * Tariff scenario simulator (Policy Workbench, GOV) - POST /api/policy/simulate-tariff.
 *
 * 1. Pick up to 10 HS codes (typeahead or typed 4/6/8-digit codes; `?codes=` pre-selects, e.g. from the
 *    Opportunity Lab substitution tab). Each chip shows the current MFN tariff (a range for headings).
 *    A heading is simulated subheading by subheading.
 * 2. Set the new BCD and the behavioural assumptions, each explained, with the SPEC defaults:
 *    import price elasticity sigma = 2.5, substitution share = 0.5, input-cost share = 0.10. An
 *    optional "current tariff override" (the API's `base_tariff_pct`) simulates lines whose tariff
 *    is not ad valorem.
 * 3. Results: totals, imports before / after per code, the per-code table with the tariff basis and
 *    notes, downstream cost increases along value-chain paths, and the assumptions box.
 *
 * Model (SPEC section 4): M1 = M0 x ((1 + t1) / (1 + t0))^(-sigma); revenue = t x M;
 * domestic opportunity = -dM x substitution share; downstream cost increase = input-cost share x
 * ((1 + t1) / (1 + t0) - 1).
 */
import { useEffect, useMemo, useState } from 'react';
import { Calculator, CircleDollarSign, Factory, Play, RotateCcw, Ship, Trash2, X } from 'lucide-react';
import { errorMessage, normalizeCode } from '@/api/client';
import { Button, Card, CodeLink, DataTable, EChart, EmptyState, ErrorState, FormField, HsnSearchBox, KpiTile, ModelEstimateTag, StatGrid, TextInput, Toggle, Tooltip, type Column } from '@/components';
import { fmtCode, fmtNum, fmtPct, fmtRate, fmtUSD, NA_SHORT, truncate } from '@/lib/format';
import { useSearchParamState } from '@/lib/hooks';
import { CATEGORICAL } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { groupedHBarOption } from '../analytics/shared/chart';
import { MethodNote, MODEL_PROVENANCE, SourceNote, TARIFF_PROVENANCE, usd, useTradeProvenance } from '../analytics/shared/ui';
import { useCodeInfos, useSimulateTariff, type SimDownstream, type SimResponse, type SimRow } from './api';

const MAX_CODES = 10;
/** Codes accepted by the picker: heading (4), subheading (6) or tariff line (8). */
const CODE_RE = /^\d{4}(\d{2}){0,2}$/;
/** Rows drawn in the before / after chart (the table always lists every row). */
const CHART_ROWS = 15;

const TARIFF_SOURCE_LABEL: Record<string, string> = {
  wits: 'WITS MFN applied',
  request: 'Override',
};
const DEFAULTS = { elasticity: 2.5, substitution_share: 0.5, input_cost_share: 0.1 } as const;

interface ParamDef {
  key: keyof typeof DEFAULTS;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  help: string;
}

const PARAMS: ParamDef[] = [
  {
    key: 'elasticity',
    label: 'Import price elasticity (σ)',
    min: 0.5,
    max: 6,
    step: 0.1,
    format: (v) => fmtNum(v, { digits: 1 }),
    help: 'How strongly imports fall when the landed price rises. 2.5 is a common mid-range estimate for manufactured goods; use lower values for essential inputs without substitutes.',
  },
  {
    key: 'substitution_share',
    label: 'Domestic substitution share',
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => fmtPct(v, { digits: 0 }),
    help: 'Share of the import reduction that Indian producers capture. The rest is demand that disappears or shifts to other products.',
  },
  {
    key: 'input_cost_share',
    label: 'Input cost share downstream',
    min: 0,
    max: 0.5,
    step: 0.01,
    format: (v) => fmtPct(v, { digits: 0 }),
    help: "Share of a downstream product's cost made up by this input. Drives the cost increase passed to user industries.",
  },
];

function parseCodes(raw: string): string[] {
  return [...new Set(raw.split(',').map((c) => normalizeCode(c)).filter((c) => CODE_RE.test(c)))].slice(0, MAX_CODES);
}

/**
 * SPEC does not pin the unit of `tariff_before` / `tariff_after`. The request uses percent
 * (`new_tariff_pct`), so percent is expected; if the backend echoes fractions (tariff_after equal to
 * rate / 100) they are converted, so the table never shows "0.2%" for a 20% duty.
 */
function normaliseTariffUnits(r: SimResponse, rate: number): SimResponse {
  const fractional = rate > 1 && r.results.some((x) => x.tariff_after !== null && Math.abs(x.tariff_after - rate / 100) < 1e-6);
  if (!fractional) return r;
  return {
    ...r,
    results: r.results.map((x) => ({
      ...x,
      tariff_before: x.tariff_before === null ? null : x.tariff_before * 100,
      tariff_after: x.tariff_after === null ? null : x.tariff_after * 100,
    })),
  };
}

/** "40011000 -> 4011 -> 8703" as formatted codes joined by arrows. */
function PathCodes({ via }: { via: string }) {
  const parts = via.split(/\s*(?:->|→|>)\s*/).filter(Boolean);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 font-mono text-[12px] text-ink-2 atlas-num">
      {parts.map((c, i) => (
        <span key={`${c}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-muted" aria-hidden>→</span> : null}
          {fmtCode(c)}
        </span>
      ))}
    </span>
  );
}

/** Results of one simulation run (exported for reuse and verification). */
export function SimulationResults({ r: raw, rate }: { r: SimResponse; rate: number }) {
  const { mode } = useTheme();
  const r = useMemo(() => normaliseTariffUnits(raw, rate), [raw, rate]);
  const trade = useTradeProvenance();
  const t = r.totals;
  const chartRows = useMemo(() => [...r.results].filter((x) => x.imports_before !== null).sort((a, b) => (b.imports_before ?? 0) - (a.imports_before ?? 0)).slice(0, CHART_ROWS), [r.results]);
  const label = (x: SimRow) => (x.code === x.hs6 || !x.hs6 ? fmtCode(x.code) : `${fmtCode(x.hs6)}`);
  const option = useMemo(
    () =>
      groupedHBarOption({
        categories: chartRows.map((x) => `${label(x)} ${x.description}`),
        fullLabels: chartRows.map((x) => `${label(x)} · ${x.description}`),
        series: [
          { name: 'Imports before', values: chartRows.map((x) => x.imports_before), color: CATEGORICAL[mode][1] },
          { name: `Imports at ${fmtRate(rate)} BCD`, values: chartRows.map((x) => x.imports_after), color: CATEGORICAL[mode][0] },
        ],
        labelMax: 30,
      }),
    [chartRows, mode, rate],
  );
  const notes = r.results.filter((x) => x.note).length;

  const cols: Column<SimRow>[] = [
    {
      key: 'code',
      header: 'HS code',
      value: (x) => x.code,
      render: (x) => (
        <div className="flex flex-col">
          <CodeLink code={x.code} />
          {x.hs6 && x.hs6 !== x.code && x.code.length < 6 ? <span className="font-mono text-[11px] text-muted">{fmtCode(x.hs6)}</span> : null}
        </div>
      ),
      width: 110,
    },
    {
      key: 'description',
      header: 'Product',
      value: (x) => x.description,
      render: (x) => (
        <div className="min-w-40">
          <span className="line-clamp-2 text-[12.5px]">{x.description}</span>
          {x.note ? <div className="mt-0.5 text-[11.5px] leading-snug text-na-ink">{x.note}</div> : null}
        </div>
      ),
    },
    {
      key: 'tb',
      header: 'Tariff before',
      align: 'right',
      value: (x) => x.tariff_before,
      render: (x) => (
        <Tooltip content={x.tariff_source ? (TARIFF_SOURCE_LABEL[x.tariff_source] ?? x.tariff_source) : null}>
          <span>{fmtRate(x.tariff_before, { na: NA_SHORT })}</span>
        </Tooltip>
      ),
    },
    { key: 'ta', header: 'Tariff after', align: 'right', value: (x) => x.tariff_after, render: (x) => fmtRate(x.tariff_after, { na: NA_SHORT }) },
    { key: 'mb', header: 'Imports before', align: 'right', value: (x) => x.imports_before, render: (x) => usd(x.imports_before) },
    { key: 'ma', header: 'Imports after', align: 'right', value: (x) => x.imports_after, render: (x) => usd(x.imports_after) },
    { key: 'dm', header: 'Change', align: 'right', value: (x) => x.delta_imports, render: (x) => fmtUSD(x.delta_imports, { signed: true, na: NA_SHORT }) },
    { key: 'rb', header: 'Duty before', align: 'right', value: (x) => x.revenue_before, render: (x) => usd(x.revenue_before), hideBelow: 'lg' },
    { key: 'ra', header: 'Duty after', align: 'right', value: (x) => x.revenue_after, render: (x) => usd(x.revenue_after), hideBelow: 'lg' },
    { key: 'dom', header: 'Domestic opportunity', align: 'right', value: (x) => x.domestic_opportunity_usd, render: (x) => usd(x.domestic_opportunity_usd) },
  ];
  const downCols: Column<SimDownstream>[] = [
    { key: 'code', header: 'Downstream product', value: (x) => x.code, render: (x) => <CodeLink code={x.code} label={truncate(x.description, 60)} /> },
    { key: 'via', header: 'Path from the simulated code', value: (x) => x.path ?? x.via, render: (x) => <PathCodes via={x.path ?? x.via} /> },
    { key: 'hops', header: 'Steps', align: 'right', value: (x) => x.hops ?? null, render: (x) => (typeof x.hops === 'number' ? fmtNum(x.hops) : NA_SHORT), hideBelow: 'md', hint: 'Value-chain steps between the simulated input and this product' },
    {
      key: 'cost',
      header: 'Cost increase',
      align: 'right',
      value: (x) => x.cost_increase_pct,
      render: (x) => (x.cost_increase_pct === null ? NA_SHORT : `${x.cost_increase_pct >= 0 ? '+' : '−'}${fmtNum(Math.abs(x.cost_increase_pct), { digits: 2 })}%`),
      firstSort: 'desc',
    },
  ];

  const revDelta = t.revenue_after !== null && t.revenue_before !== null ? t.revenue_after - t.revenue_before : null;

  return (
    <div className="space-y-6">
      <StatGrid cols={4}>
        <KpiTile label="Imports before → after" value={fmtUSD(t.imports_after)} sub={`from ${fmtUSD(t.imports_before)}`} icon={Ship} provenance={MODEL_PROVENANCE} />
        <KpiTile
          label="Change in imports"
          value={fmtUSD(t.delta_imports, { signed: true })}
          icon={Ship}
          accent={(t.delta_imports ?? 0) <= 0 ? 'ok' : 'bad'}
          sub={t.imports_before ? `${fmtPct((t.delta_imports ?? 0) / t.imports_before, { signed: true })} of the import bill` : undefined}
          provenance={MODEL_PROVENANCE}
        />
        <KpiTile label="Customs duty after" value={fmtUSD(t.revenue_after)} sub={revDelta === null ? undefined : `${fmtUSD(revDelta, { signed: true })} vs today`} icon={CircleDollarSign} accent="brand" provenance={MODEL_PROVENANCE} />
        <KpiTile
          label="Domestic production opportunity"
          value={fmtUSD(t.domestic_opportunity_usd, { signed: (t.domestic_opportunity_usd ?? 0) < 0 })}
          icon={Factory}
          accent={(t.domestic_opportunity_usd ?? 0) < 0 ? 'bad' : 'kpi'}
          sub={(t.domestic_opportunity_usd ?? 0) < 0 ? 'Negative: a lower duty lets imports displace Indian output' : 'Imports replaced by Indian output'}
          provenance={MODEL_PROVENANCE}
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card
          title="Imports before and after"
          subtitle={r.results.length > chartRows.length ? `US$ at the new BCD, the ${fmtNum(chartRows.length)} largest of ${fmtNum(r.results.length)} rows` : 'US$ per product at the new BCD'}
          actions={<ModelEstimateTag method={r.assumptions.formula} />}
        >
          {chartRows.length ? (
            <EChart option={option} height={Math.max(220, chartRows.length * 44 + 40)} ariaLabel="Imports before and after the tariff change" />
          ) : (
            <EmptyState compact title="No import data for the selected codes" />
          )}
        </Card>
        <Card title="Assumptions used" subtitle="Returned by the simulator with the results" tone="subtle">
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">New BCD</dt>
              <dd className="font-semibold text-ink atlas-num">{fmtRate(rate)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">Import price elasticity (σ)</dt>
              <dd className="font-semibold text-ink atlas-num">{fmtNum(r.assumptions.elasticity, { digits: 1 })}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">Domestic substitution share</dt>
              <dd className="font-semibold text-ink atlas-num">{fmtPct(r.assumptions.substitution_share, { digits: 0 })}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">Input cost share downstream</dt>
              <dd className="font-semibold text-ink atlas-num">{fmtPct(r.assumptions.input_cost_share, { digits: 0 })}</dd>
            </div>
            {typeof r.assumptions.base_tariff_pct === 'number' ? (
              <div className="flex justify-between gap-3">
                <dt className="text-ink-2">Current tariff override</dt>
                <dd className="font-semibold text-ink atlas-num">{fmtRate(r.assumptions.base_tariff_pct)}</dd>
              </div>
            ) : null}
          </dl>
          <div className="mt-3 rounded-md border border-line bg-surface px-3 py-2 font-mono text-[11.5px] leading-relaxed break-words text-ink-2">{r.assumptions.formula}</div>
          {r.assumptions.tariff_basis || r.assumptions.import_basis ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12px] text-ink-2">
              {r.assumptions.tariff_basis ? <li>Tariffs: {r.assumptions.tariff_basis}</li> : null}
              {r.assumptions.import_basis ? <li>Imports: {r.assumptions.import_basis}</li> : null}
            </ul>
          ) : null}
          <p className="mt-3 text-[12px] text-muted">
            A partial-equilibrium screening estimate on latest-year imports: it ignores exchange-rate moves, retaliation, FTA preferences and
            capacity limits. Use it to compare options, not as a revenue forecast.
          </p>
        </Card>
      </div>

      <Card
        title="Results by product"
        subtitle={notes ? `${fmtNum(notes)} row${notes === 1 ? '' : 's'} carry a note explaining a missing figure` : 'Tariff before shows the basis on hover (WITS MFN applied or your override)'}
        footer={<SourceNote provenances={[trade, TARIFF_PROVENANCE, MODEL_PROVENANCE]} />}
      >
        <DataTable
          columns={cols}
          rows={r.results}
          rowKey={(x, i) => `${x.code}-${x.hs6}-${i}`}
          pagination={r.results.length > 25 ? { mode: 'client', pageSize: 25 } : false}
          maxHeight={null}
          dense
          csvFilename="atlas-tariff-simulation"
        />
      </Card>

      <Card
        title="Downstream cost impact"
        subtitle="Products that use the selected codes as inputs in the value-chain graph, and how much their input costs rise. Each further step passes on only its input-cost share."
        actions={<ModelEstimateTag method="input-cost share^steps × price change" />}
      >
        <DataTable
          columns={downCols}
          rows={r.downstream}
          rowKey={(x, i) => `${x.code}-${x.via}-${i}`}
          defaultSort={{ key: 'cost', order: 'desc' }}
          dense
          csvFilename="atlas-tariff-downstream"
          emptyTitle="No downstream links recorded"
          emptyMessage="None of the selected codes feeds another product in the curated value chains."
        />
      </Card>
    </div>
  );
}

export function TariffSimulatorTab() {
  const [codesParam, setCodesParam] = useSearchParamState('codes', '');
  const codes = useMemo(() => parseCodes(codesParam), [codesParam]);
  const infos = useCodeInfos(codes);
  const [rate, setRate] = useState<number>(20);
  const [rateTouched, setRateTouched] = useState(false);
  const [params, setParams] = useState<Record<keyof typeof DEFAULTS, number>>({ ...DEFAULTS });
  const [override, setOverride] = useState(false);
  const [baseRate, setBaseRate] = useState<number>(10);
  const sim = useSimulateTariff();

  const setCodes = (next: string[]) => setCodesParam(next.length ? next.join(',') : null);
  const add = (raw: string) => {
    const c = normalizeCode(raw);
    if (!CODE_RE.test(c) || codes.includes(c) || codes.length >= MAX_CODES) return;
    setCodes([...codes, c]);
  };

  const mfns = infos.map((i) => i.data?.mfn).filter((v): v is number => typeof v === 'number');
  const avgMfn = mfns.length ? mfns.reduce((a, b) => a + b, 0) / mfns.length : null;

  // Start the slider at the current average tariff of the picked codes until the user moves it.
  useEffect(() => {
    if (!rateTouched && avgMfn !== null) setRate(Math.round(avgMfn * 2) / 2);
  }, [avgMfn, rateTouched]);

  const run = () => sim.mutate({ codes, new_tariff_pct: rate, ...params, ...(override ? { base_tariff_pct: baseRate } : {}) });
  const changed = PARAMS.some((p) => params[p.key] !== DEFAULTS[p.key]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="1. Choose products" subtitle={`Up to ${MAX_CODES} HS codes (4, 6 or 8 digits). The current tariff is shown for each; a heading is simulated subheading by subheading.`} icon={Calculator}>
          <HsnSearchBox
            placeholder="Search a product or type an HS code, then Enter…"
            onSelect={(s) => add(s.hsn8)}
            onSubmit={add}
            clearOnSelect
            ariaLabel="Add a product to the simulation"
          />
          {codes.length ? (
            <ul className="mt-3 space-y-2">
              {codes.map((c, i) => {
                const info = infos[i]?.data;
                const err = infos[i]?.error;
                return (
                  <li key={c} className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <CodeLink code={c} />
                      <div className="truncate text-[12.5px] text-ink-2" title={info?.description ?? undefined}>
                        {info?.description ?? (err ? `Not found: ${errorMessage(err)}` : 'Loading…')}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[12px]">
                      <div className="text-muted">{info && info.level !== 'line' ? 'MFN applied (mean)' : 'MFN applied'}</div>
                      <div className="font-semibold text-ink atlas-num">{info ? fmtRate(info.mfn, { digits: info.level === 'line' ? undefined : 1 }) : err ? NA_SHORT : '…'}</div>
                      {info?.mfnRange ? (
                        <div className="text-[11px] text-muted atlas-num">
                          range {fmtRate(info.mfnRange[0])}–{fmtRate(info.mfnRange[1])}
                        </div>
                      ) : null}
                      {info?.bcd ? <div className="text-[11px] text-muted">BCD {info.bcd}</div> : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setCodes(codes.filter((x) => x !== c))}
                      className="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-ink"
                      aria-label={`Remove ${c}`}
                    >
                      <X className="size-4" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState compact icon={Calculator} title="No products selected" message="Add the products whose Basic Customs Duty you want to change." />
          )}
          {codes.length ? (
            <div className="mt-3 flex items-center justify-between text-xs text-muted">
              <span>
                {codes.length} of {MAX_CODES} · average current MFN {avgMfn === null ? 'not available' : fmtRate(avgMfn, { digits: 1 })}
              </span>
              <Button size="xs" variant="ghost" icon={Trash2} onClick={() => setCodes([])}>
                Clear all
              </Button>
            </div>
          ) : null}
        </Card>

        <Card
          title="2. Set the scenario"
          subtitle="One new BCD rate applies to every selected product"
          actions={
            <Button size="xs" variant="ghost" icon={RotateCcw} disabled={!changed} onClick={() => setParams({ ...DEFAULTS })}>
              Reset assumptions
            </Button>
          }
        >
          <FormField label="New Basic Customs Duty (BCD)" htmlFor="sim-rate" hint="Today's applied WITS MFN rate is the starting point for each product.">
            <div className="flex items-center gap-3">
              <input
                id="sim-rate"
                type="range"
                min={0}
                max={100}
                step={0.5}
                value={rate}
                onChange={(e) => {
                  setRateTouched(true);
                  setRate(Number(e.target.value));
                }}
                className="h-2 flex-1 cursor-pointer accent-[var(--atlas-brand)]"
                aria-valuetext={`${rate}%`}
              />
              <div className="w-24 shrink-0">
                <TextInput
                  type="number"
                  size="sm"
                  min={0}
                  max={150}
                  step={0.5}
                  value={rate}
                  onChange={(e) => {
                    setRateTouched(true);
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setRate(Math.max(0, Math.min(150, v)));
                  }}
                  className="text-right"
                  aria-label="New BCD percent"
                />
              </div>
              <span className="text-sm text-ink-2">%</span>
            </div>
          </FormField>

          <div className="mt-4 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <Toggle checked={override} onChange={setOverride} size="sm" label="Override today's tariff for every selected product" />
            {override ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                <label htmlFor="sim-base">Current tariff</label>
                <div className="w-24">
                  <TextInput
                    id="sim-base"
                    type="number"
                    size="sm"
                    min={0}
                    max={150}
                    step={0.5}
                    value={baseRate}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setBaseRate(Math.max(0, Math.min(150, v)));
                    }}
                    className="text-right"
                  />
                </div>
                <span>%</span>
                <span className="basis-full text-[11.5px] text-muted">
                  Use it for lines whose MFN duty is specific (per unit) rather than ad valorem, which the simulator cannot otherwise price.
                </span>
              </div>
            ) : null}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
            {PARAMS.map((p) => (
              <FormField key={p.key} label={p.label} htmlFor={`sim-${p.key}`} hint={p.help}>
                <div className="flex items-center gap-2">
                  <input
                    id={`sim-${p.key}`}
                    type="range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={params[p.key]}
                    onChange={(e) => setParams((prev) => ({ ...prev, [p.key]: Number(e.target.value) }))}
                    className="h-2 flex-1 cursor-pointer accent-[var(--atlas-brand)]"
                    aria-valuetext={p.format(params[p.key])}
                  />
                  <span className="w-12 text-right text-[13px] font-semibold text-ink atlas-num">{p.format(params[p.key])}</span>
                </div>
                <div className="text-[11px] text-muted">Default {p.format(DEFAULTS[p.key])}</div>
              </FormField>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button variant="primary" icon={Play} onClick={run} disabled={!codes.length} loading={sim.isPending}>
              Run simulation
            </Button>
            <ModelEstimateTag method="Constant-elasticity import demand (SPEC section 4)" />
            {!codes.length ? <span className="text-xs text-muted">Add at least one product first.</span> : null}
          </div>
        </Card>
      </div>

      {sim.isError ? <ErrorState error={sim.error} onRetry={run} compact /> : null}
      {sim.data?.unknown_codes?.length ? (
        <div className="rounded-lg border border-na/40 bg-na-soft px-3.5 py-2.5 text-[13px] text-ink" role="status">
          Not found in the HS nomenclature and left out of the scenario: <span className="font-mono">{sim.data.unknown_codes.map((c) => fmtCode(c)).join(', ')}</span>
        </div>
      ) : null}
      {sim.data ? (
        <SimulationResults r={sim.data} rate={sim.variables?.new_tariff_pct ?? rate} />
      ) : !sim.isError ? (
        <MethodNote method="Tariff scenario model (SPEC section 4)">
          <p>
            For each product, imports respond to the change in landed price: <b>M₁ = M₀ × ((1 + t₁) / (1 + t₀))^(−σ)</b>. Customs duty = tariff ×
            imports. The <b>domestic opportunity</b> is the fall in imports times the substitution share. Every product reachable downstream in
            the value-chain graph sees its input cost rise by the input-cost share × the price change.
          </p>
        </MethodNote>
      ) : null}
    </div>
  );
}
