/**
 * "Quality control" tab of the Policy Workbench: Quality Control Orders and the imports they cover.
 *
 * A BIS Quality Control Order (QCO) makes an Indian Standard mandatory for a product: domestic output
 * and imports alike must carry the BIS mark. The policy question is therefore one of import
 * coverage - how much of India's import trade an order touches, from which kinds of products, and
 * whether the covered products are ones India can supply itself. Data:
 * GET /api/policy/schemes?kind=QCO (list), GET /api/policy/schemes/{id} (detail) and
 * GET /api/meta/overview (India's total imports, for the share of imports covered).
 *
 * - KPI strip: orders, imports covered (summed across orders), that sum as a share of India's total
 *   imports, product lines covered;
 * - "Import coverage by order": imports per order (US$) or the import share of each order's trade;
 * - orders table (select a row; `?qco=` in the URL);
 * - order detail: KPIs (lines, imports subject to the standard, import share of trade, exports, average
 *   MFN tariff on the covered subheadings), covered imports by product, a supply-risk check (the most
 *   import-dependent covered products, their main source and China's share) and the product coverage.
 *
 * Coverage is the policy seed's indicative HS prefix list, not the legal schedule of each order; two
 * orders can cover the same line (e.g. pressure cookers and kitchen utensils), so sums across orders are
 * labelled as such. Aggregates within an order use one row per HS6 (SPEC section 4 aggregation rule).
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { EChartsOption } from 'echarts';
import { BadgeCheck, Landmark, Layers, PieChart, ScrollText, ShieldCheck, Ship } from 'lucide-react';
import { api } from '@/api/client';
import { queryKeys } from '@/api/hooks';
import type { DependencyHotspot, ProductSummary, SchemeListItem } from '@/api/types';
import {
  Card,
  CodeLink,
  DataTable,
  EChart,
  EmptyState,
  ErrorState,
  KpiTile,
  LoadingBlock,
  MinistryPill,
  ModelEstimateTag,
  QueryState,
  ScoreBar,
  SegmentedControl,
  StatGrid,
  type Column,
} from '@/components';
import { fmtNum, fmtPct, fmtRate, fmtUSD, NA_SHORT } from '@/lib/format';
import { useSearchParamState } from '@/lib/hooks';
import { BASE_GRID, CATEGORICAL, CHART_TOKENS } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { escapeHtml, usdTick } from '../analytics/shared/chart';
import { MethodNote, MODEL_PROVENANCE, pct, ProductText, ratio, SourceNote, sumOrNull, TARIFF_PROVENANCE, usd, useTradeProvenance } from '../analytics/shared/ui';
import { useScheme, useSchemes } from './api';
import { CoveredTradeChart, distinctHs6, importSourceName, SchemeHeader, shortSchemeName, sourceStatus } from './schemeShared';

type CoverageMetric = 'imports' | 'import_share';

/** Imports as a share of an order's covered trade (imports + exports); null when no trade is recorded. */
function importShare(s: Pick<SchemeListItem, 'imports' | 'exports'>): number | null {
  const m = s.imports ?? null;
  const x = s.exports ?? null;
  if (m === null && x === null) return null;
  const total = (m ?? 0) + (x ?? 0);
  return total > 0 ? (m ?? 0) / total : null;
}

/** India's total imports in the latest year (GET /api/meta/overview, public, shared cache entry). */
function useIndiaImports(): number | null {
  const q = useQuery({ queryKey: queryKeys.overview, queryFn: ({ signal }) => api.overview({ signal }), staleTime: 60 * 60 * 1000 });
  return q.data?.kpis.india_imports ?? null;
}

function CoverageChart({ orders, totalImports }: { orders: SchemeListItem[]; totalImports: number | null }) {
  const { mode } = useTheme();
  const [metric, setMetric] = useState<CoverageMetric>('imports');
  const rows = useMemo(() => {
    const value = (s: SchemeListItem) => (metric === 'imports' ? s.imports : importShare(s));
    return [...orders].filter((s) => typeof value(s) === 'number').sort((a, b) => (value(b) ?? 0) - (value(a) ?? 0));
  }, [orders, metric]);
  const option = useMemo<EChartsOption>(() => {
    const isImports = metric === 'imports';
    const color = CATEGORICAL[mode][1];
    const label = (s: SchemeListItem) => {
      if (!isImports) return fmtPct(importShare(s), { digits: 0 });
      const share = totalImports && s.imports !== null ? s.imports / totalImports : null;
      return share === null ? fmtUSD(s.imports) : `${fmtUSD(s.imports)} · ${fmtPct(share)}`;
    };
    return {
      grid: { ...BASE_GRID, top: 8, right: isImports ? 112 : 48 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (raw: unknown) => {
          const r = (Array.isArray(raw) ? raw[0] : raw) as { dataIndex: number };
          const s = rows[r.dataIndex];
          if (!s) return '';
          const share = totalImports && s.imports !== null ? s.imports / totalImports : null;
          return [
            `<div style="max-width:300px;white-space:normal"><b>${escapeHtml(s.name)}</b></div>`,
            `Imports covered: <b>${fmtUSD(s.imports)}</b>${share === null ? '' : ` (${fmtPct(share)} of India's imports)`}`,
            `Exports covered: <b>${fmtUSD(s.exports)}</b>`,
            `Imported share of covered trade: <b>${fmtPct(importShare(s), { digits: 0 })}</b>`,
            `Lines covered: <b>${fmtNum(s.n_products)}</b>`,
          ].join('<br/>');
        },
      },
      xAxis: isImports
        ? { type: 'value', axisLabel: { formatter: (v: number) => usdTick(v) } }
        : { type: 'value', min: 0, max: 1, axisLabel: { formatter: (v: number) => fmtPct(v, { digits: 0 }) } },
      yAxis: { type: 'category', data: rows.map((s) => shortSchemeName(s.name)), inverse: true, splitLine: { show: false }, axisLabel: { width: 220, overflow: 'truncate' } },
      series: [
        {
          type: 'bar',
          name: isImports ? 'Imports covered' : 'Imported share of covered trade',
          data: rows.map((s) => (isImports ? s.imports : importShare(s))),
          barMaxWidth: 18,
          itemStyle: { color, borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', fontSize: 10.5, formatter: (p) => label(rows[p.dataIndex]) },
          markLine: isImports
            ? undefined
            : {
                silent: true,
                symbol: 'none',
                lineStyle: { color: CHART_TOKENS[mode].ink2, type: 'solid', width: 1 },
                label: { formatter: 'Half imported', position: 'end', fontSize: 10.5 },
                data: [{ xAxis: 0.5 }],
              },
        },
      ],
    };
  }, [rows, metric, mode, totalImports]);

  return (
    <Card
      title="Import coverage by order"
      subtitle={
        metric === 'imports'
          ? "India's imports of the HS lines each order covers (US$, latest year), with the share of India's total imports"
          : 'Imports as a share of each order’s covered trade: above half, the standard bears mainly on imported supply'
      }
      actions={
        <SegmentedControl
          value={metric}
          onChange={setMetric}
          ariaLabel="Coverage metric"
          options={[
            { value: 'imports', label: 'Import value' },
            { value: 'import_share', label: 'Imported share' },
          ]}
        />
      }
    >
      {rows.length ? (
        <EChart option={option} height={Math.max(300, rows.length * 32 + 40)} ariaLabel="Import coverage of each Quality Control Order" />
      ) : (
        <EmptyState compact title="No trade recorded for the covered lines" />
      )}
    </Card>
  );
}

function OrdersTable({ orders, totalImports, selected, onSelect }: { orders: SchemeListItem[]; totalImports: number | null; selected: string | null; onSelect: (id: string) => void }) {
  const columns: Column<SchemeListItem>[] = [
    {
      key: 'name',
      header: 'Order',
      value: (s) => s.name,
      render: (s) => (
        <div className="min-w-56">
          <div className="font-medium text-ink">{shortSchemeName(s.name)}</div>
          <div className="text-[11.5px] text-muted">{s.launched ? `Notified ${s.launched}` : 'Year not recorded'}</div>
        </div>
      ),
    },
    {
      key: 'ministry',
      header: 'Ministry',
      value: (s) => s.ministry?.short_name ?? null,
      render: (s) => (s.ministry ? <MinistryPill size="xs" ministry={s.ministry} link={false} /> : <span className="text-muted">{NA_SHORT}</span>),
      hideBelow: 'lg',
    },
    { key: 'lines', header: 'Lines', align: 'right', value: (s) => s.n_products, render: (s) => fmtNum(s.n_products) },
    { key: 'imports', header: 'Imports covered', align: 'right', value: (s) => s.imports, render: (s) => usd(s.imports), firstSort: 'desc' },
    {
      key: 'share_total',
      header: "Share of India's imports",
      align: 'right',
      value: (s) => (totalImports && s.imports !== null ? s.imports / totalImports : null),
      render: (s) => pct(totalImports && s.imports !== null ? s.imports / totalImports : null),
      hideBelow: 'md',
    },
    { key: 'exports', header: 'Exports covered', align: 'right', value: (s) => s.exports, render: (s) => usd(s.exports), hideBelow: 'md' },
    {
      key: 'import_share',
      header: 'Imported share',
      align: 'right',
      value: (s) => importShare(s),
      render: (s) => pct(importShare(s)),
      hint: 'Imports ÷ (imports + exports) of the covered lines',
      hideBelow: 'lg',
    },
  ];
  return (
    <Card title="Quality Control Orders" subtitle="Select an order to see the imports it covers and the supply-risk check" padding="md">
      <DataTable
        columns={columns}
        rows={orders}
        rowKey={(s) => s.id}
        onRowClick={(s) => onSelect(s.id)}
        isRowSelected={(s) => s.id === selected}
        defaultSort={{ key: 'imports', order: 'desc' }}
        pagination={false}
        maxHeight={null}
        dense
        csvFilename="atlas-quality-control-orders"
      />
    </Card>
  );
}

function OrderDetail({ id, totalImports }: { id: string; totalImports: number | null }) {
  const q = useScheme(id);
  const trade = useTradeProvenance();
  if (q.isPending) return <LoadingBlock label="Loading order…" height={320} />;
  if (q.isError && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (!d) return null;
  const s = d.scheme;
  const status = sourceStatus(s.source);
  const hs6Rows = distinctHs6(d.products);
  const tariffs = hs6Rows.map((r) => r.mfn_tariff).filter((v): v is number => typeof v === 'number');
  const avgTariff = tariffs.length ? tariffs.reduce((a, b) => a + b, 0) / tariffs.length : null;
  const share = importShare({ imports: d.kpis.imports, exports: d.kpis.exports });
  const shareOfIndia = totalImports && d.kpis.imports !== null ? d.kpis.imports / totalImports : null;
  const netImporting = hs6Rows.filter((r) => (r.imports ?? 0) > (r.exports ?? 0)).length;

  const depCols: Column<DependencyHotspot>[] = [
    { key: 'hsn8', header: 'HS code', value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} />, width: 110 },
    { key: 'description', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} /> },
    { key: 'imports', header: 'Imports (HS6)', align: 'right', value: (r) => r.imports, render: (r) => usd(r.imports) },
    {
      key: 'source',
      header: 'Main source',
      value: (r) => importSourceName(r),
      render: (r) => {
        const name = importSourceName(r);
        return name ? `${name} ${pct(r.top_import_source_share)}` : NA_SHORT;
      },
    },
    { key: 'china', header: 'China share', align: 'right', value: (r) => r.china_import_share, render: (r) => pct(r.china_import_share), hideBelow: 'md' },
    {
      key: 'vul',
      header: 'Vulnerability',
      value: (r) => r.vulnerability_score,
      render: (r) => <ScoreBar value={r.vulnerability_score} scale="risk" width={64} />,
      firstSort: 'desc',
      width: 130,
    },
  ];
  const productCols: Column<ProductSummary>[] = [
    { key: 'hsn8', header: 'HS code', value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} />, width: 110 },
    { key: 'description', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} /> },
    { key: 'imports', header: 'Imports (HS6)', align: 'right', value: (r) => r.imports, render: (r) => usd(r.imports), firstSort: 'desc' },
    { key: 'exports', header: 'Exports (HS6)', align: 'right', value: (r) => r.exports, render: (r) => usd(r.exports), hideBelow: 'md' },
    { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => ratio(r.rca), hideBelow: 'lg' },
    { key: 'mfn', header: 'MFN tariff', align: 'right', value: (r) => r.mfn_tariff, render: (r) => fmtRate(r.mfn_tariff, { na: NA_SHORT }), hideBelow: 'md' },
    { key: 'bcd', header: 'BCD', align: 'right', value: (r) => r.bcd_display, render: (r) => r.bcd_display ?? NA_SHORT, hideBelow: 'lg' },
  ];

  return (
    <div className={clsx('space-y-5', q.isFetching && 'opacity-60 transition-opacity')}>
      <SchemeHeader scheme={s} />

      <StatGrid cols={5}>
        <KpiTile label="Product lines covered" value={fmtNum(d.kpis.n_products)} icon={Layers} accent="ink" status={status} sub={`${fmtNum(hs6Rows.length)} HS6 subheadings listed`} />
        <KpiTile
          label="Imports that must meet the standard"
          value={d.kpis.imports === null ? null : fmtUSD(d.kpis.imports)}
          icon={Ship}
          provenance={trade}
          sub={shareOfIndia === null ? undefined : `${fmtPct(shareOfIndia)} of India's imports`}
        />
        <KpiTile
          label="Imported share of covered trade"
          value={share === null ? null : fmtPct(share, { digits: 0 })}
          icon={PieChart}
          accent="brand"
          provenance={trade}
          sub={`${fmtNum(netImporting)} of ${fmtNum(hs6Rows.length)} subheadings net imported`}
        />
        <KpiTile label="Exports covered" value={d.kpis.exports === null ? null : fmtUSD(d.kpis.exports)} accent="brand" provenance={trade} sub="Indian exporters certify to the same standard" />
        <KpiTile
          label="Average MFN tariff"
          value={avgTariff === null ? null : fmtRate(avgTariff, { digits: 1 })}
          accent="ink"
          provenance={TARIFF_PROVENANCE}
          sub="Simple average over covered subheadings"
          hint="The order adds a technical requirement on top of this tariff."
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
        <CoveredTradeChart
          products={d.products}
          importsOnly
          title="Covered imports by product"
          subtitle="The 10 covered HS6 subheadings with the largest imports (US$, latest year)"
        />
        <MethodNote title="Reading the supply-risk check" estimate={false} className="self-start">
          <p>
            A QCO raises the bar for every supplier at once. Where the covered products are mostly imported, from one dominant country, enforcing the
            standard can tighten supply until foreign plants are certified, so certification capacity and transition periods matter most there.
          </p>
          <p className="mt-2">
            Where India already exports the product, the order mainly lifts domestic quality and the import share is low.
          </p>
        </MethodNote>
      </div>

      <Card
        title="Supply-risk check: most import-dependent covered products"
        subtitle="Covered lines where imports dominate supply, with the main source country and China's share of India's imports"
        icon={ShieldCheck}
        actions={<ModelEstimateTag method="Vulnerability score (SPEC section 4)" />}
        footer={<SourceNote provenances={[trade, MODEL_PROVENANCE]} />}
      >
        <DataTable
          columns={depCols}
          rows={d.top_dependencies}
          rowKey={(r) => r.hsn8}
          defaultSort={{ key: 'vul', order: 'desc' }}
          pagination={{ mode: 'client', pageSize: 10 }}
          dense
          emptyTitle="No import-dependent products in the coverage"
        />
      </Card>

      <Card
        title={`Product coverage (${fmtNum(d.products.length)}${d.kpis.n_products > d.products.length ? ` of ${fmtNum(d.kpis.n_products)}` : ''} lines)`}
        subtitle="8-digit lines matched by the order's indicative HS coverage. Trade values are HS6-level and repeat for lines of the same subheading."
        footer={<SourceNote provenances={[trade, TARIFF_PROVENANCE]} />}
      >
        <DataTable columns={productCols} rows={d.products} rowKey={(r) => r.hsn8} defaultSort={{ key: 'imports', order: 'desc' }} csvFilename={`atlas-qco-${s.id}`} dense />
      </Card>
    </div>
  );
}

/** The "Quality control (QCO)" tab. */
export function QualityControlTab() {
  const q = useSchemes('QCO');
  const totalImports = useIndiaImports();
  const trade = useTradeProvenance();
  const [selected, setSelected] = useSearchParamState('qco', '');
  const list = useMemo(() => q.data ?? [], [q.data]);
  const byImports = useMemo(() => [...list].sort((a, b) => (b.imports ?? 0) - (a.imports ?? 0)), [list]);
  const current = list.find((s) => s.id === selected) ? selected : (byImports[0]?.id ?? null);

  // Drop a stale `?qco=` that is not a loaded order.
  useEffect(() => {
    if (selected && list.length && !list.some((s) => s.id === selected)) setSelected(null);
  }, [selected, list, setSelected]);

  return (
    <QueryState query={q} isEmpty={(d) => d.length === 0} emptyIcon={ShieldCheck} emptyTitle="No Quality Control Orders are loaded">
      {(orders) => {
        const covered = sumOrNull(orders.map((s) => s.imports));
        const coveredShare = totalImports && covered !== null ? covered / totalImports : null;
        const lines = orders.reduce((a, s) => a + (s.n_products ?? 0), 0);
        const ministries = new Set(orders.map((s) => s.ministry?.id).filter(Boolean)).size;
        return (
          <div className="space-y-6">
            <MethodNote title="What a Quality Control Order does" estimate={false}>
              A QCO makes a BIS Indian Standard compulsory: domestic output and imports alike must be certified and carry the Standard Mark before
              sale. The Atlas shows, for each order, the HS lines it covers and how much of India's trade in them is imported, so officials can see
              where a standard bears on foreign supply and where supply could tighten while suppliers certify.
            </MethodNote>

            <StatGrid cols={4}>
              <KpiTile label="Quality Control Orders" value={fmtNum(orders.length)} icon={ScrollText} accent="ink" status="verified" sub={`${fmtNum(ministries)} ministries / departments`} />
              <KpiTile
                label="Imports covered"
                value={covered === null ? null : fmtUSD(covered)}
                icon={Ship}
                provenance={trade}
                sub="Summed across orders; a line in two orders counts twice"
              />
              <KpiTile
                label="Share of India's imports"
                value={coveredShare === null ? null : fmtPct(coveredShare)}
                icon={PieChart}
                accent="brand"
                provenance={trade}
                sub={totalImports === null ? "India's total imports not available" : `of ${fmtUSD(totalImports)} total imports`}
              />
              <KpiTile label="Product lines covered" value={fmtNum(lines)} icon={BadgeCheck} accent="brand" status="verified" sub="Indicative HS coverage, counted per order" />
            </StatGrid>

            <CoverageChart orders={orders} totalImports={totalImports} />

            <OrdersTable orders={orders} totalImports={totalImports} selected={current} onSelect={(id) => setSelected(id)} />

            {current ? (
              <section aria-label="Selected order">
                <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink">
                  <Landmark className="size-4 text-brand-ink" aria-hidden />
                  Order detail
                </div>
                <OrderDetail id={current} totalImports={totalImports} />
              </section>
            ) : (
              <EmptyState title="Select an order" />
            )}
          </div>
        );
      }}
    </QueryState>
  );
}
