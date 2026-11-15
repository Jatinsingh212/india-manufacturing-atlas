/**
 * Export potential tab (Opportunity Lab) - GET /api/analytics/opportunities.
 *
 * - KPI strip: products analysed, total untapped potential (model estimate), champions, top opportunity.
 * - Opportunity matrix (bubble scatter): x = RCA (log scale, or linear capped at 5), y = world demand
 *   CAGR 2018-24, bubble area = world market, colour = rule archetype (archetypeColor + legend).
 *   Reference lines at RCA = 1 and the median world growth of the plotted products split it into four
 *   labelled quadrants. Off-scale growth values are clamped to the plot edge and drawn as triangles
 *   (the tooltip and the table carry the true value).
 * - Ranked table with export_potential_score and untapped_potential_usd (SPEC section 4 formulas).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { EChartsOption, ScatterSeriesOption } from 'echarts';
import { Award, Coins, Crosshair, Layers } from 'lucide-react';
import type { AnalyticsFilters, OpportunityItem, OpportunityMatrixPoint } from '@/api/types';
import { ArchetypeBadge, Card, DataTable, EChart, KpiTile, ModelEstimateTag, QueryState, ScoreBar, SegmentedControl, StatGrid, type Column } from '@/components';
import { fmtCode, fmtNum, fmtPct, fmtRatio, fmtUSD, truncate } from '@/lib/format';
import { useMediaQuery } from '@/lib/hooks';
import { routeForCode, routes } from '@/lib/routes';
import { ARCHETYPE_ORDER, archetypeColor, BASE_GRID, CHART_TOKENS, OTHER_GREY, type ThemeMode } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { useArchetypes, useOpportunities } from '../api';
import { escapeHtml } from '../shared/chart';
import { Hs6Code, ItemMinistry, median, MethodNote, MODEL_PROVENANCE, pct, ProductText, quantile, ratio, ScoresPendingNote, SourceNote, usd, useTradeProvenance } from '../shared/ui';

type XScale = 'log' | 'capped';
const RCA_CAP = 5;
const UNCLASSIFIED = 'Unclassified';

interface PlotPoint {
  hs6: string;
  label: string;
  rca: number | null;
  cagr: number | null;
  size: number | null;
  archetype: string;
  offscale: boolean;
}

/** Build the bubble-matrix option and the counts the caption needs. */
function matrixOption(points: OpportunityMatrixPoint[], scale: XScale, mode: ThemeMode, compact = false) {
  const t = CHART_TOKENS[mode];
  const usable = points.filter((p) => typeof p.y === 'number' && typeof p.x === 'number' && (scale === 'capped' || (p.x as number) > 0));
  const excluded = points.length - usable.length;

  const ys = usable.map((p) => p.y as number);
  const q02 = quantile(ys, 0.02) ?? -0.05;
  const q98 = quantile(ys, 0.98) ?? 0.05;
  const yPad = Math.max(0.02, (q98 - q02) * 0.08);
  // Round the growth axis to a clean step so the edge labels never collide with the ticks.
  const rawMin = Math.min(q02, -0.02) - yPad;
  const rawMax = Math.max(q98, 0.02) + yPad;
  const range = rawMax - rawMin;
  const yStep = range > 0.6 ? 0.2 : range > 0.3 ? 0.1 : range > 0.12 ? 0.05 : 0.02;
  const yMin = Math.floor(rawMin / yStep) * yStep;
  const yMax = Math.ceil(rawMax / yStep) * yStep;
  const medY = median(ys) ?? 0;

  const xs = usable.map((p) => p.x as number);
  let xMin = 0;
  let xMax = RCA_CAP;
  if (scale === 'log') {
    const lo = Math.min(...xs, 1);
    const hi = Math.max(...xs, 1);
    xMin = Math.max(1e-3, 10 ** Math.floor(Math.log10(lo)));
    xMax = Math.max(10, 10 ** Math.ceil(Math.log10(hi)));
  }

  const maxSize = Math.max(1, ...usable.map((p) => p.size ?? 0));
  const sizeOf = (v: number) => 6 + Math.sqrt(Math.max(0, v) / maxSize) * 36;

  const info = new Map<string, PlotPoint>();
  const groups = new Map<string, Array<{ name: string; value: [number, number, number]; symbol: string }>>();
  for (const p of usable) {
    const x0 = p.x as number;
    const y0 = p.y as number;
    const x = scale === 'capped' ? Math.min(x0, RCA_CAP) : Math.max(x0, xMin);
    const y = Math.min(Math.max(y0, yMin), yMax);
    const off = y !== y0 || (scale === 'log' && x !== x0);
    const arch = p.archetype ?? UNCLASSIFIED;
    info.set(p.hs6, { hs6: p.hs6, label: p.label, rca: x0, cagr: y0, size: p.size, archetype: arch, offscale: off || (scale === 'capped' && x0 > RCA_CAP) });
    const list = groups.get(arch) ?? [];
    list.push({ name: p.hs6, value: [x, y, p.size ?? 0], symbol: off ? 'triangle' : 'circle' });
    groups.set(arch, list);
  }

  const order: string[] = [...ARCHETYPE_ORDER, UNCLASSIFIED];
  const series: ScatterSeriesOption[] = order
    .filter((a) => groups.has(a))
    .map((a) => ({
      type: 'scatter',
      name: a,
      data: groups.get(a),
      symbolSize: (val: number[]) => sizeOf(val[2]),
      itemStyle: { color: a === UNCLASSIFIED ? OTHER_GREY[mode] : archetypeColor(a, mode), opacity: 0.82, borderColor: t.surface, borderWidth: 1.5 },
      emphasis: { focus: 'series', itemStyle: { opacity: 1 } },
    }));

  const quadLabel = (text: string, position: 'insideTopLeft' | 'insideTopRight' | 'insideBottomLeft' | 'insideBottomRight') => ({
    name: text,
    label: { show: true, position, formatter: text, color: t.muted, fontSize: 11, fontWeight: 600 as const, padding: 6 },
  });

  // Reference lines and quadrant captions ride on an invisible helper series.
  series.push({
    type: 'scatter',
    name: '__reference',
    data: [[1, medY]],
    symbolSize: 0,
    silent: true,
    tooltip: { show: false },
    markLine: {
      silent: true,
      symbol: 'none',
      lineStyle: { color: t.axis, type: 'solid', width: 1 },
      label: { color: t.muted, fontSize: 10.5 },
      data: [
        { xAxis: 1, label: { formatter: 'RCA = 1', position: 'end' } },
        { yAxis: medY, label: { formatter: `Median ${fmtPct(medY, { digits: 1 })}`, position: 'insideEndTop' } },
      ],
    },
    markArea: {
      silent: true,
      itemStyle: { color: 'transparent' },
      data: [
        [{ ...quadLabel(compact ? 'Build' : 'Build capability', 'insideTopLeft'), xAxis: xMin, yAxis: medY }, { xAxis: 1, yAxis: yMax }],
        [{ ...quadLabel(compact ? 'Leaders' : 'Strengthen leaders', 'insideTopRight'), xAxis: 1, yAxis: medY }, { xAxis: xMax, yAxis: yMax }],
        [{ ...quadLabel(compact ? 'Niche' : 'Selective / niche', 'insideBottomLeft'), xAxis: xMin, yAxis: yMin }, { xAxis: 1, yAxis: medY }],
        [{ ...quadLabel(compact ? 'Defend' : 'Defend & diversify', 'insideBottomRight'), xAxis: 1, yAxis: yMin }, { xAxis: xMax, yAxis: medY }],
      ],
    },
  });

  const option: EChartsOption = {
    grid: { ...BASE_GRID, top: 40, left: 34, bottom: 34, right: 24 },
    legend: { top: 0, left: 0, data: order.filter((a) => groups.has(a)) },
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { name?: string };
        const d = p.name ? info.get(p.name) : undefined;
        if (!d) return '';
        return [
          `<div style="max-width:260px;white-space:normal"><b>${escapeHtml(truncate(d.label, 80))}</b></div>`,
          `<span style="color:${t.muted}">HS ${fmtCode(d.hs6)} · ${escapeHtml(d.archetype)}</span>`,
          `RCA: <b>${fmtRatio(d.rca)}</b>`,
          `World demand growth (CAGR): <b>${fmtPct(d.cagr, { signed: true })}</b>`,
          `World market: <b>${fmtUSD(d.size)}</b>`,
          d.offscale ? `<span style="color:${t.muted}">Shown at the plot edge (off-scale)</span>` : '',
        ]
          .filter(Boolean)
          .join('<br/>');
      },
    },
    xAxis:
      scale === 'log'
        ? { type: 'log', logBase: 10, min: xMin, max: xMax, name: compact ? 'RCA (log scale)' : 'Revealed comparative advantage (RCA, log scale)', nameLocation: 'middle', nameGap: 26, axisLabel: { formatter: (v: number) => fmtNum(v) } }
        : { type: 'value', min: 0, max: RCA_CAP, name: compact ? `RCA (capped at ${RCA_CAP})` : `Revealed comparative advantage (RCA, capped at ${RCA_CAP})`, nameLocation: 'middle', nameGap: 26 },
    yAxis: {
      type: 'value',
      min: yMin,
      max: yMax,
      interval: yStep,
      name: 'World demand growth, CAGR 2018–24',
      nameLocation: 'middle',
      nameGap: 46,
      axisLabel: { formatter: (v: number) => fmtPct(v, { digits: 0 }) },
    },
    series,
  };
  return { option, plotted: usable.length, excluded };
}

function OpportunityMatrix({ items, matrix }: { items: OpportunityItem[]; matrix: OpportunityMatrixPoint[] }) {
  const { mode } = useTheme();
  const navigate = useNavigate();
  const [scale, setScale] = useState<XScale>('log');
  const compact = useMediaQuery('(max-width: 639px)');
  const bySix = useMemo(() => new Map(items.map((i) => [i.hs6, i])), [items]);
  const { option, plotted, excluded } = useMemo(() => matrixOption(matrix, scale, mode, compact), [matrix, scale, mode, compact]);

  return (
    <Card
      title="Opportunity matrix"
      subtitle="Each bubble is an HS6 product: competitiveness (RCA) against world demand growth; bubble area shows the world market (US$)."
      actions={
        <>
          <SegmentedControl
            value={scale}
            onChange={setScale}
            ariaLabel="RCA axis scale"
            options={[
              { value: 'log', label: 'Log scale' },
              { value: 'capped', label: `Linear, capped at ${RCA_CAP}` },
            ]}
          />
          <ModelEstimateTag method="Archetype rules and RCA (SPEC section 4)" />
        </>
      }
      footer={
        <span>
          {fmtNum(plotted)} products plotted
          {excluded ? ` · ${fmtNum(excluded)} not plotted (no exports in the latest year, so RCA cannot be placed on the axis, or growth not available)` : ''}. Click a bubble to open the product.
        </span>
      }
    >
      {plotted ? (
        <EChart
          option={option}
          height={460}
          ariaLabel="Opportunity matrix: RCA against world demand growth, bubbles sized by world market"
          onEvents={{
            click: (p: { name?: string }) => {
              if (!p.name) return;
              const it = bySix.get(p.name);
              const to = it?.hsn8_sample ? routes.product(it.hsn8_sample) : routeForCode(p.name);
              if (to) navigate(to);
            },
          }}
        />
      ) : (
        <div className="py-10 text-center text-sm text-muted">No products in this selection have both an RCA and a world growth rate to plot.</div>
      )}
    </Card>
  );
}

export function ExportPotentialTab({ filters }: { filters: AnalyticsFilters }) {
  const q = useOpportunities({ ...filters, limit: 300 });
  // The archetype summary counts every product in the selection (the list above holds the top 300).
  const arch = useArchetypes(filters);
  const championsAll = arch.data?.archetypes.find((a) => a.name === 'Champion')?.n ?? null;
  const trade = useTradeProvenance();

  return (
    <QueryState
      query={q}
      isEmpty={(d) => d.items.length === 0}
      emptyTitle="No products match these filters"
      emptyMessage="Clear a filter to widen the selection."
    >
      {(d) => (
        <div className="space-y-6">
          <ScoresPendingNote response={d} what="Export potential scores and archetypes" />
          <ExportPotentialBody items={d.items} matrix={d.matrix} totalUntapped={d.summary.total_untapped_usd} nProducts={d.summary.n_products} championsAll={championsAll} trade={trade} />
        </div>
      )}
    </QueryState>
  );
}

function ExportPotentialBody({
  items,
  matrix,
  totalUntapped,
  nProducts,
  championsAll,
  trade,
}: {
  items: OpportunityItem[];
  matrix: OpportunityMatrixPoint[];
  totalUntapped: number | null;
  nProducts: number;
  /** Champions across the whole selection (archetype summary); null while it loads or fails. */
  championsAll: number | null;
  trade: ReturnType<typeof useTradeProvenance>;
}) {
  // Highest score first; India's exports break ties (and order the list while scores are not built).
  const ranked = useMemo(
    () => [...items].sort((a, b) => (b.export_potential_score ?? -1) - (a.export_potential_score ?? -1) || (b.india_exports ?? -1) - (a.india_exports ?? -1)),
    [items],
  );
  const rank = useMemo(() => new Map(ranked.map((r, i) => [r.hs6, i + 1])), [ranked]);
  const champions = items.filter((i) => i.archetype === 'Champion').length;
  const top = ranked[0];

  const columns: Column<OpportunityItem>[] = [
    { key: 'rank', header: '#', align: 'right', width: 44, value: (r) => rank.get(r.hs6) ?? null, firstSort: 'asc' },
    { key: 'hs6', header: 'HS6', value: (r) => r.hs6, render: (r) => <Hs6Code hs6={r.hs6} hsn8={r.hsn8_sample} />, width: 96 },
    { key: 'product', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} />, width: '24%' },
    { key: 'ministry', header: 'Ministry', value: (r) => r.ministry_short, render: (r) => <ItemMinistry id={r.ministry_id} short={r.ministry_short} />, hideBelow: 'lg' },
    { key: 'archetype', header: 'Archetype', value: (r) => r.archetype, render: (r) => <ArchetypeBadge archetype={r.archetype} /> },
    { key: 'exports', header: 'India exports', align: 'right', value: (r) => r.india_exports, render: (r) => usd(r.india_exports) },
    { key: 'world', header: 'World market', align: 'right', value: (r) => r.world_trade, render: (r) => usd(r.world_trade), hideBelow: 'md' },
    { key: 'share', header: 'India share', align: 'right', value: (r) => r.india_world_share, render: (r) => pct(r.india_world_share), hideBelow: 'xl' },
    { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => ratio(r.rca), hint: 'Balassa revealed comparative advantage; above 1 means India is relatively specialised in the product.' },
    { key: 'wcagr', header: 'World CAGR', align: 'right', value: (r) => r.world_cagr, render: (r) => pct(r.world_cagr, true), hint: 'World import demand growth, CAGR 2018–24', hideBelow: 'lg' },
    { key: 'xcagr', header: 'Export CAGR', align: 'right', value: (r) => r.export_cagr, render: (r) => pct(r.export_cagr, true), hint: "India's export growth, CAGR 2018–24", hideBelow: 'lg' },
    {
      key: 'score',
      header: 'Export potential',
      value: (r) => r.export_potential_score,
      render: (r) => <ScoreBar value={r.export_potential_score} width={72} />,
      hint: '0–100 model score: 35% world market size, 30% RCA (capped at 3), 20% world growth, 15% India export growth.',
      firstSort: 'desc',
      width: 140,
    },
    {
      key: 'untapped',
      header: 'Untapped potential',
      align: 'right',
      value: (r) => r.untapped_potential_usd,
      render: (r) => usd(r.untapped_potential_usd),
      hint: "Extra exports if India reached its chapter-average world share in this product (only where RCA >= 0.3). Model estimate.",
    },
  ];

  return (
    <div className="space-y-6">
      <StatGrid cols={4}>
        <KpiTile
          label="Products analysed"
          value={fmtNum(nProducts || items.length)}
          icon={Layers}
          accent="ink"
          sub={nProducts > items.length ? `HS6 products in this selection; top ${fmtNum(items.length)} listed` : 'HS6 products in this selection'}
          provenance={trade}
        />
        <KpiTile
          label="Total untapped export potential"
          value={totalUntapped === null ? null : fmtUSD(totalUntapped)}
          icon={Coins}
          sub="Gap to chapter-average world share"
          provenance={MODEL_PROVENANCE}
          hint="Sum over every product in this selection of max(0, b·W − X), where b is India's chapter-average world share (only where RCA ≥ 0.3). Model estimate."
        />
        <KpiTile
          label="Champion products"
          value={fmtNum(championsAll ?? champions)}
          icon={Award}
          accent="brand"
          sub={championsAll !== null ? `RCA ≥ 1 and outgrowing world demand; ${fmtNum(champions)} in the top ${fmtNum(items.length)}` : `RCA ≥ 1 and outgrowing world demand (top ${fmtNum(items.length)})`}
          provenance={MODEL_PROVENANCE}
        />
        <KpiTile
          label="Top-ranked opportunity"
          value={top ? `HS ${fmtCode(top.hs6)}` : null}
          icon={Crosshair}
          accent="brand"
          sub={top ? truncate(top.description, 52) : undefined}
          to={top?.hsn8_sample ? routes.product(top.hsn8_sample) : undefined}
          provenance={MODEL_PROVENANCE}
        />
      </StatGrid>

      <OpportunityMatrix items={items} matrix={matrix} />

      <Card
        title="Ranked export opportunities"
        subtitle="Sorted by the export potential score; untapped potential estimates the additional exports at India's chapter-average world share."
        actions={<ModelEstimateTag method="Export potential score and untapped potential (SPEC section 4)" />}
        footer={<SourceNote provenances={[trade, MODEL_PROVENANCE]} />}
      >
        <DataTable
          columns={columns}
          rows={ranked}
          rowKey={(r) => r.hs6}
          defaultSort={{ key: 'rank', order: 'asc' }}
          csvFilename="atlas-export-opportunities"
          dense
          pagination={{ mode: 'client', pageSize: 25 }}
        />
      </Card>

      <MethodNote method="Export potential score, archetypes and untapped potential">
        The <b>export potential score</b> (0–100) combines world market size (35%), India's revealed comparative advantage capped
        at 3 (30%), world demand growth (20%) and India's own export growth (15%), each as a percentile across all HS6 products.
        <b> Archetypes</b> are rules: <i>Champion</i> (RCA ≥ 1 and exports outgrowing world demand), <i>Established</i> (RCA ≥ 1),
        <i> Emerging</i> (0.3 ≤ RCA &lt; 1, outgrowing world demand), <i>Dependent</i> (imports at least twice exports and ≥ $50 mn) and
        <i> Marginal</i>. These are screening signals for officials, not forecasts of what India will export.
      </MethodNote>
    </div>
  );
}
