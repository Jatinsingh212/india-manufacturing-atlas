/**
 * Archetypes tab (Opportunity Lab) - GET /api/analytics/archetypes.
 *
 * Two complementary segmentations of HS6 products (SPEC section 4):
 * - Rule archetypes (Champion / Established / Emerging / Dependent / Marginal): a bar chart of the
 *   chosen metric per archetype (archetype colours, the same as the opportunity matrix) and a card per
 *   archetype with its rule and example products.
 * - k-means clusters (k = 6, standardised trade features): the cluster table with centroid values and
 *   examples, labelled as a model estimate.
 */
import { useMemo, useState } from 'react';
import type { EChartsOption } from 'echarts';
import type { AnalyticsFilters, ArchetypeSummary, ClusterSummary } from '@/api/types';
import { ArchetypeBadge, Card, CodeLink, EChart, ModelEstimateTag, QueryState, SegmentedControl } from '@/components';
import { fmtNum, fmtPct, fmtRatio, fmtUSD, truncate } from '@/lib/format';
import { ARCHETYPE_ORDER, archetypeColor, BASE_GRID, DIVERGING, OTHER_GREY, type ThemeMode } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { useArchetypes } from '../api';
import { escapeHtml, usdTick } from '../shared/chart';
import { MethodNote, MODEL_PROVENANCE, ScoresPendingNote, SourceNote, useTradeProvenance } from '../shared/ui';

const RULES: Record<string, string> = {
  Champion: 'RCA ≥ 1 and India’s exports growing at least as fast as world demand',
  Established: 'RCA ≥ 1 (revealed comparative advantage)',
  Emerging: '0.3 ≤ RCA < 1 with exports outgrowing world demand',
  Dependent: 'Imports at least twice exports and ≥ $50 mn',
  Marginal: 'None of the rules above',
};

/**
 * The k-means features (SPEC section 4) and how to show a centroid value in plain units: the log
 * features are log1p(US$), so expm1() gives the cluster's typical (geometric-mean) value in US$.
 */
const FEATURES: ReadonlyArray<{ key: string; label: string; format: (v: number) => string }> = [
  { key: 'log1p_x', label: 'Typical exports', format: (v) => fmtUSD(Math.expm1(v)) },
  { key: 'log1p_m', label: 'Typical imports', format: (v) => fmtUSD(Math.expm1(v)) },
  { key: 'log1p_w', label: 'Typical world market', format: (v) => fmtUSD(Math.expm1(v)) },
  { key: 'rca_capped', label: 'RCA (capped at 5)', format: (v) => fmtRatio(v) },
  { key: 'world_cagr', label: 'World CAGR', format: (v) => fmtPct(v, { signed: true }) },
  { key: 'export_cagr', label: 'Export CAGR', format: (v) => fmtPct(v, { signed: true }) },
];

/** Cluster rows as sent by the API (SPEC shape plus z-scores and totals). */
type ClusterRow = ClusterSummary & { z?: Record<string, number | null>; n_total?: number; exports?: number | null; imports?: number | null };

/** Archetype rows as sent by the API (SPEC shape plus the rule text). */
type ArchetypeRow = ArchetypeSummary & { rule?: string | null };

type Metric = 'n' | 'exports' | 'imports';

function ArchetypeChart({ rows }: { rows: ArchetypeSummary[] }) {
  const { mode } = useTheme();
  const [metric, setMetric] = useState<Metric>('n');
  const trade = useTradeProvenance();
  const ordered = useMemo(() => inArchetypeOrder(rows), [rows]);
  const option = useMemo<EChartsOption>(() => {
    const fmt = (v: number) => (metric === 'n' ? fmtNum(v) : fmtUSD(v));
    return {
      grid: { ...BASE_GRID, top: 12, right: 72 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (raw: unknown) => {
          const r = (Array.isArray(raw) ? raw[0] : raw) as { dataIndex: number };
          const a = ordered[r.dataIndex];
          if (!a) return '';
          return `<b>${escapeHtml(String(a.name))}</b><br/>Products: <b>${fmtNum(a.n)}</b><br/>India exports: <b>${fmtUSD(a.exports)}</b><br/>India imports: <b>${fmtUSD(a.imports)}</b>`;
        },
      },
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => (metric === 'n' ? fmtNum(v, { compact: true }) : usdTick(v)) } },
      yAxis: { type: 'category', data: ordered.map((a) => String(a.name)), inverse: true, splitLine: { show: false } },
      series: [
        {
          type: 'bar',
          name: metric === 'n' ? 'Products' : metric === 'exports' ? 'India exports' : 'India imports',
          data: ordered.map((a) => ({
            value: metric === 'n' ? a.n : metric === 'exports' ? a.exports : a.imports,
            itemStyle: { color: ARCHETYPE_ORDER.includes(a.name as (typeof ARCHETYPE_ORDER)[number]) ? archetypeColor(String(a.name), mode) : OTHER_GREY[mode] },
          })),
          barMaxWidth: 20,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', fontSize: 10.5, formatter: (p) => (typeof p.value === 'number' ? fmt(p.value) : '') },
        },
      ],
    };
  }, [ordered, metric, mode]);
  return (
    <Card
      title="Products by archetype"
      subtitle={metric === 'n' ? 'Number of HS6 products in each rule archetype' : metric === 'exports' ? "India's exports by archetype (US$)" : "India's imports by archetype (US$)"}
      actions={
        <SegmentedControl
          value={metric}
          onChange={setMetric}
          ariaLabel="Metric"
          options={[
            { value: 'n', label: 'Products' },
            { value: 'exports', label: 'Exports' },
            { value: 'imports', label: 'Imports' },
          ]}
        />
      }
      footer={<SourceNote provenances={[trade, MODEL_PROVENANCE]} />}
    >
      <EChart option={option} height={Math.max(220, ordered.length * 40 + 30)} ariaLabel="Archetype distribution" />
    </Card>
  );
}

/** Rows in the fixed archetype order (Champion first); unknown names last. */
function inArchetypeOrder<T extends ArchetypeSummary>(rows: T[]): T[] {
  const idx = (n: string) => {
    const i = ARCHETYPE_ORDER.indexOf(n as (typeof ARCHETYPE_ORDER)[number]);
    return i < 0 ? 99 : i;
  };
  return [...rows].sort((a, b) => idx(String(a.name)) - idx(String(b.name)));
}

function ArchetypeCards({ rows }: { rows: ArchetypeRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {inArchetypeOrder(rows).map((a) => (
        <div key={String(a.name)} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="flex items-start justify-between gap-2">
            <ArchetypeBadge archetype={a.name} />
            <span className="text-xs text-muted atlas-num">{fmtNum(a.n)} products</span>
          </div>
          <p className="mt-2 text-[12.5px] text-ink-2">{RULES[String(a.name)] ?? a.rule ?? 'Products not covered by the rules.'}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
            <div className="rounded-md bg-surface-2 px-2 py-1.5">
              <div className="text-muted">India exports</div>
              <div className="font-semibold text-ink atlas-num">{fmtUSD(a.exports)}</div>
            </div>
            <div className="rounded-md bg-surface-2 px-2 py-1.5">
              <div className="text-muted">India imports</div>
              <div className="font-semibold text-ink atlas-num">{fmtUSD(a.imports)}</div>
            </div>
          </div>
          {a.examples?.length ? (
            <div className="mt-3 border-t border-line pt-2">
              <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Examples</div>
              <ul className="space-y-1">
                {a.examples.slice(0, 4).map((e) => (
                  <li key={e.hs6} className="min-w-0 text-[12.5px]">
                    <CodeLink code={e.hs6} label={truncate(e.description, 54)} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Cell colours for a z-score on the diverging ramp (red arm below the average product, blue arm
 * above, no tint within half a standard deviation). Strong ends carry an ink chosen for >= 4.5:1
 * contrast; the colour is never the only cue (the value and a tooltip with the z-score are shown).
 */
function zStyle(z: number | null | undefined, mode: ThemeMode): { backgroundColor: string; color?: string } | undefined {
  if (typeof z !== 'number' || !Number.isFinite(z) || Math.abs(z) < 0.5) return undefined;
  const d = DIVERGING[mode];
  const strongInk = mode === 'light' ? '#ffffff' : '#0b1f3a';
  if (z <= -1.5) return { backgroundColor: d[0], color: strongInk };
  if (z < 0) return { backgroundColor: d[2] };
  if (z < 1.5) return { backgroundColor: d[4] };
  return { backgroundColor: d[6], color: strongInk };
}

function ClusterTable({ clusters }: { clusters: ClusterRow[] }) {
  const { mode } = useTheme();
  const keys = useMemo(() => {
    const present = new Set<string>();
    clusters.forEach((c) => Object.keys(c.centroid ?? {}).forEach((k) => present.add(k)));
    return FEATURES.filter((f) => present.has(f.key));
  }, [clusters]);
  return (
    <Card
      title="Machine-learning clusters (k-means, k = 6)"
      subtitle="Products grouped by the similarity of their trade profile. Each cell is the cluster's typical value; the tint shows how far it sits above (blue) or below (red) the average product."
      actions={<ModelEstimateTag method="k-means, k = 6, random_state = 42, standardised features" />}
      footer={
        <SourceNote provenances={[MODEL_PROVENANCE]}>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded-sm" style={{ backgroundColor: DIVERGING[mode][0] }} aria-hidden />
            well below average
            <span className="ml-2 inline-block h-2.5 w-4 rounded-sm" style={{ backgroundColor: DIVERGING[mode][6] }} aria-hidden />
            well above average (1.5 or more standard deviations)
          </span>
        </SourceNote>
      }
    >
      {clusters.length ? (
        <div className="atlas-scroll-x overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="k-means cluster table (scroll horizontally for all columns)">
          <table className="w-full text-[13px]">
            <caption className="sr-only">k-means clusters with example products and their typical values</caption>
            <thead>
              <tr className="bg-surface-2 text-left text-[11.5px] font-semibold tracking-wide text-ink-2 uppercase">
                <th scope="col" className="px-3 py-2">
                  Cluster
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Products
                </th>
                {keys.map((f) => (
                  <th key={f.key} scope="col" className="px-2 py-2 text-right align-bottom leading-tight">
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clusters.map((c) => (
                <tr key={c.id} className="border-t border-line align-top">
                  <th scope="row" className="w-64 min-w-52 px-3 py-2 text-left font-normal">
                    <div className="font-semibold text-ink">{c.label || `Cluster ${c.id + 1}`}</div>
                    <div className="text-[11.5px] text-muted">Cluster {c.id}</div>
                    {c.examples?.length ? (
                      <div className="mt-1.5 flex flex-col gap-0.5">
                        <span className="text-[10.5px] font-semibold tracking-wider text-muted uppercase">Examples</span>
                        {c.examples.slice(0, 3).map((e) => (
                          <CodeLink key={e.hs6} code={e.hs6} label={truncate(e.description, 34)} className="text-[12px]" />
                        ))}
                      </div>
                    ) : null}
                  </th>
                  <td className="px-3 py-2 text-right atlas-num">
                    {fmtNum(c.n)}
                    {typeof c.n_total === 'number' && c.n_total !== c.n ? <div className="text-[11px] text-muted">of {fmtNum(c.n_total)}</div> : null}
                  </td>
                  {keys.map((f) => {
                    const v = c.centroid?.[f.key];
                    const z = c.z?.[f.key];
                    const zs = zStyle(z, mode);
                    return (
                      <td key={f.key} className="px-1.5 py-1.5 text-right atlas-num">
                        <span
                          className="inline-block min-w-[4.5rem] rounded-md px-1.5 py-0.5 text-ink"
                          style={zs}
                          title={typeof z === 'number' ? `${z >= 0 ? '+' : ''}${z.toFixed(2)} standard deviations from the average product` : undefined}
                        >
                          {typeof v === 'number' ? f.format(v) : '—'}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="py-8 text-center text-sm text-muted">Clusters are not available for this selection.</div>
      )}
    </Card>
  );
}

export function ArchetypesTab({ filters }: { filters: AnalyticsFilters }) {
  const q = useArchetypes(filters);
  return (
    <QueryState query={q} isEmpty={(d) => !d.archetypes.length && !d.clusters.length} emptyTitle="No archetypes for this selection">
      {(d) => (
        <div className="space-y-6">
          <ScoresPendingNote response={d} what="Archetypes and clusters" />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ArchetypeChart rows={d.archetypes} />
            <MethodNote method="Rule archetypes and k-means clusters" className="self-start">
              <p>
                <b>Archetypes</b> are transparent rules on RCA, growth and the import–export balance, applied in order (the first rule that
                matches wins). <b>Clusters</b> are found by k-means on six standardised features and can reveal groupings the rules miss,
                such as fast-growing niche imports.
              </p>
              <p className="mt-2">Both are screening aids for prioritising products, not official classifications.</p>
            </MethodNote>
          </div>
          <ArchetypeCards rows={d.archetypes} />
          <ClusterTable clusters={d.clusters as ClusterRow[]} />
        </div>
      )}
    </QueryState>
  );
}
