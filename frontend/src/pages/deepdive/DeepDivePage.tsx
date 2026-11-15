/**
 * DeepDivePage - `/deep-dive/:hs4`, one HS heading drilled from country to 8-digit line (GET /api/deep-dive/{hs4}):
 *
 *   India -> sector -> heading (e.g. 9506 sports goods) -> every 6-digit subheading -> its 8-digit lines
 *
 * Tabs: Products (imports, exports, world trade, tariffs, standards, clusters per subheading; click a row for the
 * 8-digit lines), Export readiness (score per subheading x destination market, with a what-if on the additional
 * duty a market charges Indian goods), Clusters & land (Cluster Observatory register + India Industrial Land Bank),
 * Standards (QCO / ISI / Hallmark in India, CE / CPSIA / federation approvals abroad) and Value chain.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BadgeCheck,
  ExternalLink,
  Factory,
  FileText,
  Gauge,
  Globe2,
  Layers,
  MapPinned,
  Network,
  Scale,
  Search,
  Workflow,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  CodeLink,
  DataTable,
  EmptyState,
  ErrorState,
  KpiTile,
  LoadingBlock,
  PageHeader,
  ProvenanceBadge,
  SegmentedControl,
  StatGrid,
  Tabs,
  type BadgeTone,
  type Column,
  type TabDef,
} from '@/components';
import { fmtPct, fmtRate, fmtRatio, fmtUSD } from '@/lib/format';
import { routes } from '@/lib/routes';
import {
  useDeepDive,
  useReadiness,
  useSyncStatus,
  useUpdateMarket,
  type DdCluster,
  type DdLand,
  type DdLine,
  type DdMarket,
  type DdStandard,
  type DdSubheading,
  type ReadinessBand,
  type ReadinessCell,
  type ReadinessComponent,
} from './api';

type View = 'products' | 'readiness' | 'clusters' | 'standards' | 'chain';

const TABS: TabDef<View>[] = [
  { id: 'products', label: 'Products', icon: Layers },
  { id: 'readiness', label: 'Export readiness', icon: Gauge },
  { id: 'clusters', label: 'Clusters & land', icon: MapPinned },
  { id: 'standards', label: 'Standards', icon: BadgeCheck },
  { id: 'chain', label: 'Value chain', icon: Workflow },
];

const BAND: Record<ReadinessBand, { label: string; tone: BadgeTone; cell: string }> = {
  ready: { label: 'Ready', tone: 'success', cell: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  emerging: { label: 'Emerging', tone: 'warning', cell: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  not_ready: { label: 'Not ready', tone: 'danger', cell: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
};

const STANDARD_TONE: Record<DdStandard['status'], BadgeTone> = {
  mandatory: 'danger',
  voluntary: 'info',
  not_applicable: 'neutral',
  none_found: 'outline',
};

const COMPONENT_LABEL: Record<ReadinessComponent, string> = {
  demand: 'Demand',
  competitiveness: 'Competitiveness',
  tariff: 'Tariff',
  compliance: 'Compliance',
  capability: 'Capability',
};

export const DEFAULT_KEY = 'sports_equipment';

const hs6Dotted = (c: string) => `${c.slice(0, 4)}.${c.slice(4, 6)}`;
const label = (s: string) => s.replace(/_/g, ' ');

export default function DeepDivePage() {
  const { hs4 = DEFAULT_KEY } = useParams();
  const navigate = useNavigate();
  const query = useDeepDive(hs4);
  const [jump, setJump] = useState('');

  if (query.isPending) return <LoadingBlock label="Loading the deep-dive" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const d = query.data;
  const k = d.kpis;
  const basket = d.kind === 'basket' ? d.basket : null;
  const headings = [...new Map(d.subheadings.map((s) => [s.hs4, s.heading ?? s.hs4])).entries()];

  const search = (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const code = jump.replace(/\D/g, '').slice(0, 4);
        if (code.length === 4) navigate(routes.deepDive(code));
        else if (/^[a-z_]+$/i.test(jump.trim())) navigate(routes.deepDive(jump.trim().toLowerCase()));
      }}
    >
      <input
        value={jump}
        onChange={(e) => setJump(e.target.value)}
        placeholder="Another heading, e.g. 9503"
        inputMode="numeric"
        className="h-9 w-48 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
        aria-label="Open another HS heading"
      />
      <Button type="submit" size="sm" variant="secondary" icon={Search}>
        Open
      </Button>
    </form>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={basket ? basket.name : `${d.heading.code} · ${d.value_chains[0]?.name ?? shortTitle(d.heading.description)}`}
        documentTitle={basket ? `${basket.name} deep-dive` : `HS ${d.heading.code} deep-dive`}
        subtitle={basket ? (basket.source ?? basket.description) : d.heading.description}
        icon={Layers}
        breadcrumbs={[
          { label: d.country.name, to: routes.overview() },
          ...(d.sector ? [{ label: d.sector.name, to: routes.sector(d.sector.id) }] : []),
          ...(d.heading.chapter ? [{ label: `Chapter ${d.heading.chapter.code}` }] : []),
          ...(basket ? [] : [{ label: 'Sports equipment basket', to: routes.deepDive(DEFAULT_KEY) }]),
        ]}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {d.lead_ministry ? <Badge tone="brand">{d.lead_ministry.name}</Badge> : null}
            {basket ? <Badge tone="neutral">{k.n_headings} headings</Badge> : null}
            <Badge tone="neutral">{k.n_subheadings} six-digit {basket ? 'codes' : 'subheadings'}</Badge>
            <Badge tone="neutral">{k.n_lines} eight-digit lines</Badge>
            <ProvenanceBadge provenance={d.provenance.trade} size="xs" />
            {basket
              ? headings.map(([code, name]) => (
                  <Link key={code} to={routes.deepDive(code)} title={name} className="text-xs text-[var(--color-brand)] hover:underline">
                    {code} ›
                  </Link>
                ))
              : null}
          </div>
        }
        actions={search}
      />

      <StatGrid cols={4}>
        <KpiTile label="India's exports" value={fmtUSD(k.india_exports)} icon={ArrowUpFromLine} sub={`${d.year}, sum of subheadings`} />
        <KpiTile label="India's imports" value={fmtUSD(k.india_imports)} icon={ArrowDownToLine} sub={`${d.year}`} />
        <KpiTile
          label="Trade balance"
          value={fmtUSD(k.trade_balance, { signed: true })}
          icon={Scale}
          sub={k.trade_balance != null && k.trade_balance < 0 ? 'Net importer' : 'Net exporter'}
        />
        <KpiTile label="India's share of world exports" value={fmtPct(k.india_world_share)} icon={Globe2} sub={`World trade ${fmtUSD(k.world_trade)}`} />
        {basket ? (
          <KpiTile
            label="World exports (study)"
            value={fmtUSD(k.study_world_exports)}
            icon={FileText}
            sub={`As published in the study; BACI world trade ${fmtUSD(k.world_trade)}`}
          />
        ) : (
          <KpiTile
            label="Domestic production"
            value={k.production ? `${k.production.value} ${k.production.unit}` : null}
            provenance={k.production_provenance}
            icon={Factory}
            sub="No official series at heading level yet"
          />
        )}
        <KpiTile label="Clusters" value={String(k.n_clusters)} icon={MapPinned} sub="Cluster Observatory register" />
      </StatGrid>

      <Tabs tabs={TABS} urlParam="tab" defaultValue="products">
        {(active) =>
          active === 'products' ? (
            <ProductsTab subs={d.subheadings} basket={Boolean(basket)} />
          ) : active === 'readiness' ? (
            <ReadinessTab hs4={d.heading.code} subs={d.subheadings} />
          ) : active === 'clusters' ? (
            <ClustersTab clusters={d.clusters} land={d.land} />
          ) : active === 'standards' ? (
            <StandardsTab standards={d.standards} />
          ) : (
            <ChainTab chains={d.value_chains} hs4={d.heading.code} />
          )
        }
      </Tabs>

      <Card title="Data sources" subtitle={<SyncLine />} icon={FileText}>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {d.sources.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2">
              <span className="min-w-0 truncate">{s.name}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--color-muted)]">
                {s.last_refreshed ? new Date(s.last_refreshed).toLocaleDateString() : null}
                <Badge size="xs" tone={s.status === 'connected' ? 'success' : s.status === 'not_configured' ? 'warning' : 'neutral'}>
                  {label(s.status)}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

const SYNC_LABEL: Record<string, string> = {
  cluster_observatory: 'clusters',
  market_tariffs: 'market tariffs',
  iilb_parks: 'land bank',
};

function SyncLine() {
  const sync = useSyncStatus().data;
  if (!sync) return <>Daily cloud sync</>;
  if (!sync.enabled) return <>Refreshed with the Data Hub connectors (cloud sync not configured on this server)</>;
  const m = sync.manifest;
  if (!m?.updated_at) return <>Daily cloud sync at 04:00 IST: no run yet</>;
  const parts = Object.entries(m.sources).map(([k, v]) => `${SYNC_LABEL[k] ?? k} ${v.status === 'success' ? 'ok' : 'failed'}`);
  return (
    <>
      Daily cloud sync at 04:00 IST · last run {new Date(m.updated_at).toLocaleString()} · {parts.join(', ')}
    </>
  );
}

function shortTitle(desc: string): string {
  const first = desc.split(/[;,(]/)[0].trim();
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

// ---------------------------------------------------------------------------------------------- products

function ProductsTab({ subs, basket }: { subs: DdSubheading[]; basket: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const selected = subs.find((s) => s.hs6 === open) ?? null;
  const columns: Column<DdSubheading>[] = [
    { key: 'hs6', header: 'HS6', sticky: true, value: (r) => r.hs6, render: (r) => <span className="font-mono">{hs6Dotted(r.hs6)}</span> },
    ...(basket
      ? ([
          {
            key: 'category',
            header: 'Category (study)',
            value: (r) => r.category ?? r.description,
            width: 240,
            render: (r) => (
              <span title={r.note ?? r.description}>
                {r.category}
                {r.note ? (
                  <Badge tone="warning" size="xs" className="ml-1.5">
                    No HS 2022 data
                  </Badge>
                ) : null}
              </span>
            ),
          },
          { key: 'hs4', header: 'Heading', value: (r) => r.hs4, render: (r) => <Link to={routes.deepDive(r.hs4)} className="font-mono text-[var(--color-brand)] hover:underline">{r.hs4}</Link> },
          { key: 'study', header: 'World exports (study)', align: 'right', value: (r) => r.study_world_exports ?? null, render: (r) => fmtUSD(r.study_world_exports) },
          { key: 'world', header: 'World trade (BACI)', align: 'right', value: (r) => r.world_trade, render: (r) => fmtUSD(r.world_trade) },
        ] as Column<DdSubheading>[])
      : ([{ key: 'description', header: 'Product', value: (r) => r.description, width: 320 }] as Column<DdSubheading>[])),
    { key: 'x', header: 'Exports', align: 'right', value: (r) => r.india_exports, render: (r) => fmtUSD(r.india_exports) },
    { key: 'm', header: 'Imports', align: 'right', value: (r) => r.india_imports, render: (r) => fmtUSD(r.india_imports) },
    {
      key: 'bal',
      header: 'Balance',
      align: 'right',
      value: (r) => r.trade_balance,
      render: (r) => (
        <span className={r.trade_balance != null && r.trade_balance < 0 ? 'text-rose-600' : 'text-emerald-600'}>
          {fmtUSD(r.trade_balance, { signed: true })}
        </span>
      ),
    },
    { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => fmtRatio(r.rca), hint: 'Revealed comparative advantage; above 1 = India specialises' },
    { key: 'share', header: 'World share', align: 'right', value: (r) => r.india_world_share, render: (r) => fmtPct(r.india_world_share) },
    { key: 'mfn', header: 'India MFN', align: 'right', value: (r) => r.india_mfn, render: (r) => fmtRate(r.india_mfn), hint: 'India applied import tariff (WITS)' },
    { key: 'dest', header: 'Top market', value: (r) => r.top_destination_name, render: (r) => r.top_destination_name ?? '—' },
    {
      key: 'src',
      header: 'Top source',
      value: (r) => r.top_import_source_name,
      render: (r) => (r.top_import_source_name ? `${r.top_import_source_name} (${fmtPct(r.top_import_source_share)})` : '—'),
    },
    { key: 'lines', header: '8-digit', align: 'right', value: (r) => r.lines.length },
    { key: 'cl', header: 'Clusters', align: 'right', value: (r) => r.clusters.length, render: (r) => (r.clusters.length ? <Badge tone="success" size="xs">{r.clusters.length}</Badge> : '—') },
  ];
  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={subs}
        rowKey={(r) => r.hs6}
        onRowClick={(r) => setOpen(r.hs6 === open ? null : r.hs6)}
        isRowSelected={(r) => r.hs6 === open}
        pagination={false}
        csvFilename="deep-dive-subheadings"
        caption={basket ? 'In the study\'s order (largest world exports first). Click a code to see its 8-digit national lines' : 'Click a subheading to see its 8-digit national lines'}
        dense
      />
      {selected ? <LinesCard sub={selected} /> : null}
    </div>
  );
}

function LinesCard({ sub }: { sub: DdSubheading }) {
  const columns: Column<DdLine>[] = [
    { key: 'hsn8', header: 'HSN 8', value: (r) => r.hsn8, render: (r) => <CodeLink code={r.hsn8} /> },
    { key: 'd', header: 'Description', value: (r) => r.description, width: 320 },
    { key: 'min', header: 'Ministry', value: (r) => r.ministry },
    { key: 'x', header: 'Exports', align: 'right', value: (r) => r.india_exports, render: (r) => fmtUSD(r.india_exports) },
    { key: 'm', header: 'Imports', align: 'right', value: (r) => r.india_imports, render: (r) => fmtUSD(r.india_imports) },
    { key: 'ip', header: 'Import policy', value: (r) => r.import_policy },
    { key: 'ep', header: 'Export policy', value: (r) => r.export_policy },
  ];
  return (
    <Card title={`${hs6Dotted(sub.hs6)} · 8-digit lines`} subtitle={sub.description} icon={Layers}>
      {sub.note ? <p className="mb-2 text-sm text-amber-600">{sub.note}</p> : null}
      <DataTable columns={columns} rows={sub.lines} rowKey={(r) => r.hsn8} pagination={false} dense />
      <p className="mt-2 text-xs text-[var(--color-muted)]">Line trade: DGCIS TRADESTAT, latest financial year. Policy: DGFT ITC-HS.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------- readiness

function ReadinessTab({ hs4, subs }: { hs4: string; subs: DdSubheading[] }) {
  const [market, setMarket] = useState<string>('all');
  const [duty, setDuty] = useState<string>('');
  const extra = market !== 'all' && duty.trim() !== '' && Number.isFinite(Number(duty)) ? Number(duty) : null;
  const q = useReadiness(hs4, market === 'all' ? null : market, extra);
  const markets = q.data?.markets ?? [];
  const allMarkets = useReadiness(hs4, null, null).data?.markets ?? markets;

  const byKey = useMemo(() => {
    const m = new Map<string, ReadinessCell>();
    for (const c of q.data?.cells ?? []) m.set(`${c.hs6}|${c.market_id}`, c);
    return m;
  }, [q.data]);

  const options = [{ value: 'all', label: 'All markets' }, ...allMarkets.map((m) => ({ value: m.id, label: m.name }))];
  const current = allMarkets.find((m) => m.id === market) ?? null;

  return (
    <div className="space-y-4">
      <Card
        title="Export readiness by destination market"
        subtitle="0–100: demand 25, India's competitiveness 30, duty faced 25, compliance 10, production capability 10"
        icon={Gauge}
        actions={<SegmentedControl value={market} onChange={(v) => { setMarket(v); setDuty(''); }} options={options} size="xs" ariaLabel="Market" />}
        actionsClassName="max-w-full overflow-x-auto"
      >
        {current ? <MarketPanel market={current} duty={duty} setDuty={setDuty} /> : null}
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <LoadingBlock label="Scoring markets" />
        ) : market === 'all' ? (
          <Heatmap subs={subs} markets={markets} byKey={byKey} onPick={setMarket} />
        ) : (
          <MarketDetail cells={q.data.cells.filter((c) => c.market_id === market)} subs={subs} />
        )}
      </Card>
      <p className="text-xs text-[var(--color-muted)]">
        Duty = the market's MFN rate (WITS / TRAINS) or its trade-agreement rate for India, plus any additional duty the market applies to Indian
        goods. Missing data is left out of the score, never counted as zero. A product India hardly exports anywhere (RCA below 0.1) is capped
        at Not ready.
      </p>
    </div>
  );
}

function Heatmap({
  subs,
  markets,
  byKey,
  onPick,
}: {
  subs: DdSubheading[];
  markets: DdMarket[];
  byKey: Map<string, ReadinessCell>;
  onPick: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-separate border-spacing-1 text-sm">
        <thead>
          <tr>
            <th className="text-left font-medium text-[var(--color-muted)]">Subheading</th>
            {markets.map((m) => (
              <th key={m.id} className="px-1 text-center font-medium">
                <button type="button" className="hover:underline" onClick={() => onPick(m.id)}>
                  {m.name}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.hs6}>
              <td className="max-w-[260px] truncate pr-2" title={s.description}>
                <span className="font-mono">{hs6Dotted(s.hs6)}</span> <span className="text-[var(--color-muted)]">{s.category ?? s.description}</span>
              </td>
              {markets.map((m) => {
                const c = byKey.get(`${s.hs6}|${m.id}`);
                return (
                  <td
                    key={m.id}
                    className={`rounded-md px-2 py-1 text-center tabular-nums ${c?.band ? BAND[c.band].cell : 'text-[var(--color-muted)]'}`}
                    title={
                      c
                        ? `${m.name}: duty ${fmtRate(c.duty)}, market imports ${fmtUSD(c.market_imports)}${c.capped ? ` (capped from ${Math.round(c.uncapped_score ?? 0)}: no export base)` : ''}`
                        : undefined
                    }
                  >
                    {c?.score != null ? Math.round(c.score) : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {(Object.keys(BAND) as ReadinessBand[]).map((b) => (
          <Badge key={b} tone={BAND[b].tone} size="xs">
            {BAND[b].label}
          </Badge>
        ))}
        <span className="text-[var(--color-muted)]">Click a market for the breakdown and a duty what-if.</span>
      </div>
    </div>
  );
}

function MarketPanel({ market, duty, setDuty }: { market: DdMarket; duty: string; setDuty: (v: string) => void }) {
  return (
    <div className="mb-4 grid gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm md:grid-cols-[1fr_auto]">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong>{market.name}</strong>
          {market.agreement ? <Badge tone="success" size="xs">{market.agreement}</Badge> : <Badge tone="neutral" size="xs">No trade agreement in force</Badge>}
          <Badge tone={market.extra_duty_status === 'user_input' ? 'warning' : market.extra_duty_status === 'verified' ? 'success' : 'neutral'} size="xs">
            Additional duty on India {fmtRate(market.extra_duty_pct)}
            {market.extra_duty_status === 'user_input' ? ' · user input, verify' : ''}
          </Badge>
        </div>
        {market.extra_duty_basis ? <p className="text-[var(--color-muted)]">{market.extra_duty_basis}</p> : null}
        {market.note ? <p className="text-[var(--color-muted)]">{market.note}</p> : null}
        {market.source ? <p className="text-xs text-[var(--color-muted)]">Source: {market.source}</p> : null}
        <MarketEditor market={market} />
      </div>
      <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
        What-if: additional duty on India (%)
        <input
          value={duty}
          onChange={(e) => setDuty(e.target.value)}
          placeholder={String(market.extra_duty_pct)}
          inputMode="decimal"
          className="h-9 w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)]"
        />
      </label>
    </div>
  );
}

function MarketEditor({ market }: { market: DdMarket }) {
  const { isAdmin } = useAuth();
  const save = useUpdateMarket();
  const [value, setValue] = useState('');
  if (!isAdmin) return null;
  return (
    <form
      className="flex flex-wrap items-center gap-2 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        const pct = Number(value);
        if (!Number.isFinite(pct)) return;
        save.mutate({
          id: market.id,
          body: {
            agreement: market.agreement,
            pref_rate_pct: market.pref_rate_pct,
            extra_duty_pct: pct,
            extra_duty_status: 'verified',
            extra_duty_basis: market.extra_duty_basis,
            source: market.source,
            as_of: new Date().toISOString().slice(0, 10),
            note: market.note,
          },
        });
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Set verified duty %"
        inputMode="decimal"
        className="h-8 w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
      />
      <Button type="submit" size="xs" variant="secondary" disabled={save.isPending || value.trim() === ''}>
        Save for everyone
      </Button>
      {save.isError ? <span className="text-xs text-rose-600">Could not save</span> : null}
    </form>
  );
}

function MarketDetail({ cells, subs }: { cells: ReadinessCell[]; subs: DdSubheading[] }) {
  const desc = new Map(subs.map((s) => [s.hs6, s.description]));
  const columns: Column<ReadinessCell>[] = [
    { key: 'hs6', header: 'HS6', sticky: true, value: (r) => r.hs6, render: (r) => <span className="font-mono">{hs6Dotted(r.hs6)}</span> },
    { key: 'd', header: 'Product', value: (r) => desc.get(r.hs6) ?? '', width: 280 },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      value: (r) => r.score,
      render: (r) =>
        r.band ? (
          <span className="inline-flex flex-col items-end gap-0.5">
            <Badge tone={BAND[r.band].tone} size="xs">
              {Math.round(r.score ?? 0)} · {BAND[r.band].label}
            </Badge>
            {r.capped ? <span className="text-[10px] text-[var(--color-muted)]">no export base (RCA &lt; 0.1)</span> : null}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'duty',
      header: 'Duty on India',
      align: 'right',
      value: (r) => r.duty,
      render: (r) => (
        <span title={`${r.pref_rate != null ? `Agreement rate ${fmtRate(r.pref_rate)}` : `MFN ${fmtRate(r.mfn_rate)} (${r.mfn_year ?? 'n/a'})`} + additional ${fmtRate(r.extra_duty)}`}>
          {fmtRate(r.duty)}
        </span>
      ),
    },
    { key: 'mfn', header: 'MFN', align: 'right', value: (r) => r.mfn_rate, render: (r) => fmtRate(r.mfn_rate) },
    { key: 'imp', header: 'Market imports', align: 'right', value: (r) => r.market_imports, render: (r) => fmtUSD(r.market_imports) },
    { key: 'ind', header: 'India → market', align: 'right', value: (r) => r.india_exports_to_market, render: (r) => fmtUSD(r.india_exports_to_market) },
    { key: 'rca', header: 'RCA', align: 'right', value: (r) => r.rca, render: (r) => fmtRatio(r.rca) },
    {
      key: 'comp',
      header: 'Components',
      csv: (r) => JSON.stringify(r.components),
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {(Object.keys(COMPONENT_LABEL) as ReadinessComponent[]).map((c) => (
            <span key={c} className="rounded bg-[var(--color-surface-2,rgba(0,0,0,0.04))] px-1.5 py-0.5 text-[11px]" title={COMPONENT_LABEL[c]}>
              {COMPONENT_LABEL[c].slice(0, 4)} {r.components[c] == null ? '—' : Math.round(r.components[c] as number)}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: 'std',
      header: 'Mandatory standards',
      value: (r) => r.mandatory_standards.join('; '),
      render: (r) => (r.mandatory_standards.length ? r.mandatory_standards.join('; ') : 'None found'),
      width: 220,
    },
  ];
  return <DataTable columns={columns} rows={cells} rowKey={(r) => `${r.hs6}|${r.market_id}`} pagination={false} defaultSort={{ key: 'score', order: 'desc' }} csvFilename="export-readiness" dense />;
}

// ---------------------------------------------------------------------------------------------- clusters

function ClustersTab({ clusters, land }: { clusters: DdCluster[]; land: DdLand }) {
  const columns: Column<DdCluster>[] = [
    { key: 'name', header: 'Cluster', sticky: true, value: (r) => r.name },
    { key: 'state', header: 'State', value: (r) => r.state },
    {
      key: 'district',
      header: 'District',
      value: (r) => r.district ?? null,
      render: (r) =>
        r.district ? (
          <span title={r.district_source === 'name' ? 'Inferred from the cluster name' : 'Cluster Observatory district filter'}>
            {r.district}
            {r.district_source === 'name' ? <span className="text-[var(--color-muted)]"> *</span> : null}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'products', header: 'Products', value: (r) => [r.products, r.detail].filter(Boolean).join(' — '), width: 280 },
    {
      key: 'inputs',
      header: 'Input clusters in the district',
      width: 260,
      value: (r) => (r.nearby ?? []).filter((n) => n.inputs.length).map((n) => n.name).join('; '),
      render: (r) => {
        const near = r.nearby ?? [];
        const inputs = near.filter((n) => n.inputs.length);
        const others = near.length - inputs.length;
        if (!near.length) return '—';
        return (
          <div className="flex flex-wrap gap-1">
            {inputs.map((n) => (
              <Badge
                key={n.id}
                tone={n.inputs.some((i) => i.level === 'direct') ? 'success' : 'info'}
                size="xs"
                title={`Supplies: ${[...new Set(n.inputs.map((i) => i.item))].join(', ')}${n.inputs.every((i) => i.level === 'related') ? ' (chapter-level match)' : ''}`}
              >
                {n.name}
              </Badge>
            ))}
            {others > 0 ? (
              <span className="text-xs text-[var(--color-muted)]" title={near.filter((n) => !n.inputs.length).map((n) => n.name).join(', ')}>
                +{others} other cluster{others > 1 ? 's' : ''}
              </span>
            ) : null}
          </div>
        );
      },
    },
    { key: 'hs', header: 'HS mapping', value: (r) => r.hs_prefixes.join(', '), render: (r) => <span className="font-mono text-xs">{r.hs_prefixes.join(', ')}</span> },
    {
      key: 'pdf',
      header: 'Diagnostic study',
      csv: (r) => r.profile_url ?? '',
      render: (r) =>
        r.profile_url ? (
          <a href={r.profile_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--color-brand)] hover:underline">
            PDF <ExternalLink className="size-3" />
          </a>
        ) : (
          '—'
        ),
    },
    { key: 'origin', header: 'Source', value: (r) => (r.origin === 'cluster_observatory' ? 'Cluster Observatory' : 'Atlas value chain') },
  ];
  return (
    <div className="space-y-4">
      <Card title="Manufacturing clusters" subtitle="Cluster Observatory register (scraped daily); HS mapping curated by the Atlas" icon={MapPinned}>
        {clusters.length ? (
          <DataTable columns={columns} rows={clusters} rowKey={(r) => r.id} pagination={false} csvFilename="clusters" dense />
        ) : (
          <EmptyState icon={MapPinned} title="No clusters mapped to this heading" message="Refresh the Cluster Observatory source in the Data Hub." compact />
        )}
      </Card>
      <LandCard land={land} />
    </div>
  );
}

function LandCard({ land }: { land: DdLand }) {
  const ha = (v: number | null | undefined) => (v == null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`);
  return (
      <Card
        title="Industrial land near the clusters"
        subtitle={`India Industrial Land Bank park report${land.last_refreshed ? ` · refreshed ${new Date(land.last_refreshed).toLocaleDateString()}` : ''}`}
        icon={Factory}
      >
        {land.status === 'not_configured' ? (
          <div className="space-y-2 text-sm">
            <Badge tone="warning" size="xs">Not configured</Badge>
            <p className="text-[var(--color-muted)]">
              The Land Bank API issues access tokens to state industrial agencies. Once a token is set on the server, parks, available land and
              vacant plots in the cluster states appear here.
            </p>
            <p className="text-[var(--color-muted)]">Cluster states: {land.cluster_states.join(', ') || '—'}</p>
            <a href="https://indiaindustriallandbank.gov.in" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--color-brand)] hover:underline">
              Open the Land Bank portal <ExternalLink className="size-3" />
            </a>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {land.by_district.map((d) => (
                <div key={`${d.state}|${d.district}`} className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold">
                        {d.district}, {d.state}
                      </div>
                      <div className="text-xs text-[var(--color-muted)]">{d.clusters.join(', ')}</div>
                    </div>
                    <Badge tone={d.available_ha > 0 ? 'success' : d.parks ? 'warning' : 'neutral'} size="xs">
                      {d.available_ha > 0 ? `${ha(d.available_ha)} free` : d.parks ? 'No free land' : 'No parks listed'}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-[var(--color-muted)]">
                    {d.parks} park{d.parks === 1 ? '' : 's'} · {ha(d.total_ha)} total · {d.parks_with_land} with land available
                  </div>
                  {d.top_parks.length ? (
                    <ul className="mt-2 space-y-1">
                      {d.top_parks.map((p) => (
                        <li key={p.name} className="flex justify-between gap-2 text-xs">
                          <span className="min-w-0 truncate" title={[p.type, p.sector, p.plug_and_play === 'Yes' ? 'plug & play' : null, p.updated ? `updated ${p.updated}` : null].filter(Boolean).join(' · ')}>
                            {p.name}
                          </span>
                          <span className={(p.available_ha ?? 0) > 0 ? 'shrink-0 text-emerald-600' : 'shrink-0 text-[var(--color-muted)]'}>{ha(p.available_ha)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="text-xs text-[var(--color-muted)]">
              State totals:{' '}
              {land.by_state.map((s) => `${s.state} ${s.parks} parks, ${ha(s.available_ha)} free`).join(' · ')}.{' '}
              <a href="https://indiaindustriallandbank.gov.in/exploreParkReport" target="_blank" rel="noreferrer" className="text-[var(--color-brand)] hover:underline">
                Open the park report
              </a>
            </div>
          </div>
        )}
      </Card>
  );
}

// ---------------------------------------------------------------------------------------------- standards

function StandardsTab({ standards }: { standards: DdStandard[] }) {
  const columns: Column<DdStandard>[] = [
    { key: 'market', header: 'Market', sticky: true, value: (r) => r.market_name },
    { key: 'scheme', header: 'Scheme', value: (r) => r.scheme },
    { key: 'name', header: 'Requirement', value: (r) => r.name, width: 300 },
    { key: 'status', header: 'Status', value: (r) => r.status, render: (r) => <Badge tone={STANDARD_TONE[r.status]} size="xs">{label(r.status)}</Badge> },
    { key: 'hs', header: 'Applies to', value: (r) => r.hs_prefix, render: (r) => <span className="font-mono text-xs">{r.hs_prefix}</span> },
    { key: 'body', header: 'Authority', value: (r) => r.body },
    {
      key: 'ver',
      header: 'Checked',
      value: (r) => (r.verified ? 'verified' : 'to verify'),
      render: (r) => <Badge tone={r.verified ? 'success' : 'warning'} size="xs">{r.verified ? 'Verified' : 'To verify'}</Badge>,
    },
    {
      key: 'url',
      header: '',
      csv: (r) => r.url ?? '',
      render: (r) =>
        r.url ? (
          <a href={r.url} target="_blank" rel="noreferrer" title={r.note ?? undefined} className="text-[var(--color-brand)]">
            <ExternalLink className="size-3.5" />
          </a>
        ) : null,
    },
  ];
  return (
    <Card title="Standards and conformity" subtitle="QCO, ISI and Hallmark in India; mandatory marks and federation approvals abroad" icon={BadgeCheck}>
      <DataTable columns={columns} rows={standards} rowKey={(r) => String(r.id)} pagination={false} csvFilename="standards" dense />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------- value chain

function ChainTab({ chains, hs4 }: { chains: { id: string; name: string; title: string }[]; hs4: string }) {
  if (!chains.length)
    return <EmptyState icon={Workflow} title={`No curated value chain for ${hs4} yet`} message="Add one to data/curated/value_chains.json and rebuild." />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {chains.map((c) => (
        <Card key={c.id} title={c.title} subtitle="Raw materials → components → finished goods, with ministries and trade per item" icon={Workflow}>
          <div className="flex flex-wrap gap-2">
            <Link to={routes.valueChain(c.id)}>
              <Button size="sm" icon={Workflow}>Open value chain</Button>
            </Link>
            <Link to={routes.network({ chain: c.id })}>
              <Button size="sm" variant="secondary" icon={Network}>Network view</Button>
            </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}
