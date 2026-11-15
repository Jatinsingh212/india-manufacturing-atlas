/**
 * Import dependency tab (Opportunity Lab) - GET /api/analytics/import-dependency.
 *
 * KPIs (total imports, China's share, highly dependent products, average vulnerability), the source
 * countries India's imports of these products come from (horizontal bars, one hue), and the ranked
 * product table with dependency ratio, source concentration (HHI), top source, China share and the
 * import-dependency / vulnerability model scores. Each row links to its network trace.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Gauge, Globe2, PackageSearch, Ship } from 'lucide-react';
import type { AnalyticsFilters, ImportDependencyItem, SourceCountryRow } from '@/api/types';
import { Card, DataTable, EChart, KpiTile, ModelEstimateTag, QueryState, ScoreBar, SegmentedControl, StatGrid, type Column } from '@/components';
import { fmtNum, fmtPct, fmtScore, fmtUSD } from '@/lib/format';
import { routes } from '@/lib/routes';
import { CATEGORICAL } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { useImportDependency } from '../api';
import { groupedHBarOption } from '../shared/chart';
import { Hs6Code, ItemMinistry, MethodNote, MODEL_PROVENANCE, pct, ProductText, ratio, ScoresPendingNote, SourceNote, usd, useTradeProvenance } from '../shared/ui';

function SourceCountries({ rows }: { rows: SourceCountryRow[] }) {
  const { mode } = useTheme();
  const [metric, setMetric] = useState<'imports' | 'products'>('imports');
  const top = useMemo(() => {
    const sorted = [...rows].sort((a, b) => (metric === 'imports' ? (b.imports ?? 0) - (a.imports ?? 0) : b.n_products - a.n_products));
    return sorted.slice(0, 12);
  }, [rows, metric]);
  const option = useMemo(
    () =>
      groupedHBarOption({
        categories: top.map((r) => r.country),
        series: [
          {
            name: metric === 'imports' ? 'Imports (US$)' : 'Products sourced from the country',
            values: top.map((r) => (metric === 'imports' ? r.imports : r.n_products)),
            color: CATEGORICAL[mode][0],
          },
        ],
        valueFormatter: metric === 'imports' ? (v) => fmtUSD(v) : (v) => fmtNum(v),
        axisFormatter: metric === 'imports' ? undefined : (v) => fmtNum(v),
      }),
    [top, metric, mode],
  );
  return (
    <Card
      title="Where the imports come from"
      subtitle={metric === 'imports' ? "India's imports of the products in this selection, by source country (US$)" : 'Number of products in this selection sourced from each country'}
      actions={
        <SegmentedControl
          value={metric}
          onChange={setMetric}
          ariaLabel="Metric"
          options={[
            { value: 'imports', label: 'Import value' },
            { value: 'products', label: 'Products' },
          ]}
        />
      }
    >
      {top.length ? (
        <EChart option={option} height={Math.max(220, top.length * 30 + 30)} ariaLabel="Imports by source country" />
      ) : (
        <div className="py-8 text-center text-sm text-muted">No source-country breakdown is available for this selection.</div>
      )}
    </Card>
  );
}

export function ImportDependencyTab({ filters }: { filters: AnalyticsFilters }) {
  const q = useImportDependency({ ...filters, limit: 300 });
  const trade = useTradeProvenance();

  return (
    <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyTitle="No import-dependent products match these filters">
      {(d) => {
        // Highest dependency score first; the import bill breaks ties (and orders the list while scores are not built).
        const items = [...d.items].sort(
          (a, b) => (b.import_dependency_score ?? -1) - (a.import_dependency_score ?? -1) || (b.india_imports ?? -1) - (a.india_imports ?? -1),
        );
        const summaryN = (d.summary as Record<string, unknown>).n_products;
        const nAll = typeof summaryN === 'number' ? summaryN : items.length;
        const highDep = items.filter((i) => (i.dependency_ratio ?? 0) >= 0.8).length;
        const vul = items.map((i) => i.vulnerability_score).filter((v): v is number => typeof v === 'number');
        const avgVul = vul.length ? vul.reduce((a, b) => a + b, 0) / vul.length : null;

        const columns: Column<ImportDependencyItem>[] = [
          { key: 'hs6', header: 'HS6', value: (r) => r.hs6, render: (r) => <Hs6Code hs6={r.hs6} hsn8={r.hsn8_sample} />, width: 96 },
          { key: 'product', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} />, width: '22%' },
          { key: 'ministry', header: 'Ministry', value: (r) => r.ministry_short, render: (r) => <ItemMinistry id={r.ministry_id} short={r.ministry_short} />, hideBelow: 'xl' },
          { key: 'imports', header: 'India imports', align: 'right', value: (r) => r.india_imports, render: (r) => usd(r.india_imports) },
          { key: 'exports', header: 'India exports', align: 'right', value: (r) => r.india_exports, render: (r) => usd(r.india_exports), hideBelow: 'lg' },
          {
            key: 'dep',
            header: 'Dependency',
            align: 'right',
            value: (r) => r.dependency_ratio,
            render: (r) => pct(r.dependency_ratio),
            hint: 'Imports ÷ (imports + exports). 100% means India imports the product but does not export it.',
          },
          {
            key: 'source',
            header: 'Top source',
            value: (r) => r.top_import_source_name ?? r.top_import_source,
            render: (r) =>
              r.top_import_source_name || r.top_import_source ? (
                <span className="whitespace-nowrap">
                  {r.top_import_source_name ?? r.top_import_source}
                  <span className="ml-1 text-muted atlas-num">{pct(r.top_import_source_share)}</span>
                </span>
              ) : (
                <span className="text-muted">—</span>
              ),
          },
          { key: 'china', header: 'China share', align: 'right', value: (r) => r.china_import_share, render: (r) => pct(r.china_import_share), hideBelow: 'md' },
          {
            key: 'hhi',
            header: 'Source HHI',
            align: 'right',
            value: (r) => r.india_import_hhi,
            render: (r) => ratio(r.india_import_hhi),
            hint: "Herfindahl index of India's import sources (0 = widely spread, 1 = a single supplier).",
            hideBelow: 'lg',
          },
          {
            key: 'ids',
            header: 'Dependency score',
            value: (r) => r.import_dependency_score,
            render: (r) => <ScoreBar value={r.import_dependency_score} scale="risk" width={64} />,
            hint: '0–100 model score: 50% dependency ratio, 30% import size percentile, 20% source concentration.',
            firstSort: 'desc',
            width: 130,
          },
          {
            key: 'vul',
            header: 'Vulnerability',
            value: (r) => r.vulnerability_score,
            render: (r) => <ScoreBar value={r.vulnerability_score} scale="risk" width={64} />,
            hint: '0–100 model score: 30% dependency ratio, 25% source concentration, 20% China share, 25% import size percentile.',
            firstSort: 'desc',
            width: 130,
          },
          {
            key: 'trace',
            header: '',
            csv: false,
            render: (r) => (
              <Link to={routes.network({ center: r.hsn8_sample ?? r.hs6, depth: 2 })} className="text-xs whitespace-nowrap text-brand-ink hover:underline">
                Trace
              </Link>
            ),
          },
        ];

        return (
          <div className="space-y-6">
            <ScoresPendingNote response={d} what="Import dependency and vulnerability scores" />
            <StatGrid cols={4}>
              <KpiTile label="India imports in selection" value={d.summary.total_imports === null ? null : fmtUSD(d.summary.total_imports)} icon={Ship} provenance={trade} sub={`${fmtNum(nAll)} HS6 products imported`} />
              <KpiTile label="China's share of these imports" value={d.summary.china_share === null ? null : fmtPct(d.summary.china_share)} icon={Globe2} accent="bad" provenance={trade} />
              <KpiTile
                label="Highly dependent products"
                value={fmtNum(highDep)}
                icon={PackageSearch}
                accent="brand"
                sub={`Dependency ratio ≥ 80% (of the top ${fmtNum(items.length)} listed)`}
                hint="Products where imports are at least four times exports."
                provenance={trade}
              />
              <KpiTile label="Average vulnerability" value={avgVul === null ? null : fmtScore(avgVul)} icon={Gauge} accent="ink" sub="Of the listed products; 0–100, higher = more exposed" provenance={MODEL_PROVENANCE} />
            </StatGrid>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <SourceCountries rows={d.by_source_country} />
              <MethodNote method="Import dependency and vulnerability scores" className="self-start">
                <p>
                  <b>Dependency ratio</b> = imports ÷ (imports + exports). The <b>import dependency score</b> adds the size of the import bill
                  (percentile) and how concentrated India's sources are (HHI). The <b>vulnerability score</b> also weighs China's share of
                  supply, because concentration on one supplier is the main supply-chain risk the Atlas detects early.
                </p>
                <p className="mt-2">
                  Use <b>Trace</b> on a row to see which downstream value chains depend on the product, or open the{' '}
                  <Link to={routes.risk()} className="atlas-link">
                    Supply-chain Risk
                  </Link>{' '}
                  page for alerts.
                </p>
              </MethodNote>
            </div>

            <Card
              title="Import-dependent products"
              subtitle="Ranked by the import dependency score; sources and shares refer to India's imports in the latest year."
              actions={<ModelEstimateTag method="Import dependency and vulnerability scores (SPEC section 4)" />}
              footer={<SourceNote provenances={[trade, MODEL_PROVENANCE]} />}
            >
              <DataTable
                columns={columns}
                rows={items}
                rowKey={(r) => r.hs6}
                defaultSort={{ key: 'ids', order: 'desc' }}
                csvFilename="atlas-import-dependency"
                dense
              />
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}
