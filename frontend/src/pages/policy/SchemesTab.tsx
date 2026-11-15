/**
 * "PLI targeting" tab of the Policy Workbench: schemes and the products they cover.
 *
 * GET /api/policy/schemes?kind=PLI for the list and GET /api/policy/schemes/{id} for the detail:
 * - KPI strip: schemes, total approved outlay, ministries, product lines covered;
 * - trade covered per scheme (imports vs exports, one US$ axis);
 * - a selectable scheme list (`?scheme=` in the URL) and the scheme detail: outlay, exports / imports
 *   covered, trade balance, average RCA, targeting signals (competitive lines to scale up, net-import
 *   lines to substitute, the largest capability gaps), the covered products' trade, the most
 *   import-dependent covered products and the full product coverage.
 *
 * Targeting signals are computed here from the covered products, one row per HS6 (trade values are
 * HS6-level and repeat for the 8-digit lines of a subheading).
 */
import { useEffect, useMemo } from 'react';
import clsx from 'clsx';
import { ArrowDownToLine, IndianRupee, Landmark, Layers, ScrollText, Target, TrendingUp } from 'lucide-react';
import type { DependencyHotspot, ProductSummary, SchemeDetail, SchemeListItem } from '@/api/types';
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
  StatGrid,
  type Column,
} from '@/components';
import { fmtNum, fmtRatio, fmtUSD, NA_SHORT, truncate } from '@/lib/format';
import { useSearchParamState } from '@/lib/hooks';
import { CATEGORICAL } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { groupedHBarOption } from '../analytics/shared/chart';
import { MODEL_PROVENANCE, pct, ProductText, ratio, SourceNote, sumOrNull, TARIFF_PROVENANCE, usd, useTradeProvenance } from '../analytics/shared/ui';
import { useScheme, useSchemes } from './api';
import { CoveredTradeChart, distinctHs6, fmtCrore, importSourceName, SchemeHeader, SchemeList, shortSchemeName, sourceStatus } from './schemeShared';

export { shortSchemeName } from './schemeShared';

function SchemeChart({ schemes }: { schemes: SchemeListItem[] }) {
  const { mode } = useTheme();
  const sorted = useMemo(() => [...schemes].sort((a, b) => (b.exports ?? 0) + (b.imports ?? 0) - ((a.exports ?? 0) + (a.imports ?? 0))), [schemes]);
  const option = useMemo(
    () =>
      groupedHBarOption({
        categories: sorted.map((s) => shortSchemeName(s.name)),
        fullLabels: sorted.map((s) => s.name),
        series: [
          { name: 'India imports covered', values: sorted.map((s) => s.imports), color: CATEGORICAL[mode][1] },
          { name: 'India exports covered', values: sorted.map((s) => s.exports), color: CATEGORICAL[mode][0] },
        ],
        labelMax: 34,
      }),
    [sorted, mode],
  );
  return (
    <Card title="Trade covered by each PLI scheme" subtitle="India's exports and imports of the HS lines each scheme covers (US$, latest year)">
      <EChart option={option} height={Math.max(300, sorted.length * 40 + 40)} ariaLabel="Trade covered by each PLI scheme" />
    </Card>
  );
}

/** Mini stat used inside the targeting card. */
function Signal({ icon: Icon, label, value, sub, tone }: { icon: typeof Target; label: string; value: string; sub: string; tone: 'ok' | 'bad' | 'brand' }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-3">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink-2">
        <Icon className={clsx('size-4', tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : 'text-brand-ink')} aria-hidden />
        {label}
      </div>
      <div className="mt-1 text-[22px] leading-tight font-bold text-ink">{value}</div>
      <div className="mt-0.5 text-[12px] text-muted">{sub}</div>
    </div>
  );
}

/**
 * Targeting signals for a PLI scheme from its covered HS6 products: where India is already
 * competitive (scale-up), where it is a net importer (substitution), and the biggest capability gaps
 * (large imports, RCA below 1).
 */
function TargetingSignals({ d }: { d: SchemeDetail }) {
  const rows = useMemo(() => distinctHs6(d.products), [d.products]);
  const competitive = rows.filter((r) => (r.rca ?? 0) >= 1);
  const netImport = rows.filter((r) => r.imports !== null && (r.imports ?? 0) > (r.exports ?? 0));
  const netImportGap = sumOrNull(netImport.map((r) => (r.imports ?? 0) - (r.exports ?? 0)));
  const gaps = [...rows].filter((r) => r.rca !== null && r.rca < 1 && (r.imports ?? 0) > 0).sort((a, b) => (b.imports ?? 0) - (a.imports ?? 0)).slice(0, 5);
  const truncated = d.kpis.n_products > d.products.length;
  return (
    <Card
      title="Targeting signals"
      subtitle={`Computed from the ${fmtNum(rows.length)} covered HS6 subheadings${truncated ? ` in the first ${fmtNum(d.products.length)} covered lines` : ''}`}
      icon={Target}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Signal
          icon={TrendingUp}
          tone="ok"
          label="Competitive lines to scale up"
          value={fmtNum(competitive.length)}
          sub={`RCA ≥ 1 · ${fmtUSD(sumOrNull(competitive.map((r) => r.exports)))} exports`}
        />
        <Signal icon={ArrowDownToLine} tone="bad" label="Net-import lines to substitute" value={fmtNum(netImport.length)} sub={`Imports above exports · net gap ${fmtUSD(netImportGap)}`} />
        <Signal icon={Layers} tone="brand" label="Subheadings covered" value={fmtNum(rows.length)} sub={`${fmtNum(d.kpis.n_products)} 8-digit lines in all`} />
      </div>
      <div className="mt-4">
        <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Largest capability gaps (imports, RCA below 1)</div>
        {gaps.length ? (
          <ol className="divide-y divide-line rounded-lg border border-line">
            {gaps.map((g, i) => (
              <li key={g.hs6} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="w-4 text-right text-xs text-muted atlas-num">{i + 1}</span>
                <CodeLink code={g.hsn8} label={truncate(g.description, 70)} className="min-w-0 flex-1" />
                <span className="shrink-0 text-right atlas-num">
                  <span className="font-semibold text-ink">{fmtUSD(g.imports)}</span>
                  <span className="ml-2 text-xs text-muted">RCA {fmtRatio(g.rca)}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[13px] text-ink-2">No covered subheading combines imports with an RCA below 1.</p>
        )}
      </div>
    </Card>
  );
}

function SchemeDetailPanel({ id }: { id: string }) {
  const q = useScheme(id);
  const trade = useTradeProvenance();
  if (q.isPending) return <LoadingBlock label="Loading scheme…" height={320} />;
  if (q.isError && !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (!d) return null;
  const s = d.scheme;
  const status = sourceStatus(s.source);

  const productCols: Column<ProductSummary>[] = [
    { key: 'hsn8', header: 'HS code', value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} />, width: 110 },
    { key: 'description', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} /> },
    { key: 'ministry', header: 'Ministry', value: (r) => r.ministry_short, render: (r) => <MinistryPill size="xs" ministry={{ id: r.ministry_id, short_name: r.ministry_short, name: r.ministry_name }} />, hideBelow: 'lg' },
    { key: 'exports', header: 'Exports (HS6)', align: 'right', value: (r) => r.exports, render: (r) => usd(r.exports) },
    { key: 'imports', header: 'Imports (HS6)', align: 'right', value: (r) => r.imports, render: (r) => usd(r.imports) },
    { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => ratio(r.rca), hideBelow: 'md' },
    { key: 'bcd', header: 'BCD', align: 'right', value: (r) => r.bcd_display, render: (r) => r.bcd_display ?? NA_SHORT, hideBelow: 'md' },
  ];
  const depCols: Column<DependencyHotspot>[] = [
    { key: 'hsn8', header: 'HS code', value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} />, width: 110 },
    { key: 'description', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} /> },
    { key: 'imports', header: 'Imports (HS6)', align: 'right', value: (r) => r.imports, render: (r) => usd(r.imports) },
    {
      key: 'source',
      header: 'Top source',
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

  return (
    <div className={clsx('space-y-5', q.isFetching && 'opacity-60 transition-opacity')}>
      <SchemeHeader scheme={s} />

      <StatGrid cols={5}>
        <KpiTile
          label="Approved outlay (₹ crore)"
          value={s.outlay_crore === null ? null : `₹${Math.round(s.outlay_crore).toLocaleString('en-IN')}`}
          icon={IndianRupee}
          accent="ink"
          status={status}
          sub={`${fmtNum(d.kpis.n_products)} product lines covered`}
        />
        <KpiTile label="India exports covered" value={d.kpis.exports === null ? null : fmtUSD(d.kpis.exports)} accent="brand" provenance={trade} />
        <KpiTile label="India imports covered" value={d.kpis.imports === null ? null : fmtUSD(d.kpis.imports)} provenance={trade} />
        <KpiTile
          label="Trade balance"
          value={d.kpis.trade_balance === null ? null : fmtUSD(d.kpis.trade_balance, { signed: true })}
          accent={(d.kpis.trade_balance ?? 0) >= 0 ? 'ok' : 'bad'}
          provenance={trade}
        />
        <KpiTile label="Average RCA" value={d.kpis.avg_rca === null ? null : fmtRatio(d.kpis.avg_rca)} accent="ink" provenance={trade} hint="Average revealed comparative advantage of the covered products" />
      </StatGrid>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-2">
        <TargetingSignals d={d} />
        <CoveredTradeChart
          products={d.products}
          title="Covered products: imports and exports"
          subtitle="The 10 covered HS6 subheadings with the most trade (US$, latest year)"
        />
      </div>

      <Card
        title="Most import-dependent covered products"
        subtitle="Covered lines where dependence on imports is highest: candidates to prioritise in disbursement and supplier development"
        actions={<ModelEstimateTag method="Vulnerability score (SPEC section 4)" />}
        footer={<SourceNote provenances={[trade, MODEL_PROVENANCE]} />}
      >
        <DataTable columns={depCols} rows={d.top_dependencies} rowKey={(r) => r.hsn8} defaultSort={{ key: 'vul', order: 'desc' }} pagination={{ mode: 'client', pageSize: 10 }} dense emptyTitle="No import-dependent products in the coverage" />
      </Card>

      <Card
        title={`Product coverage (${fmtNum(d.products.length)}${d.kpis.n_products > d.products.length ? ` of ${fmtNum(d.kpis.n_products)}` : ''} lines)`}
        subtitle="8-digit lines matched by the scheme's indicative HS coverage. Trade values are HS6-level and repeat for lines of the same subheading."
        footer={<SourceNote provenances={[trade, TARIFF_PROVENANCE]} />}
      >
        <DataTable columns={productCols} rows={d.products} rowKey={(r) => r.hsn8} defaultSort={{ key: 'imports', order: 'desc' }} csvFilename={`atlas-scheme-${s.id}`} dense />
      </Card>
    </div>
  );
}

/** The "PLI targeting" tab. */
export function SchemesTab() {
  const q = useSchemes('PLI');
  const [selected, setSelected] = useSearchParamState('scheme', '');
  const list = useMemo(() => q.data ?? [], [q.data]);
  const current = list.find((s) => s.id === selected) ? selected : (list[0]?.id ?? null);

  // Drop a stale `?scheme=` that is not a PLI scheme.
  useEffect(() => {
    if (selected && list.length && !list.some((s) => s.id === selected)) setSelected(null);
  }, [selected, list, setSelected]);

  return (
    <QueryState query={q} isEmpty={(d) => d.length === 0} emptyIcon={Target} emptyTitle="No PLI schemes are loaded">
      {(schemes) => {
        const outlay = sumOrNull(schemes.map((s) => s.outlay_crore));
        const ministries = new Set(schemes.map((s) => s.ministry?.id).filter(Boolean)).size;
        const lines = schemes.reduce((a, s) => a + (s.n_products ?? 0), 0);
        return (
          <div className="space-y-6">
            <StatGrid cols={4}>
              <KpiTile label="PLI schemes" value={fmtNum(schemes.length)} icon={ScrollText} accent="ink" status="verified" sub="Compiled from public GoI sources" />
              <KpiTile label="Total approved outlay" value={fmtCrore(outlay)} icon={IndianRupee} status="verified" sub="Sum of scheme outlays" />
              <KpiTile label="Ministries / Departments" value={fmtNum(ministries)} icon={Landmark} accent="brand" />
              <KpiTile label="Product lines covered" value={fmtNum(lines)} icon={Layers} accent="brand" sub="Counted per scheme (lines can overlap)" />
            </StatGrid>

            <SchemeChart schemes={schemes} />

            <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
              <Card title="Schemes" subtitle="Select one to see its coverage and targeting signals" padding="sm">
                <SchemeList schemes={schemes} selected={current} onSelect={(id) => setSelected(id)} meta={(s) => fmtCrore(s.outlay_crore)} />
              </Card>
              {current ? <SchemeDetailPanel id={current} /> : <EmptyState title="Select a scheme" />}
            </div>
          </div>
        );
      }}
    </QueryState>
  );
}
