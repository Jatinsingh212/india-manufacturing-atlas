/**
 * Demand-supply tab (Opportunity Lab) - GET /api/analytics/demand-supply?chain_id=|sector_id=.
 *
 * Pick a value chain (shares the page's `chain` filter) or a sector. For every item the API returns
 * production, imports, exports, apparent consumption (production + imports − exports) and
 * self-sufficiency. Production is mostly NOT published at HSN level: it is shown as "Not available"
 * unless a figure exists, and apparent consumption is computed by the backend only when production is
 * in value terms (some sources report tonnes or units). The chart therefore plots trade only
 * (one US$ axis) and the table carries production in its own unit with its provenance.
 *
 * The API adds `production_label`, `trade_balance`, `note` (why a figure is not available) and
 * `level` (chain anchor / item / hs6) to the SPEC item shape; they are read as optional fields.
 */
import { useMemo } from 'react';
import { Factory, Scale, Ship, Truck } from 'lucide-react';
import type { DemandSupplyItem } from '@/api/types';
import { useSectorOptions, useValueChains } from '@/api/hooks';
import { Badge, Card, DataTable, EChart, EmptyState, KpiTile, ProvenanceBadge, QueryState, SegmentedControl, Select, StatGrid, Tooltip, type Column } from '@/components';
import { fmtCode, fmtNum, fmtPct, fmtUSD, NA, NA_SHORT, truncate } from '@/lib/format';
import { CATEGORICAL } from '@/lib/theme';
import { useSearchParamState } from '@/lib/hooks';
import { useTheme } from '@/theme/ThemeContext';
import { useDemandSupply } from '../api';
import { groupedHBarOption } from '../shared/chart';
import type { SharedFiltersApi } from '../shared/filters';
import { MethodNote, ProductText, SourceNote, sumOrNull, usd, useTradeProvenance } from '../shared/ui';

const DEFAULT_CHAIN = 'tyre';

/** Demand-supply row as sent by the API (SPEC shape plus optional explanatory fields). */
type DsItem = DemandSupplyItem & {
  production_label?: string | null;
  trade_balance?: number | null;
  note?: string | null;
  level?: 'chain' | 'item' | 'hs6' | string;
};

/**
 * Items whose trade can be summed without double counting. Trade values are HS6-level (SPEC
 * section 4: aggregate distinct hs6), so 8-digit items of the same subheading repeat one value, and a
 * 4-digit item already contains its 6-digit children. Keep one item per HS6 key and drop keys covered
 * by a shorter code that is also present.
 */
function distinctTradeItems(items: readonly DsItem[]): DsItem[] {
  const keyOf = (code: string) => {
    const c = code.replace(/[\s.]/g, '');
    return c.length >= 6 ? c.slice(0, 6) : c;
  };
  const byKey = new Map<string, DsItem>();
  for (const it of items) if (!byKey.has(keyOf(it.code))) byKey.set(keyOf(it.code), it);
  const keys = [...byKey.keys()];
  return keys.filter((k) => !keys.some((o) => o !== k && o.length < k.length && k.startsWith(o))).map((k) => byKey.get(k) as DsItem);
}

/**
 * KPI sub-line for a summed flow. A chain that lists a broad input (e.g. all petroleum oils of HS
 * 2710.19 in the tyre chain) can dominate the total; say so when one code carries most of it.
 */
function flowSub(items: readonly DsItem[], key: 'imports' | 'exports', total: number | null): string {
  const base = 'Distinct HS6 codes, no double counting';
  if (!total || total <= 0) return base;
  const top = items.reduce<DsItem | null>((best, it) => ((it[key] ?? 0) > (best?.[key] ?? 0) ? it : best), null);
  const share = top ? (top[key] ?? 0) / total : 0;
  if (!top || share < 0.5) return base;
  return `${fmtPct(share, { digits: 0 })} from ${fmtCode(top.code)} ${truncate(top.description ?? '', 34)}`;
}

/** Exports minus imports (the API's `trade_balance`, else computed; null when either flow is missing). */
function tradeBalance(r: DsItem): number | null {
  if (typeof r.trade_balance === 'number') return r.trade_balance;
  return r.exports !== null && r.imports !== null ? r.exports - r.imports : null;
}

/** Format a production figure in its own unit ("857,000 tonnes", "$1.2 bn"; compact: "200M units"). */
function fmtProduction(value: number | null, unit: string | null, compact = false): string {
  if (value === null || value === undefined) return NA;
  const u = (unit ?? '').toLowerCase();
  if (u === 'usd' || u === 'us$' || u === '$') return fmtUSD(value);
  return fmtNum(value, { unit: unit ?? undefined, compact: compact && Math.abs(value) >= 1e6 });
}

export function DemandSupplyTab({ shared }: { shared: SharedFiltersApi }) {
  const { mode } = useTheme();
  const trade = useTradeProvenance();
  const chains = useValueChains();
  const sectorOptions = useSectorOptions();
  const [scope, setScope] = useSearchParamState('scope', 'chain');
  const chainId = shared.values.chain || DEFAULT_CHAIN;
  const sectorId = shared.values.sector;
  const bySector = scope === 'sector';
  const params = bySector ? { sector_id: sectorId || undefined } : { chain_id: chainId };
  const q = useDemandSupply(params);

  const chainName = chains.data?.find((c) => c.id === chainId)?.name ?? chainId;
  // While the chain list is unavailable, still show the chain being analysed as the selected chip.
  const chainChips = chains.data?.length ? chains.data.map((c) => ({ id: c.id, name: c.name })) : [{ id: chainId, name: chainName }];

  return (
    <div className="space-y-6">
      <Card padding="sm">
        <div className="flex flex-wrap items-center gap-3 px-1">
          <SegmentedControl
            value={bySector ? 'sector' : 'chain'}
            onChange={(v) => setScope(v)}
            ariaLabel="Scope"
            options={[
              { value: 'chain', label: 'By value chain' },
              { value: 'sector', label: 'By sector' },
            ]}
          />
          {bySector ? (
            <Select
              size="sm"
              className="w-64"
              value={sectorId}
              onChange={(v) => shared.setFilter('sector', v)}
              options={sectorOptions}
              placeholder="Choose a sector"
              aria-label="Sector"
            />
          ) : (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Value chain">
              {chainChips.map((c) => {
                const on = c.id === chainId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => shared.setFilter('chain', c.id)}
                    className={
                      on
                        ? 'h-7 rounded-full border border-brand bg-brand-soft px-3 text-xs font-medium text-brand-ink'
                        : 'h-7 rounded-full border border-line bg-surface px-3 text-xs font-medium text-ink-2 hover:border-line-strong hover:text-ink'
                    }
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {bySector && !sectorId ? (
        <EmptyState title="Choose a sector" message="Pick a sector to compare its domestic production with imports and exports." />
      ) : (
        <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyTitle="No items to compare" emptyMessage="This selection has no products with trade data.">
          {(d) => <DemandSupplyBody items={d.items as DsItem[]} title={bySector ? (sectorOptions.find((s) => s.value === sectorId)?.label ?? sectorId) : chainName} mode={mode} trade={trade} />}
        </QueryState>
      )}
    </div>
  );
}

/**
 * Headline tiles for a value chain: the chain's own product (the API's `level: 'chain'` row, e.g. HS 4011
 * for the tyre chain) - its production in the unit reported, exports and imports - plus the imports of
 * the chain's listed inputs outside that code, which say how much of the supply base comes from abroad.
 */
function AnchorKpis({ anchor, inputs, title, trade }: { anchor: DsItem; inputs: DsItem[]; title: string; trade: ReturnType<typeof useTradeProvenance> }) {
  const inputImports = sumOrNull(inputs.map((i) => i.imports));
  const hasProduction = anchor.production !== null && anchor.production !== undefined;
  const code = fmtCode(anchor.code);
  return (
    <StatGrid cols={4}>
      <KpiTile
        label={`Domestic production · ${title}`}
        value={hasProduction ? fmtProduction(anchor.production, anchor.unit, true) : null}
        icon={Factory}
        accent="ink"
        provenance={anchor.provenance}
        sub={hasProduction ? (anchor.production_label ?? 'As reported') : 'Not published at HSN level'}
        hint={anchor.note ?? undefined}
      />
      <KpiTile label={`Exports · HS ${code}`} value={anchor.exports === null ? null : fmtUSD(anchor.exports)} icon={Truck} accent="brand" provenance={trade} sub={truncate(anchor.description, 48)} />
      <KpiTile label={`Imports · HS ${code}`} value={anchor.imports === null ? null : fmtUSD(anchor.imports)} icon={Ship} provenance={trade} sub={truncate(anchor.description, 48)} />
      <KpiTile
        label={`Imports of inputs from outside HS ${code}`}
        value={inputImports === null ? null : fmtUSD(inputImports)}
        icon={Scale}
        accent="ink"
        provenance={trade}
        sub={flowSub(inputs, 'imports', inputImports)}
        hint="Sum over the distinct HS6 subheadings of the chain's listed raw materials and components that sit outside the chain's own HS code."
      />
    </StatGrid>
  );
}

function DemandSupplyBody({ items, title, mode, trade }: { items: DsItem[]; title: string; mode: 'light' | 'dark'; trade: ReturnType<typeof useTradeProvenance> }) {
  const withProduction = items.filter((i) => i.production !== null && i.production !== undefined).length;
  const withConsumption = items.filter((i) => i.apparent_consumption !== null && i.apparent_consumption !== undefined).length;
  const distinct = useMemo(() => distinctTradeItems(items), [items]);
  const imports = sumOrNull(distinct.map((i) => i.imports));
  const exports = sumOrNull(distinct.map((i) => i.exports));
  // A value chain carries one 'chain' row for its own product; its inputs are the other rows.
  const anchor = items.find((i) => i.level === 'chain') ?? null;
  const inputs = useMemo(() => (anchor ? distinctTradeItems(items.filter((i) => i !== anchor && !i.code.startsWith(anchor.code))) : []), [items, anchor]);
  const top = useMemo(() => [...distinct].sort((a, b) => (b.imports ?? 0) + (b.exports ?? 0) - ((a.imports ?? 0) + (a.exports ?? 0))).slice(0, 14), [distinct]);

  const option = useMemo(
    () =>
      groupedHBarOption({
        categories: top.map((r) => `${fmtCode(r.code)} ${r.description}`),
        fullLabels: top.map((r) => `${fmtCode(r.code)} · ${r.description}`),
        series: [
          { name: 'India imports', values: top.map((r) => r.imports), color: CATEGORICAL[mode][1] },
          { name: 'India exports', values: top.map((r) => r.exports), color: CATEGORICAL[mode][0] },
        ],
        labelMax: 32,
      }),
    [top, mode],
  );

  const columns: Column<DsItem>[] = [
    {
      key: 'code',
      header: 'HS code',
      value: (r) => r.code,
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <span className="font-mono text-[12.5px] atlas-num">{fmtCode(r.code)}</span>
          {r.level === 'chain' ? (
            <Badge tone="navy" size="xs">
              Whole chain
            </Badge>
          ) : null}
        </div>
      ),
      width: 110,
    },
    { key: 'description', header: 'Item', value: (r) => r.description, render: (r) => <ProductText text={r.description} />, width: '26%' },
    {
      key: 'production',
      header: 'Domestic production',
      align: 'right',
      value: (r) => r.production,
      render: (r) =>
        r.production === null || r.production === undefined ? (
          <ProvenanceBadge status="not_available" size="xs" />
        ) : (
          <div className="flex flex-col items-end">
            <span>{fmtProduction(r.production, r.unit)}</span>
            {r.production_label ? <span className="text-[11px] text-muted">{r.production_label}</span> : null}
          </div>
        ),
      csv: (r) => (r.production === null ? null : `${r.production} ${r.unit ?? ''}`.trim()),
    },
    { key: 'imports', header: 'Imports', align: 'right', value: (r) => r.imports, render: (r) => usd(r.imports) },
    { key: 'exports', header: 'Exports', align: 'right', value: (r) => r.exports, render: (r) => usd(r.exports) },
    {
      key: 'balance',
      header: 'Trade balance',
      align: 'right',
      value: (r) => tradeBalance(r),
      render: (r) => fmtUSD(tradeBalance(r), { signed: true, na: NA_SHORT }),
      hint: 'Exports minus imports (US$). Negative values mean India is a net importer.',
      hideBelow: 'lg',
    },
    {
      key: 'consumption',
      header: 'Apparent consumption',
      align: 'right',
      value: (r) => r.apparent_consumption,
      render: (r) => (r.apparent_consumption === null || r.apparent_consumption === undefined ? <span className="text-muted">{NA_SHORT}</span> : usd(r.apparent_consumption)),
      hint: 'Production + imports − exports. Needs production in value terms, otherwise not available.',
    },
    {
      key: 'self',
      header: 'Self-sufficiency',
      align: 'right',
      value: (r) => r.self_sufficiency,
      render: (r) => (r.self_sufficiency === null || r.self_sufficiency === undefined ? <span className="text-muted">{NA_SHORT}</span> : fmtPct(r.self_sufficiency)),
      hint: 'Production ÷ apparent consumption.',
    },
    {
      key: 'prov',
      header: 'Production status',
      csv: (r) => r.provenance?.status ?? null,
      render: (r) =>
        r.note ? (
          <Tooltip content={r.note}>
            <span className="inline-flex">
              <ProvenanceBadge provenance={r.provenance} size="xs" />
            </span>
          </Tooltip>
        ) : (
          <ProvenanceBadge provenance={r.provenance} size="xs" />
        ),
    },
  ];

  return (
    <div className="space-y-6">
      {anchor ? (
        <AnchorKpis anchor={anchor} inputs={inputs} title={title} trade={trade} />
      ) : (
        <StatGrid cols={4}>
          <KpiTile
            label={`Imports · ${title}`}
            value={imports === null ? null : fmtUSD(imports)}
            icon={Ship}
            provenance={trade}
            sub={flowSub(distinct, 'imports', imports)}
            hint="Sum over the distinct HS6 subheadings of the selection; a 4-digit item already contains its subheadings."
          />
          <KpiTile
            label={`Exports · ${title}`}
            value={exports === null ? null : fmtUSD(exports)}
            icon={Truck}
            accent="brand"
            provenance={trade}
            sub={flowSub(distinct, 'exports', exports)}
            hint="Sum over the distinct HS6 subheadings of the selection; a 4-digit item already contains its subheadings."
          />
          <KpiTile
            label="Items with production data"
            value={`${fmtNum(withProduction)} / ${fmtNum(items.length)}`}
            icon={Factory}
            accent="ink"
            sub={withProduction ? 'UNIDO INDSTAT, Rubber Board, ATMA or ministry uploads' : 'Not yet reported at HSN level'}
            status={withProduction ? 'verified' : 'not_available'}
          />
          <KpiTile
            label="Apparent consumption computable"
            value={`${fmtNum(withConsumption)} / ${fmtNum(items.length)}`}
            icon={Scale}
            accent="ink"
            sub="Needs production in value terms"
            status={withConsumption ? 'verified' : 'not_available'}
          />
        </StatGrid>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title={`Trade by item · ${title}`} subtitle="India's imports and exports per distinct HS code (US$, latest year). Production is in the table, in its own unit.">
          <EChart option={option} height={Math.max(260, top.length * 40 + 40)} ariaLabel="Imports and exports by value-chain item" />
        </Card>
        <MethodNote title="Why production is often not available" estimate={false} className="self-start">
          <p>
            India does not publish production at the 8-digit HSN level. The Atlas shows a production figure only when one is on record (UNIDO
            INDSTAT, the Rubber Board, ATMA or a ministry upload through the Data Hub) and otherwise says <b>Not available</b>, never zero.
          </p>
          <p className="mt-2">
            <b>Apparent consumption</b> = production + imports − exports and <b>self-sufficiency</b> = production ÷ consumption are computed only
            when production is in value terms. Figures in tonnes or units are shown as reported.
          </p>
          <p className="mt-2">
            In this selection, <b>{fmtNum(withProduction)}</b> of {fmtNum(items.length)} items {withProduction === 1 ? 'has' : 'have'} a production figure and apparent consumption
            can be computed for <b>{fmtNum(withConsumption)}</b>.
          </p>
        </MethodNote>
      </div>

      <Card title="Demand–supply balance" subtitle="Domestic production against trade for each item" footer={<SourceNote provenances={[trade]}>{withProduction ? <span>Production: as reported, see each row.</span> : null}</SourceNote>}>
        <DataTable columns={columns} rows={items} rowKey={(r, i) => `${r.code}-${i}`} csvFilename="atlas-demand-supply" dense />
      </Card>
    </div>
  );
}
