/**
 * RiskPage - "Supply-chain Risk & Early Warning" (route /risk, GOV_ROLES; SPEC section 8, API 6.8).
 *
 * Early identification of supply-chain vulnerabilities, with automated detection. This page shows:
 * - KPI tiles (high-risk products, imports at risk, China-dependent imports, concentrated products);
 * - the automated alerts feed (severity chips, kind filter) - AlertsFeed.tsx;
 * - average vulnerability by sector and imports at risk by source country (horizontal bars);
 * - the most vulnerable HS6 products, linking to their product pages and to the network trace.
 *
 * Shared ministry / sector / value-chain filters (URL `?ministry=&sector=&chain=`) scope the overview.
 * The route is gated to government roles in app/routes.tsx; the page gates itself as well.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { EChartsOption } from 'echarts';
import { Boxes, Flag, Network as NetworkIcon, ShieldAlert, Ship, Waypoints } from 'lucide-react';
import type { RiskOverviewResponse, VulnerableItem } from '@/api/types';
import { RequireRole } from '@/auth';
import {
  Card,
  DataTable,
  EChart,
  KpiTile,
  ModelEstimateTag,
  PageHeader,
  ProvenanceLegend,
  QueryState,
  ScoreBar,
  SegmentedControl,
  StatGrid,
  type Column,
} from '@/components';
import { fmtNum, fmtPct, fmtScore, fmtUSD, truncate } from '@/lib/format';
import { routes } from '@/lib/routes';
import { BASE_GRID, CATEGORICAL, riskColor } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { escapeHtml, groupedHBarOption, usdTick } from '../analytics/shared/chart';
import { FilterBar, useSharedFilters } from '../analytics/shared/filters';
import { Hs6Code, ItemMinistry, MethodNote, MODEL_PROVENANCE, pct, ProductText, ratio, ScoresPendingNote, SourceNote, usd, useTradeProvenance } from '../analytics/shared/ui';
import { AlertsFeed } from './AlertsFeed';
import { useRiskOverview } from './api';

type SectorMetric = 'vulnerability' | 'imports';

function SectorChart({ rows }: { rows: RiskOverviewResponse['by_sector'] }) {
  const { mode } = useTheme();
  const [metric, setMetric] = useState<SectorMetric>('vulnerability');
  const sorted = useMemo(
    () =>
      [...rows]
        .filter((r) => (metric === 'vulnerability' ? typeof r.avg_vulnerability === 'number' : typeof r.imports_at_risk === 'number'))
        .sort((a, b) => (metric === 'vulnerability' ? (b.avg_vulnerability ?? 0) - (a.avg_vulnerability ?? 0) : (b.imports_at_risk ?? 0) - (a.imports_at_risk ?? 0)))
        .slice(0, 15),
    [rows, metric],
  );
  const option = useMemo<EChartsOption>(() => {
    const vul = metric === 'vulnerability';
    return {
      grid: { ...BASE_GRID, top: 8, right: 56 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (raw: unknown) => {
          const r = (Array.isArray(raw) ? raw[0] : raw) as { dataIndex: number };
          const s = sorted[r.dataIndex];
          if (!s) return '';
          return `<b>${escapeHtml(s.name)}</b><br/>Average vulnerability: <b>${fmtScore(s.avg_vulnerability)}</b> / 100<br/>Imports at risk: <b>${fmtUSD(s.imports_at_risk)}</b>`;
        },
      },
      xAxis: vul ? { type: 'value', min: 0, max: 100 } : { type: 'value', axisLabel: { formatter: (v: number) => usdTick(v) } },
      yAxis: { type: 'category', data: sorted.map((s) => truncate(s.name, 30)), inverse: true, splitLine: { show: false } },
      series: [
        {
          type: 'bar',
          name: vul ? 'Average vulnerability' : 'Imports at risk',
          data: sorted.map((s) =>
            vul ? { value: s.avg_vulnerability, itemStyle: { color: riskColor(s.avg_vulnerability) } } : { value: s.imports_at_risk, itemStyle: { color: CATEGORICAL[mode][1] } },
          ),
          barMaxWidth: 16,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: {
            show: true,
            position: 'right',
            fontSize: 10.5,
            formatter: (p) => (typeof p.value === 'number' ? (vul ? fmtScore(p.value) : fmtUSD(p.value)) : ''),
          },
        },
      ],
    };
  }, [sorted, metric, mode]);

  return (
    <Card
      title={metric === 'vulnerability' ? 'Vulnerability by sector' : 'Imports at risk by sector'}
      subtitle={
        metric === 'vulnerability'
          ? 'Average vulnerability score of each sector’s import-dependent products (0–100; bar colour = risk band)'
          : 'Value of imports in high-risk products, by sector (US$)'
      }
      actions={
        <>
          <SegmentedControl
            value={metric}
            onChange={setMetric}
            ariaLabel="Sector metric"
            options={[
              { value: 'vulnerability', label: 'Vulnerability' },
              { value: 'imports', label: 'Imports at risk' },
            ]}
          />
          <ModelEstimateTag method="Vulnerability score (SPEC section 4)" />
        </>
      }
    >
      {sorted.length ? (
        <EChart option={option} height={Math.max(240, sorted.length * 26 + 30)} ariaLabel="Vulnerability by sector" />
      ) : (
        <div className="py-8 text-center text-sm text-muted">No sector breakdown is available for this selection.</div>
      )}
      {metric === 'vulnerability' && sorted.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-muted" aria-label="Risk bands">
          {[
            ['Low', 10],
            ['Moderate', 30],
            ['Serious', 60],
            ['Critical', 80],
          ].map(([label, v]) => (
            <span key={label} className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-sm" style={{ backgroundColor: riskColor(v as number) }} aria-hidden />
              {label} ({label === 'Low' ? '0–24' : label === 'Moderate' ? '25–49' : label === 'Serious' ? '50–74' : '75–100'})
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function CountryChart({ rows }: { rows: RiskOverviewResponse['by_source_country'] }) {
  const { mode } = useTheme();
  const top = useMemo(() => [...rows].sort((a, b) => (b.imports_at_risk ?? 0) - (a.imports_at_risk ?? 0)).slice(0, 12), [rows]);
  const option = useMemo(
    () =>
      groupedHBarOption({
        categories: top.map((r) => r.country),
        fullLabels: top.map((r) => `${r.country} · ${fmtNum(r.n_products)} high-risk products`),
        series: [{ name: 'Imports at risk', values: top.map((r) => r.imports_at_risk), color: CATEGORICAL[mode][0] }],
      }),
    [top, mode],
  );
  return (
    <Card title="Imports at risk by source country" subtitle="Where India's imports of high-vulnerability products come from (US$, latest year)">
      {top.length ? (
        <EChart option={option} height={Math.max(240, top.length * 28 + 30)} ariaLabel="Imports at risk by source country" />
      ) : (
        <div className="py-8 text-center text-sm text-muted">No source-country breakdown is available for this selection.</div>
      )}
    </Card>
  );
}

function VulnerableTable({ rows, trade }: { rows: VulnerableItem[]; trade: ReturnType<typeof useTradeProvenance> }) {
  const columns: Column<VulnerableItem>[] = [
    { key: 'hs6', header: 'HS6', value: (r) => r.hs6, render: (r) => <Hs6Code hs6={r.hs6} hsn8={r.hsn8_sample} />, width: 96 },
    { key: 'product', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} />, width: '26%' },
    { key: 'ministry', header: 'Ministry', value: (r) => r.ministry_short, render: (r) => <ItemMinistry id={r.ministry_id} short={r.ministry_short} />, hideBelow: 'lg' },
    { key: 'sector', header: 'Sector', value: (r) => r.sector_name, hideBelow: 'xl' },
    { key: 'imports', header: 'India imports', align: 'right', value: (r) => r.india_imports ?? null, render: (r) => usd(r.india_imports ?? null) },
    { key: 'dep', header: 'Dependency', align: 'right', value: (r) => r.dependency_ratio ?? null, render: (r) => pct(r.dependency_ratio ?? null), hideBelow: 'md', hint: 'Imports ÷ (imports + exports)' },
    { key: 'source', header: 'Top source', value: (r) => r.top_import_source_name, render: (r) => r.top_import_source_name ?? <span className="text-muted">—</span> },
    { key: 'china', header: 'China share', align: 'right', value: (r) => r.china_import_share, render: (r) => pct(r.china_import_share) },
    { key: 'hhi', header: 'Source HHI', align: 'right', value: (r) => r.india_import_hhi ?? null, render: (r) => ratio(r.india_import_hhi ?? null), hideBelow: 'xl' },
    {
      key: 'vul',
      header: 'Vulnerability',
      value: (r) => r.vulnerability_score,
      render: (r) => <ScoreBar value={r.vulnerability_score} scale="risk" width={70} />,
      firstSort: 'desc',
      width: 140,
    },
    {
      key: 'actions',
      header: '',
      csv: false,
      render: (r) => (
        <div className="flex items-center justify-end gap-3 text-xs whitespace-nowrap">
          {r.hsn8_sample ? (
            <Link to={routes.product(r.hsn8_sample)} className="text-brand-ink hover:underline">
              Product
            </Link>
          ) : null}
          <Link to={routes.network({ center: r.hsn8_sample ?? r.hs6, depth: 2 })} className="inline-flex items-center gap-1 text-brand-ink hover:underline">
            <NetworkIcon className="size-3.5" aria-hidden />
            Trace
          </Link>
        </div>
      ),
    },
  ];
  return (
    <Card
      title="Most vulnerable products"
      subtitle="HS6 products ranked by the vulnerability score: dependence, source concentration, China share and the size of the import bill"
      actions={<ModelEstimateTag method="Vulnerability score (SPEC section 4)" />}
      footer={<SourceNote provenances={[trade, MODEL_PROVENANCE]} />}
    >
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.hs6} defaultSort={{ key: 'vul', order: 'desc' }} csvFilename="atlas-vulnerable-products" dense />
    </Card>
  );
}

/**
 * Overview as sent by the API: the SPEC KPIs plus totals (`total_imports_usd`, `imports_at_risk_share`,
 * `n_products`, `china_dependent_products`) and the `thresholds` behind each count. All optional.
 */
type RiskOverview = RiskOverviewResponse & {
  kpis: RiskOverviewResponse['kpis'] & {
    total_imports_usd?: number | null;
    imports_at_risk_share?: number | null;
    n_products?: number | null;
    china_dependent_products?: number | null;
  };
  thresholds?: { high_risk_vulnerability?: number; min_imports_usd?: number; china_dependent_share?: number; concentrated_hhi?: number };
};

/** The four headline tiles; the sub-lines quote the thresholds the API applied. */
function RiskKpis({ d, trade }: { d: RiskOverview; trade: ReturnType<typeof useTradeProvenance> }) {
  const k = d.kpis;
  const t = d.thresholds ?? {};
  const highSub =
    typeof t.high_risk_vulnerability === 'number'
      ? `Vulnerability score ${fmtNum(t.high_risk_vulnerability)} or more${typeof k.n_products === 'number' ? `, of ${fmtNum(k.n_products)} imported products` : ''}`
      : 'Flagged by the vulnerability index';
  const atRiskSub =
    typeof k.imports_at_risk_share === 'number' && typeof k.total_imports_usd === 'number'
      ? `${fmtPct(k.imports_at_risk_share)} of India's ${fmtUSD(k.total_imports_usd)} imports`
      : 'Imports of high-risk products';
  const chinaSub =
    typeof k.china_dependent_products === 'number'
      ? `${fmtNum(k.china_dependent_products)} products${typeof t.china_dependent_share === 'number' ? ` with ${fmtPct(t.china_dependent_share, { digits: 0 })}+ of imports from China` : ' where China dominates supply'}`
      : 'Products where China dominates supply';
  const concSub = typeof t.concentrated_hhi === 'number' ? `India's import sources HHI ${fmtNum(t.concentrated_hhi, { digits: 1 })} or more` : 'Few suppliers account for most imports';
  return (
    <StatGrid cols={4}>
      <KpiTile
        label="High-risk products"
        value={fmtNum(k.high_risk_products)}
        icon={ShieldAlert}
        accent="bad"
        sub={highSub}
        provenance={MODEL_PROVENANCE}
        hint="HS6 products whose vulnerability score falls in the high-risk band (model estimate)."
      />
      <KpiTile
        label="Imports at risk"
        value={k.imports_at_risk_usd === null ? null : fmtUSD(k.imports_at_risk_usd)}
        icon={Ship}
        sub={atRiskSub}
        provenance={MODEL_PROVENANCE}
        hint="India's imports (DGCIS TRADESTAT, latest financial year) of the products classed high-risk by the vulnerability score; the classification is a model estimate."
      />
      <KpiTile
        label="China-dependent imports"
        value={k.china_dependent_imports_usd === null ? null : fmtUSD(k.china_dependent_imports_usd)}
        icon={Flag}
        sub={chinaSub}
        provenance={trade}
      />
      <KpiTile
        label="Concentrated products"
        value={fmtNum(k.concentrated_products)}
        icon={Waypoints}
        accent="brand"
        sub={concSub}
        provenance={trade}
        hint="Products whose import sources are highly concentrated (Herfindahl-Hirschman index of India's source countries)."
      />
    </StatGrid>
  );
}

function RiskBody() {
  const shared = useSharedFilters();
  const q = useRiskOverview(shared.filters);
  const trade = useTradeProvenance();

  return (
    <div className="space-y-6">
      <FilterBar api={shared} note="Filters scope the KPIs, charts and product table. The alerts feed always covers all products." />
      <QueryState query={q} emptyTitle="No risk data for this selection">
        {(d) => (
          <div className="space-y-6">
            <ScoresPendingNote response={d} what="Vulnerability scores" />
            <RiskKpis d={d as RiskOverview} trade={trade} />

            <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
              <AlertsFeed fallback={d.alerts} />
              <div className="space-y-6">
                <SectorChart rows={d.by_sector} />
                <CountryChart rows={d.by_source_country} />
              </div>
            </div>

            <VulnerableTable rows={d.top_vulnerable} trade={trade} />

            <MethodNote method="Vulnerability score and alert rules">
              <p>
                The <b>vulnerability score</b> (0–100) = 30% dependency ratio + 25% concentration of India's sources (HHI) + 20% China's share
                of supply + 25% size of the import bill (percentile). <b>Alerts</b> fire when a product crosses a threshold: an import surge, an
                export drop, concentrated sourcing or dependence on China.
              </p>
              <p className="mt-2">
                Use <b>Trace</b> to see which value chains an input feeds and which other critical inputs share the same risk, then test options in
                the{' '}
                <Link to={routes.policy('tariff')} className="atlas-link">
                  tariff simulator
                </Link>
                .
              </p>
            </MethodNote>
          </div>
        )}
      </QueryState>
    </div>
  );
}

export default function RiskPage() {
  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Supply-chain Risk & Early Warning"
        icon={ShieldAlert}
        subtitle="Import-dependence hotspots, concentration on single suppliers and automatic alerts, so ministries can intervene before a disruption reaches the factory floor."
        meta={
          <>
            <ModelEstimateTag method="Vulnerability index and rule-based alerts" />
            <ProvenanceLegend compact />
            <Link to={routes.network()} className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline">
              <Boxes className="size-3.5" aria-hidden />
              Open the value-chain network
            </Link>
          </>
        }
      />
      <RequireRole roles="gov" title="Supply-chain Risk" description="Vulnerability analysis and early-warning alerts are available to analysts, ministry officers and admins.">
        <RiskBody />
      </RequireRole>
    </>
  );
}
