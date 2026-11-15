/**
 * EntityDashboard - the body shared by the ministry dashboard (/ministry/:id) and the sector dashboard
 * (/sector/:id): HSN codes, trade performance, domestic production and value-chain linkages. Both
 * endpoints return the same shape (SPEC 6.4) except the mix: ministries get a sector mix, sectors a
 * ministry mix - the caller passes the mix rows.
 *
 * Sections (top to bottom): KPI tiles (codes, exports, imports, balance, world market, coverage,
 * helpdesk / residual counters) -> trade trend + value chains + schemes -> domestic production
 * ("Not available" until figures exist, see ProductionCard) -> mix + chapter mix ->
 * top exports / imports -> import-dependency hotspots / export opportunities (model scores) -> the full
 * product table. Every number carries a provenance badge; every score a "Model estimate" tag.
 *
 * When the analytics build has not scored the products, the API ranks hotspots / opportunities by a
 * transparent fallback and says so (`ranking: "fallback"`, see pages/ministries/api.ts DashboardExtras);
 * the score cards then drop the score columns, show the measures the ranking used and state the basis.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowDownToLine, ArrowUpFromLine, Award, ChartColumn, ChartLine, ChevronRight, Hash, Layers, Network, Scale, ShieldAlert, Sparkles, Workflow } from 'lucide-react';
import type {
  DependencyHotspot,
  EntityDashboardBase,
  EntityKpis,
  EntityValueChain,
  OpportunityProduct,
  ProductSummary,
  Provenance,
  SchemeRef,
  TradeSeriesPoint,
} from '@/api/types';
import { ArchetypeBadge, Badge, Card, CodeLink, DataTable, EChart, EmptyState, KpiTile, ModelEstimateTag, ProvenanceBadge, ScoreBar, SegmentedControl, StatGrid, Tabs, type Column } from '@/components';
import { fmtNum, fmtPct, fmtRatio, fmtUSD, NA_SHORT, plural } from '@/lib/format';
import { routes } from '@/lib/routes';
import { BCD_COLUMN_HINT, BcdCell, bcdText } from '@/pages/explore/shared';
import { useTheme } from '@/theme/ThemeContext';
import { useCountryName, type ChainExtras, type DashboardExtras, type EntityKind, type HotspotExtras, type KpiExtras, type OpportunityExtras } from '../api';
import { barChartHeight, chapterLabel, foldRows, rankedBarOption, tradeTrendOption, type BarRow } from '../charts';
import { diff, ratio, spanLabel, yoyFromTrend } from '../utils';
import { EntityProductsTable } from './EntityProductsTable';
import { LabelledProvenance } from './LabelledProvenance';
import { ProductionCard } from './ProductionCard';

const NA = { na: NA_SHORT };

// ============================================================================ KPI grid

export interface EntityKpiGridProps {
  kind: EntityKind;
  kpis: EntityKpis;
  trend: ReadonlyArray<TradeSeriesPoint>;
  trade: Provenance;
  mapping: Provenance;
  /** Ministry dashboards: true for the residual bucket (changes the first tile's wording). */
  residual?: boolean;
  /** Sector dashboards: number of ministries that own codes in the sector. */
  ministriesInvolved?: number;
}

export function EntityKpiGrid({ kind, kpis, trend, trade, mapping, residual }: EntityKpiGridProps) {
  const year = trade.year ?? yoyFromTrend(trend, 'exports').year;
  const xYoy = yoyFromTrend(trend, 'exports');
  const mYoy = yoyFromTrend(trend, 'imports');
  const balance = kpis.trade_balance ?? diff(kpis.exports, kpis.imports);
  const share = ratio(kpis.exports, kpis.world_trade);
  const yr = year ? ` ${year}` : '';
  const verified = (kpis as EntityKpis & KpiExtras).verified_codes;
  const verifiedText = typeof verified === 'number' && verified > 0 ? ` · ${fmtNum(verified)} verified` : '';
  const codesLabel = kind === 'sector' ? 'HS codes in sector' : residual ? 'Residual (unassigned) codes' : 'HS codes owned';
  const codesSub =
    kind === 'sector'
      ? `${fmtNum(kpis.accepted)} accepted · ${fmtNum(Math.max(0, kpis.codes - kpis.accepted))} residual${verifiedText}`
      : residual
        ? 'Awaiting a ministry claim'
        : `${fmtNum(kpis.accepted)} accepted${verifiedText}${kpis.secondary_codes ? ` · +${fmtNum(kpis.secondary_codes)} shared` : ''}`;

  return (
    <StatGrid cols={4}>
      <KpiTile
        label={codesLabel}
        value={fmtNum(kpis.codes)}
        icon={Hash}
        sub={codesSub}
        provenance={mapping}
        hint="8-digit national tariff lines (GST HSN master) assigned to this owner by the official DPIIT Guidebook (16.12.2025 revision). Verified = Guidebook, official upload or approved manual review. Shared = lines where this ministry is a secondary owner."
      />
      <KpiTile
        label={`India exports${yr}`}
        value={kpis.exports === null ? null : fmtUSD(kpis.exports)}
        icon={ArrowUpFromLine}
        accent="kpi"
        delta={xYoy.yoy !== null ? { value: xYoy.yoy, label: xYoy.prevYear ? `vs ${xYoy.prevYear}` : 'YoY' } : undefined}
        sub={share !== null ? `${fmtPct(share)} of a ${fmtUSD(kpis.world_trade)} world market` : undefined}
        provenance={trade}
        hint="Sum over the owner's lines of HS6 exports apportioned by 1 / lines in the subheading (no double counting). World market = all countries' exports of the same products."
      />
      <KpiTile
        label={`India imports${yr}`}
        value={kpis.imports === null ? null : fmtUSD(kpis.imports)}
        icon={ArrowDownToLine}
        accent="kpi"
        delta={mYoy.yoy !== null ? { value: mYoy.yoy, label: mYoy.prevYear ? `vs ${mYoy.prevYear}` : 'YoY', upIsGood: false } : undefined}
        provenance={trade}
      />
      <KpiTile
        label="Trade balance"
        value={balance === null ? null : fmtUSD(balance, { signed: true })}
        icon={Scale}
        accent={balance === null ? 'ink' : balance >= 0 ? 'ok' : 'bad'}
        sub={balance === null ? undefined : balance >= 0 ? 'Net exporter' : 'Net importer'}
        provenance={trade}
      />
    </StatGrid>
  );
}

/**
 * Small action strip under the KPIs: only what needs attention (open helpdesk queries, pending residual
 * claims) and the structure counts, as one line of chips instead of four mostly-zero tiles.
 */
export function EntityActionStrip({ kind, kpis, ministriesInvolved }: { kind: EntityKind; kpis: EntityKpis; ministriesInvolved?: number }) {
  const chip = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`${chip} border-line bg-surface text-ink-2`}>
        <Layers className="size-3.5 text-muted" aria-hidden />
        {kind === 'sector'
          ? `${typeof ministriesInvolved === 'number' ? plural(ministriesInvolved, 'ministry', 'ministries') : 'Ministries'} involved`
          : plural(kpis.sectors_covered, 'sector')}
        {' · '}{plural(kpis.chains_involved, 'value chain')}
      </span>
    </div>
  );
}

// ============================================================================ trade trend

/** Minimum height of the trend chart; it grows to fill its card when the grid row is taller. */
const TREND_MIN_HEIGHT = 300;

/**
 * Height of an element, tracked with a ResizeObserver. The measured box must not size itself from the
 * content that uses the value (here the chart is absolutely positioned inside it), or it would never
 * shrink back. `active` re-attaches the observer when the measured element mounts.
 */
function useBoxHeight<T extends HTMLElement>(active: boolean): [RefObject<T | null>, number | null] {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.contentRect.height ?? 0);
      setHeight((prev) => (prev === h ? prev : h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return [ref, height];
}

export function TradeTrendCard({ trend, trade, subject, className }: { trend: ReadonlyArray<TradeSeriesPoint>; trade: Provenance; subject: string; className?: string }) {
  const { mode } = useTheme();
  const option = useMemo(() => tradeTrendOption(trend, mode), [trend, mode]);
  const hasData = trend.some((t) => typeof t.exports === 'number' || typeof t.imports === 'number');
  const span = spanLabel(trend);
  // The card sits next to the value-chain and scheme cards; the chart takes whatever height the row
  // gives it (never less than TREND_MIN_HEIGHT) instead of leaving an empty band under the plot.
  const [boxRef, boxHeight] = useBoxHeight<HTMLDivElement>(hasData);
  const chartHeight = Math.max(TREND_MIN_HEIGHT, boxHeight ?? TREND_MIN_HEIGHT);
  return (
    <Card
      className={className}
      bodyClassName={hasData ? 'flex flex-col' : undefined}
      icon={ChartLine}
      title={`Trade trend${span ? `, ${span}` : ''}`}
      subtitle={`India's exports and imports of ${subject}, US$ per year`}
      actions={<ProvenanceBadge provenance={trade} size="xs" />}
      footer="India's official HS6 trade (DGCIS TRADESTAT, financial years; 2024 = FY2024-25) apportioned to the owner's 8-digit lines."
    >
      {hasData ? (
        <div ref={boxRef} className="relative min-h-[300px] flex-1">
          <div className="absolute inset-0">
            <EChart option={option} height={chartHeight} ariaLabel={`Line chart of India's exports and imports of ${subject}${span ? `, ${span}` : ''}`} />
          </div>
        </div>
      ) : (
        <EmptyState compact icon={ChartLine} title="No trade series available" message="None of these products has recorded trade in 2018–2024." />
      )}
    </Card>
  );
}

// ============================================================================ mix bars

export interface MixRow {
  id: string;
  label: string;
  codes: number;
  exports: number | null;
  imports: number | null;
  muted?: boolean;
}

type MixMetric = 'codes' | 'exports' | 'imports';

export interface MixCardProps {
  title: string;
  subtitle: string;
  rows: MixRow[];
  trade: Provenance;
  mapping: Provenance;
  /** Navigate on bar click (rows folded into "All other" are not clickable). */
  onSelect?: (row: MixRow) => void;
  /** Visible bars in "Top" mode. */
  limit?: number;
  emptyText: string;
  /** Footer hint describing what a bar click does. */
  clickHint?: string;
  icon?: typeof ChartColumn;
  className?: string;
}

export function MixCard({
  title,
  subtitle,
  rows,
  trade,
  mapping,
  onSelect,
  limit = 10,
  emptyText,
  clickHint = 'Click a bar to open its dashboard.',
  icon = ChartColumn,
  className,
}: MixCardProps) {
  const { mode } = useTheme();
  const [metric, setMetric] = useState<MixMetric>('codes');
  const [scope, setScope] = useState<'top' | 'all'>('top');

  const sorted = useMemo(() => {
    const val = (r: MixRow) => (metric === 'codes' ? r.codes : (r[metric] ?? 0));
    return [...rows].sort((a, b) => val(b) - val(a));
  }, [rows, metric]);

  const bars = useMemo<BarRow[]>(() => {
    const all = sorted.map((r) => ({ id: r.id, label: r.label, value: metric === 'codes' ? r.codes : r[metric], muted: r.muted }));
    return scope === 'top' ? foldRows(all, limit) : all;
  }, [sorted, metric, scope, limit]);

  const option = useMemo(() => {
    const format = metric === 'codes' ? (v: number) => fmtNum(v) : (v: number) => fmtUSD(v, { sig: 2 });
    const seriesName = metric === 'codes' ? 'HS codes' : metric === 'exports' ? 'India exports' : 'India imports';
    return rankedBarOption({ rows: bars, mode, format, seriesName });
  }, [bars, mode, metric]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  return (
    <Card
      className={className}
      icon={icon}
      title={title}
      subtitle={subtitle}
      actions={
        <>
          {rows.length > 1 ? (
            <SegmentedControl
              ariaLabel="Measure"
              size="xs"
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'codes', label: 'Codes' },
                { value: 'exports', label: 'Exports' },
                { value: 'imports', label: 'Imports' },
              ]}
            />
          ) : null}
          {rows.length > limit ? (
            <SegmentedControl
              ariaLabel="Rows shown"
              size="xs"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'top', label: `Top ${limit}` },
                { value: 'all', label: `All ${rows.length}` },
              ]}
            />
          ) : null}
        </>
      }
      footer={
        <span className="flex flex-wrap items-center gap-2">
          {metric === 'codes' ? <LabelledProvenance label="Ministry mapping" provenance={mapping} /> : <LabelledProvenance label="Trade" provenance={trade} />}
          <span>
            {metric === 'codes' ? 'Number of 8-digit lines.' : 'US$, latest year, apportioned by line.'}
            {onSelect && rows.length > 1 ? ` ${clickHint}` : ''}
          </span>
        </span>
      }
    >
      {rows.length === 1 ? (
        <SingleMix row={rows[0]} />
      ) : rows.length ? (
        <EChart
          option={option}
          height={barChartHeight(bars.length)}
          ariaLabel={`${title}: bar chart by ${metric}`}
          onEvents={
            onSelect
              ? {
                  click: (p: { dataIndex?: number }) => {
                    const bar = typeof p.dataIndex === 'number' ? bars[p.dataIndex] : undefined;
                    const row = bar ? byId.get(bar.id) : undefined;
                    if (row) onSelect(row);
                  },
                }
              : undefined
          }
        />
      ) : (
        <EmptyState compact title={emptyText} />
      )}
    </Card>
  );
}

/** A one-bar chart is an anti-pattern: a single group is stated as numbers instead. */
function SingleMix({ row }: { row: MixRow }) {
  return (
    <div className="rounded-lg bg-surface-2 p-4">
      <div className="text-xs text-muted">All products fall in one group</div>
      <div className="mt-0.5 text-[15px] font-semibold text-ink">{row.label}</div>
      <dl className="mt-3 grid grid-cols-3 gap-3 text-xs">
        <div>
          <dt className="text-muted">HS codes</dt>
          <dd className="text-[17px] font-bold text-kpi">{fmtNum(row.codes)}</dd>
        </div>
        <div>
          <dt className="text-muted">Exports</dt>
          <dd className="text-[17px] font-bold text-kpi">{fmtUSD(row.exports)}</dd>
        </div>
        <div>
          <dt className="text-muted">Imports</dt>
          <dd className="text-[17px] font-bold text-kpi">{fmtUSD(row.imports)}</dd>
        </div>
      </dl>
    </div>
  );
}

// ============================================================================ top products

export function TopProductsCard({ flow, rows, trade, className }: { flow: 'exports' | 'imports'; rows: ProductSummary[]; trade: Provenance; className?: string }) {
  const columns = useMemo<Column<ProductSummary>[]>(
    () => [
      { key: 'hsn8', header: 'HS code', width: 112, value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} /> },
      {
        key: 'description',
        header: 'Product',
        value: (r) => r.description,
        render: (r) => (
          <span className="line-clamp-2" title={r.full_description ?? r.description}>
            {r.description}
          </span>
        ),
      },
      {
        key: flow,
        header: flow === 'exports' ? 'Exports' : 'Imports',
        align: 'right',
        value: (r) => r[flow],
        render: (r) => <span className="font-medium">{fmtUSD(r[flow], NA)}</span>,
      },
      flow === 'exports'
        ? { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => fmtRatio(r.rca, NA), hint: 'Balassa revealed comparative advantage' }
        : {
            key: 'tariff',
            header: 'BCD',
            align: 'right',
            value: (r) => bcdText(r),
            render: (r) => <BcdCell row={r} />,
            hint: BCD_COLUMN_HINT,
          },
    ],
    [flow],
  );
  return (
    <Card
      className={className}
      padding="sm"
      icon={flow === 'exports' ? ArrowUpFromLine : ArrowDownToLine}
      title={flow === 'exports' ? 'Top export products' : 'Top import products'}
      subtitle={`Ten largest lines by India's ${flow}, US$`}
      actions={<ProvenanceBadge provenance={trade} size="xs" />}
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.hsn8}
        pagination={false}
        maxHeight={null}
        dense
        emptyTitle={`No ${flow} recorded`}
        caption={flow === 'exports' ? 'Top export products' : 'Top import products'}
        footer="HS6-level values: lines in the same subheading show the subheading's trade."
      />
    </Card>
  );
}

// ============================================================================ scores

type HotspotRow = DependencyHotspot & HotspotExtras;
type OpportunityRow = OpportunityProduct & OpportunityExtras;

const VULNERABILITY_METHOD = 'Vulnerability = 30% dependency ratio + 25% import HHI + 20% China share + 25% import size percentile';
const POTENTIAL_METHOD = 'Export potential = 35% world market percentile + 30% RCA (capped at 3) + 20% world CAGR + 15% India export CAGR';

/** Chip shown instead of the model tag when the API ranked rows by its transparent fallback. */
function FallbackTag({ text }: { text: string }) {
  return (
    <Badge tone="outline" size="xs" title={text}>
      Ranked without model scores
    </Badge>
  );
}

/** Product cell shared by the score tables. */
function productCell(r: ProductSummary) {
  return (
    <span className="line-clamp-2 min-w-[12rem]" title={r.full_description ?? r.description}>
      {r.description}
    </span>
  );
}

export interface ScoreCardProps<T> {
  rows: T[];
  /** false when the API had no model scores and used its transparent fallback ranking. */
  scored: boolean;
  className?: string;
}

export function HotspotsCard({ rows, scored, className }: ScoreCardProps<HotspotRow>) {
  const countryName = useCountryName();
  const sourceName = (r: HotspotRow) => r.top_import_source_name ?? countryName(r.top_import_source);
  const fallbackText = 'Model scores are not available for these products, so they are ranked by imports × import dependence × top-source share.';
  const columns: Column<HotspotRow>[] = [
    { key: 'hsn8', header: 'HS code', width: 112, value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} /> },
    { key: 'description', header: 'Product', value: (r) => r.description, render: productCell },
  ];
  if (scored) {
    columns.push({
      key: 'vulnerability_score',
      header: 'Vulnerability',
      width: 140,
      value: (r) => r.vulnerability_score,
      hint: '0–100: dependency ratio, source concentration (HHI), China share and import size. Higher = more exposed.',
      render: (r) => <ScoreBar value={r.vulnerability_score} scale="risk" />,
    });
  }
  columns.push(
    {
      key: 'dependency',
      header: 'Import dependence',
      align: 'right',
      hideBelow: scored ? 'xl' : undefined,
      hint: 'Imports ÷ (imports + exports) of the subheading: 100% means India exports none of it',
      value: (r) => r.dependency_ratio ?? null,
      render: (r) => fmtPct(r.dependency_ratio ?? null, { digits: 0, na: NA_SHORT }),
    },
    {
      key: 'source',
      header: 'Top source',
      hideBelow: 'md',
      value: (r) => sourceName(r),
      render: (r) =>
        r.top_import_source ? (
          <span className="whitespace-nowrap">
            {sourceName(r)}
            {typeof r.top_import_source_share === 'number' ? <span className="ml-1 text-xs text-muted">{fmtPct(r.top_import_source_share, { digits: 0 })}</span> : null}
          </span>
        ) : (
          <span className="text-muted">{NA_SHORT}</span>
        ),
    },
    { key: 'imports', header: 'Imports', align: 'right', value: (r) => r.imports, render: (r) => fmtUSD(r.imports, NA) },
  );
  return (
    <Card
      className={className}
      padding="sm"
      icon={ShieldAlert}
      title="Import-dependency hotspots"
      subtitle={scored ? 'Products where India relies most on imports and on few suppliers' : 'Net-import products ranked by imports, import dependence and supplier concentration'}
      actions={scored ? <ModelEstimateTag method={VULNERABILITY_METHOD} /> : <FallbackTag text={fallbackText} />}
      footer={scored ? undefined : fallbackText}
    >
      {rows.length ? (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.hsn8}
          pagination={false}
          maxHeight={null}
          dense
          defaultSort={scored ? { key: 'vulnerability_score', order: 'desc' } : undefined}
          caption="Import-dependency hotspots"
        />
      ) : (
        <EmptyState
          compact
          icon={ShieldAlert}
          title={scored ? 'No vulnerability scores for these products' : 'No import-dependent products'}
          message={scored ? 'Scores appear when the analytics build has scored the products’ subheadings.' : 'None of these products is a net import with recorded trade.'}
        />
      )}
    </Card>
  );
}

export function OpportunitiesCard({ rows, scored, className }: ScoreCardProps<OpportunityRow>) {
  const fallbackText = 'Model scores are not available for these products, so the list shows products with RCA ≥ 1 ranked by world market × RCA (capped at 3).';
  const columns: Column<OpportunityRow>[] = [
    { key: 'hsn8', header: 'HS code', width: 112, value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} /> },
    { key: 'description', header: 'Product', value: (r) => r.description, render: productCell },
  ];
  if (scored) {
    columns.push(
      {
        key: 'export_potential_score',
        header: 'Export potential',
        width: 140,
        value: (r) => r.export_potential_score,
        hint: '0–100: world market size, RCA, world growth and India export growth.',
        render: (r) => <ScoreBar value={r.export_potential_score} />,
      },
      {
        key: 'untapped',
        header: 'Untapped',
        align: 'right',
        value: (r) => r.untapped_potential_usd,
        hint: 'Extra exports if India reached its chapter-average world share in this product (US$)',
        render: (r) => fmtUSD(r.untapped_potential_usd, NA),
      },
      { key: 'archetype', header: 'Archetype', hideBelow: 'md', value: (r) => r.archetype, render: (r) => <ArchetypeBadge archetype={r.archetype} /> },
    );
  } else {
    columns.push(
      { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, hint: 'Balassa revealed comparative advantage', render: (r) => fmtRatio(r.rca, NA) },
      { key: 'world_trade', header: 'World market', align: 'right', value: (r) => r.world_trade, render: (r) => fmtUSD(r.world_trade, NA) },
      {
        key: 'share',
        header: 'India share',
        align: 'right',
        hideBelow: 'md',
        hint: "India's exports ÷ world exports of the subheading",
        value: (r) => r.india_world_share ?? ratio(r.exports, r.world_trade),
        render: (r) => fmtPct(r.india_world_share ?? ratio(r.exports, r.world_trade), NA),
      },
    );
  }
  return (
    <Card
      className={className}
      padding="sm"
      icon={Sparkles}
      title="Export opportunities"
      subtitle={scored ? 'Products with the highest export-potential score' : 'Competitive products (RCA ≥ 1) with the largest world markets'}
      actions={scored ? <ModelEstimateTag method={POTENTIAL_METHOD} /> : <FallbackTag text={fallbackText} />}
      footer={scored ? undefined : fallbackText}
    >
      {rows.length ? (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.hsn8}
          pagination={false}
          maxHeight={null}
          dense
          defaultSort={scored ? { key: 'export_potential_score', order: 'desc' } : undefined}
          caption="Export opportunities"
        />
      ) : (
        <EmptyState
          compact
          icon={Sparkles}
          title={scored ? 'No export-potential scores for these products' : 'No product with revealed comparative advantage'}
          message={scored ? 'Scores appear when the analytics build has scored the products’ subheadings.' : 'None of these products has an RCA of 1 or more.'}
        />
      )}
    </Card>
  );
}

// ============================================================================ chains & schemes

export function LinkedChainsCard({ chains, className }: { chains: Array<EntityValueChain & ChainExtras>; className?: string }) {
  return (
    <Card className={className} icon={Workflow} title="Value chains involved" subtitle="Value chains where these products appear">
      {chains.length ? (
        <ul className="-my-1 divide-y divide-line">
          {chains.map((c) => (
            <li key={c.chain_id} className="py-2.5">
              <div className="flex items-center gap-2">
                <Link to={routes.valueChain(c.chain_id)} className="min-w-0 truncate text-[13.5px] font-semibold text-brand-ink hover:underline">
                  {c.name}
                </Link>
                {c.is_lead ? (
                  <Badge tone="brand" size="xs" title="This ministry is the chain's lead ministry">
                    Lead
                  </Badge>
                ) : null}
                <span className="flex-1" aria-hidden />
                <Link
                  to={routes.network({ chain: c.chain_id })}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-brand-ink"
                  title={`Open ${c.name} in the network view`}
                >
                  <Network className="size-3.5" aria-hidden />
                  Network
                </Link>
              </div>
              {c.stages.length ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {c.stages.map((s, i) => (
                    <span key={`${s}-${i}`} className="inline-flex items-center gap-1">
                      {i > 0 ? <ChevronRight className="size-3 text-muted" aria-hidden /> : null}
                      <Badge tone="outline" size="xs">
                        {s}
                      </Badge>
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={Workflow} title="Not part of a value chain" message="None of these products is mapped in the value chains yet." />
      )}
    </Card>
  );
}

export function SchemesCard({ schemes, className }: { schemes: SchemeRef[]; className?: string }) {
  return (
    <Card className={className} icon={Award} title="Schemes covering these products" subtitle="PLI schemes and Quality Control Orders matched by HS prefix">
      {schemes.length ? (
        <ul className="-my-1 divide-y divide-line">
          {schemes.map((s) => (
            <li key={s.id} className="flex items-center gap-2 py-2">
              <Badge tone={s.kind === 'PLI' ? 'brand' : s.kind === 'QCO' ? 'info' : 'neutral'} size="xs">
                {s.kind}
              </Badge>
              <Link to={routes.policy()} className="min-w-0 flex-1 truncate text-[13px] text-ink hover:text-brand-ink hover:underline" title={s.name}>
                {s.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={Award} title="No PLI scheme or QCO matched" message="No scheme in the policy register lists these products' HS prefixes." />
      )}
    </Card>
  );
}

// ============================================================================ composed body

export interface EntityDashboardBodyProps {
  kind: EntityKind;
  id: string;
  /** e.g. "Ministry of Textiles" (used in titles, captions and file names). */
  name: string;
  /** Phrase for "India's exports and imports of …" */
  subject: string;
  data: EntityDashboardBase;
  mix: { title: string; subtitle: string; rows: MixRow[]; onSelect?: (row: MixRow) => void; emptyText: string };
  trade: Provenance;
  mapping: Provenance;
  residual?: boolean;
  ministriesInvolved?: number;
  /** Extra content rendered after the KPI grid (e.g. a mapping caveat). */
  children?: ReactNode;
}

export function EntityDashboardBody({ kind, id, name, subject, data, mix, trade: tradeFallback, mapping, residual, ministriesInvolved, children }: EntityDashboardBodyProps) {
  const navigate = useNavigate();
  const chapterRows = useMemo<MixRow[]>(
    () => data.chapter_mix.map((c) => ({ id: c.hs2, label: chapterLabel(c.hs2, c.description), codes: c.codes, exports: c.exports, imports: c.imports })),
    [data.chapter_mix],
  );
  const extras = data as EntityDashboardBase & DashboardExtras;
  // The dashboard's own trade provenance wins over the app-wide one from /api/meta/overview.
  const trade = extras.provenance?.trade ?? tradeFallback;
  // "fallback" = no model scores: the API ranked hotspots / opportunities transparently instead. Without
  // the flag, infer it from the rows themselves.
  const hotspotsScored = extras.ranking ? extras.ranking === 'model' : data.dependency_hotspots.some((r) => typeof r.vulnerability_score === 'number');
  const opportunitiesScored = extras.ranking ? extras.ranking === 'model' : data.opportunities.some((r) => typeof r.export_potential_score === 'number');

  // One screen at a time: headline numbers stay on top, the detail lives in four tabs (URL-synced, so
  // a tab can be shared as a link) instead of eleven stacked sections.
  return (
    <div className="space-y-4 sm:space-y-5">
      <EntityKpiGrid kind={kind} kpis={data.kpis} trend={data.trend} trade={trade} mapping={mapping} residual={residual} ministriesInvolved={ministriesInvolved} />
      <EntityActionStrip kind={kind} kpis={data.kpis} ministriesInvolved={ministriesInvolved} />
      {children}

      <Tabs
        urlParam="tab"
        tabs={[
          { id: 'overview', label: 'Overview', icon: ChartColumn },
          { id: 'products', label: 'Products', icon: Hash, badge: fmtNum(data.kpis.codes) },
          { id: 'risks', label: 'Risks & opportunities', icon: Scale },
          { id: 'structure', label: 'Structure', icon: Layers },
        ]}
      >
        {(tab: string) =>
          tab === 'products' ? (
            <div className="space-y-4 sm:space-y-6">
              <div className="grid gap-4 sm:gap-6 xl:grid-cols-2">
                <TopProductsCard flow="exports" rows={data.top_exports} trade={trade} />
                <TopProductsCard flow="imports" rows={data.top_imports} trade={trade} />
              </div>
              <EntityProductsTable kind={kind} id={id} entityName={name} tradeProvenance={trade} mappingProvenance={mapping} />
            </div>
          ) : tab === 'risks' ? (
            <div className="grid gap-4 sm:gap-6 2xl:grid-cols-2">
              <HotspotsCard rows={data.dependency_hotspots} scored={hotspotsScored} />
              <OpportunitiesCard rows={data.opportunities} scored={opportunitiesScored} />
            </div>
          ) : tab === 'structure' ? (
            <div className="space-y-4 sm:space-y-6">
              <div className="grid gap-4 sm:gap-6 xl:grid-cols-2">
                <MixCard title={mix.title} subtitle={mix.subtitle} rows={mix.rows} trade={trade} mapping={mapping} onSelect={mix.onSelect} emptyText={mix.emptyText} icon={Layers} />
                <MixCard
                  title="Chapter mix"
                  subtitle="HS chapters (2-digit) of these products"
                  rows={chapterRows}
                  trade={trade}
                  mapping={mapping}
                  onSelect={(r) => navigate(routes.explore({ q: r.id }))}
                  clickHint="Click a bar to explore the chapter's codes."
                  emptyText="No chapters to show"
                  icon={ChartColumn}
                />
              </div>
              <ProductionCard kind={kind} rows={data.production} provenance={data.provenance?.production} chains={data.value_chains} />
            </div>
          ) : (
            <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
              <TradeTrendCard className="xl:col-span-2" trend={data.trend} trade={trade} subject={subject} />
              <div className="grid gap-4 sm:gap-6 md:grid-cols-2 xl:grid-cols-1 xl:content-start">
                <LinkedChainsCard chains={data.value_chains} />
                <SchemesCard schemes={data.schemes} />
              </div>
            </div>
          )
        }
      </Tabs>
    </div>
  );
}
