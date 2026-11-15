/**
 * Competitiveness tab (Opportunity Lab) - GET /api/analytics/competitiveness.
 *
 * - RCA distribution histogram (products or export value per RCA bucket; one hue).
 * - Export-weighted RCA by sector: horizontal bars, sectors with RCA >= 1 in the series blue and the
 *   rest in the de-emphasis grey (emphasis, not a value ramp), with a reference line at RCA = 1.
 * - Top-RCA product table.
 */
import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { Award, PieChart } from 'lucide-react';
import type { AnalyticsFilters, CompetitivenessItem, CompetitivenessResponse } from '@/api/types';
import { Card, DataTable, EChart, KpiTile, QueryState, SegmentedControl, StatGrid, type Column } from '@/components';
import { fmtNum, fmtPct, fmtRatio, fmtUSD, truncate } from '@/lib/format';
import { BASE_GRID, CATEGORICAL, CHART_TOKENS, OTHER_GREY } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { useCompetitiveness } from '../api';
import { escapeHtml, usdTick } from '../shared/chart';
import { Hs6Code, ItemMinistry, MethodNote, pct, ProductText, ratio, SourceNote, usd, useTradeProvenance } from '../shared/ui';

function RcaHistogram({ histogram }: { histogram: CompetitivenessResponse['histogram'] }) {
  const { mode } = useTheme();
  const [metric, setMetric] = useState<'count' | 'exports'>('count');
  const option = useMemo<EChartsOption>(
    () => ({
      grid: { ...BASE_GRID, top: 16, bottom: 30, left: 12 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (raw: unknown) => {
          const r = (Array.isArray(raw) ? raw[0] : raw) as { dataIndex: number };
          const h = histogram[r.dataIndex];
          if (!h) return '';
          return `<b>RCA ${escapeHtml(h.bucket)}</b><br/>Products: <b>${fmtNum(h.count)}</b><br/>India exports: <b>${fmtUSD(h.exports)}</b>`;
        },
      },
      xAxis: { type: 'category', data: histogram.map((h) => h.bucket), name: 'RCA bucket', nameLocation: 'middle', nameGap: 26 },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => (metric === 'count' ? fmtNum(v, { compact: true }) : usdTick(v)) } },
      series: [
        {
          type: 'bar',
          name: metric === 'count' ? 'Products' : 'India exports',
          data: histogram.map((h) => (metric === 'count' ? h.count : h.exports)),
          barMaxWidth: 24,
          itemStyle: { color: CATEGORICAL[mode][0], borderRadius: [4, 4, 0, 0] },
          label: {
            show: true,
            position: 'top',
            fontSize: 10.5,
            formatter: (p) => (typeof p.value === 'number' ? (metric === 'count' ? fmtNum(p.value) : fmtUSD(p.value, { sig: 2 })) : ''),
          },
        },
      ],
    }),
    [histogram, metric, mode],
  );
  return (
    <Card
      title="Distribution of comparative advantage"
      subtitle={metric === 'count' ? 'Number of HS6 products by RCA bucket' : "India's exports by RCA bucket (US$)"}
      actions={
        <SegmentedControl
          value={metric}
          onChange={setMetric}
          ariaLabel="Histogram metric"
          options={[
            { value: 'count', label: 'Products' },
            { value: 'exports', label: 'Export value' },
          ]}
        />
      }
    >
      {histogram.length ? (
        <EChart option={option} height={300} ariaLabel="Histogram of RCA values" />
      ) : (
        <div className="py-8 text-center text-sm text-muted">No RCA distribution is available for this selection.</div>
      )}
    </Card>
  );
}

function SectorRca({ rows }: { rows: CompetitivenessResponse['by_sector'] }) {
  const { mode } = useTheme();
  const t = CHART_TOKENS[mode];
  const sorted = useMemo(() => [...rows].filter((r) => typeof r.rca_weighted === 'number').sort((a, b) => (b.rca_weighted ?? 0) - (a.rca_weighted ?? 0)), [rows]);
  const option = useMemo<EChartsOption>(
    () => ({
      grid: { ...BASE_GRID, top: 20, right: 48 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (raw: unknown) => {
          const r = (Array.isArray(raw) ? raw[0] : raw) as { dataIndex: number };
          const s = sorted[r.dataIndex];
          if (!s) return '';
          return `<b>${escapeHtml(s.name)}</b><br/>Export-weighted RCA: <b>${fmtRatio(s.rca_weighted)}</b><br/>Products with RCA &gt; 1: <b>${fmtNum(s.n_rca_gt1)}</b><br/>India exports: <b>${fmtUSD(s.exports)}</b>`;
        },
      },
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtNum(v) } },
      yAxis: { type: 'category', data: sorted.map((s) => truncate(s.name, 28)), inverse: true, splitLine: { show: false } },
      series: [
        {
          type: 'bar',
          name: 'Export-weighted RCA',
          data: sorted.map((s) => ({
            value: s.rca_weighted,
            itemStyle: { color: (s.rca_weighted ?? 0) >= 1 ? CATEGORICAL[mode][0] : OTHER_GREY[mode] },
          })),
          barMaxWidth: 16,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', fontSize: 10.5, formatter: (p) => fmtRatio(Number(p.value)) },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: t.ink2, type: 'solid', width: 1 },
            label: { formatter: 'RCA = 1', position: 'end', color: t.muted, fontSize: 10.5 },
            data: [{ xAxis: 1 }],
          },
        },
      ],
    }),
    [sorted, mode, t],
  );
  return (
    <Card
      title="Comparative advantage by sector"
      subtitle="Export-weighted average RCA of each sector's HS6 products; blue bars are sectors where India is specialised (RCA ≥ 1)."
    >
      {sorted.length ? (
        <EChart option={option} height={Math.max(260, sorted.length * 24 + 40)} ariaLabel="Export-weighted RCA by sector" />
      ) : (
        <div className="py-8 text-center text-sm text-muted">No sector breakdown is available for this selection.</div>
      )}
    </Card>
  );
}

export function CompetitivenessTab({ filters }: { filters: AnalyticsFilters }) {
  const q = useCompetitiveness({ ...filters, limit: 100 });
  const trade = useTradeProvenance();

  return (
    <QueryState query={q} isEmpty={(d) => !d.histogram.length && !d.top_rca.length} emptyTitle="No competitiveness data for this selection">
      {(d) => {
        const columns: Column<CompetitivenessItem>[] = [
          { key: 'hs6', header: 'HS6', value: (r) => r.hs6, render: (r) => <Hs6Code hs6={r.hs6} hsn8={r.hsn8_sample} />, width: 96 },
          { key: 'product', header: 'Product', value: (r) => r.description, render: (r) => <ProductText text={r.description} />, width: '30%' },
          { key: 'ministry', header: 'Ministry', value: (r) => r.ministry_short, render: (r) => <ItemMinistry id={r.ministry_id} short={r.ministry_short} />, hideBelow: 'lg' },
          { key: 'sector', header: 'Sector', value: (r) => r.sector_name, hideBelow: 'xl' },
          { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => <span className="font-semibold">{ratio(r.rca)}</span>, firstSort: 'desc' },
          { key: 'exports', header: 'India exports', align: 'right', value: (r) => r.india_exports, render: (r) => usd(r.india_exports) },
          { key: 'world', header: 'World market', align: 'right', value: (r) => r.world_trade, render: (r) => usd(r.world_trade), hideBelow: 'md' },
          { key: 'share', header: 'India share', align: 'right', value: (r) => r.india_world_share ?? null, render: (r) => pct(r.india_world_share ?? null), hideBelow: 'md' },
          { key: 'xcagr', header: 'Export CAGR', align: 'right', value: (r) => r.export_cagr ?? null, render: (r) => pct(r.export_cagr ?? null, true), hideBelow: 'lg' },
        ];
        return (
          <div className="space-y-6">
            <StatGrid cols={3}>
              <KpiTile label="Products with RCA > 1" value={fmtNum(d.summary.n_rca_gt1)} icon={Award} sub="India relatively specialised" provenance={trade} />
              <KpiTile
                label="Share of exports from RCA > 1 products"
                value={d.summary.exports_rca_gt1_share === null ? null : fmtPct(d.summary.exports_rca_gt1_share)}
                icon={PieChart}
                accent="brand"
                provenance={trade}
              />
              <MethodNote title="What RCA measures" estimate={false}>
                RCA = (India's share of the product in its exports) ÷ (the product's share of world trade). Above 1, India exports
                relatively more of the product than the world average.
              </MethodNote>
            </StatGrid>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <RcaHistogram histogram={d.histogram} />
              <SectorRca rows={d.by_sector} />
            </div>

            <Card
              title="Most competitive products"
              subtitle="HS6 products with the highest revealed comparative advantage in this selection"
              footer={<SourceNote provenances={[trade]} />}
            >
              <DataTable columns={columns} rows={d.top_rca} rowKey={(r) => r.hs6} defaultSort={{ key: 'rca', order: 'desc' }} csvFilename="atlas-top-rca" dense />
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}
