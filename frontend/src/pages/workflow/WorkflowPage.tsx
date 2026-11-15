/**
 * WorkflowPage - `/workflow/:chainId?product=<hs>`: one finished product's whole story, top to bottom.
 *
 *   Watch-outs  ->  1 The product  ->  2 Who makes it, where  ->  3 What it is made from  ->
 *   4 How other countries compare  ->  5 Standards  ->  6 Export markets (duty gap and margin flags)
 *
 * Every step opens with one plain-language sentence and then the detail. Data: GET /api/workflow/{chain_id}.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  AlertTriangle,
  BadgeCheck,
  ChevronDown,
  ExternalLink,
  Factory,
  Globe2,
  Info,
  Layers,
  MapPinned,
  Package,
  Ship,
  type LucideIcon,
} from 'lucide-react';
import { Badge, Card, CodeLink, CountryBars, EmptyState, ErrorState, LoadingBlock, Select, type BadgeTone } from '@/components';
import { fmtOrdinal, fmtPct, fmtRate, fmtRatio, fmtUSD } from '@/lib/format';
import { routes } from '@/lib/routes';
import {
  useWorkflow,
  useWorkflowChains,
  type Severity,
  type WatchOut,
  type WfCluster,
  type WfInput,
  type WfMarket,
  type WfStandard,
  type Workflow,
} from './api';

const STEPS = [
  { id: 'product', n: 1, label: 'The product', icon: Package },
  { id: 'made_by', n: 2, label: 'Who makes it', icon: Factory },
  { id: 'inputs', n: 3, label: 'Made from', icon: Layers },
  { id: 'competition', n: 4, label: 'World', icon: Globe2 },
  { id: 'standards', n: 5, label: 'Standards', icon: BadgeCheck },
  { id: 'markets', n: 6, label: 'Export markets', icon: Ship },
] as const;

const SEVERITY: Record<Severity, { tone: BadgeTone; label: string; dot: string }> = {
  high: { tone: 'danger', label: 'High', dot: 'bg-rose-500' },
  medium: { tone: 'warning', label: 'Medium', dot: 'bg-amber-500' },
  low: { tone: 'neutral', label: 'Note', dot: 'bg-slate-400' },
};

const fy = (year: number | null | undefined) => (year ? `FY${year}-${String(year + 1).slice(-2)}` : '');
const hsDotted = (c: string) => (c.length >= 6 ? `${c.slice(0, 4)}.${c.slice(4, 6)}${c.length > 6 ? `.${c.slice(6)}` : ''}` : c);

export default function WorkflowPage() {
  const { chainId = 'sports_goods' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const product = params.get('product');
  const chains = useWorkflowChains();
  const query = useWorkflow(chainId, product);

  if (query.isPending) return <LoadingBlock label="Building the product workflow" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const w = query.data;
  const p = w.product;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Picker + title */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-semibold uppercase tracking-wider text-brand-ink">Product workflow</span>
          <span>·</span>
          <Link to={routes.valueChain(w.chain.id)} className="hover:underline">
            {w.chain.title}
          </Link>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight text-ink sm:text-3xl">{p.name}</h1>
            <p className="mt-1 text-sm text-muted">
              HSN <CodeLink code={p.hsn8 ?? p.hs_code} /> · {p.description}
            </p>
          </div>
          <Select
            size="sm"
            label="Value chain"
            value={chainId}
            onChange={(v) => v && navigate(`/workflow/${v}`)}
            options={(chains.data ?? [{ id: chainId, name: w.chain.name, title: w.chain.title, products: [] }]).map((c) => ({ value: c.id, label: c.name }))}
          />
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Finished product">
          {w.products.map((x) => {
            const active = x.hs_code === p.hs_code;
            return (
              <button
                key={x.hs_code}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setParams({ product: x.hs_code })}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  active ? 'border-brand bg-brand text-white' : 'border-line bg-surface text-ink-2 hover:border-brand/50'
                }`}
              >
                {x.name}
              </button>
            );
          })}
        </div>
      </header>

      {/* Step bar */}
      <nav className="sticky top-0 z-10 -mx-1 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface/95 p-1 backdrop-blur" aria-label="Workflow steps">
        {STEPS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2">
            <span className="grid size-5 place-items-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-ink">{s.n}</span>
            {s.label}
          </a>
        ))}
      </nav>

      <WatchOuts key={`${w.chain.id}|${p.hs_code}`} items={w.watch_outs} />
      <ProductStep w={w} />
      <MadeByStep w={w} />
      <InputsStep w={w} />
      <CompetitionStep w={w} />
      <StandardsStep w={w} />
      <MarketsStep w={w} />

      <p className="text-xs text-muted">
        <Info className="mr-1 inline size-3.5" />
        {w.method.tax} {w.method.margin} Trade: DGCIS TRADESTAT (India, 8-digit) and CEPII BACI {p.year} (world, HS6).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- shared bits

function Step({ id, n, icon: Icon, title, lead, children }: { id: string; n: number; icon: LucideIcon; title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16">
      <Card padding="lg">
        <div className="mb-4 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-ink">
            <Icon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Step {n}</div>
            <h2 className="text-lg font-bold leading-snug text-ink">{title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">{lead}</p>
          </div>
        </div>
        {children}
      </Card>
    </section>
  );
}

function Fact({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-bold leading-tight ${tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-rose-600' : 'text-ink'}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

const STEP_LABEL: Record<WatchOut['step'], string> = Object.fromEntries(STEPS.map((s) => [s.id, s.label])) as Record<WatchOut['step'], string>;

function WatchOutItem({ f, tag }: { f: WatchOut; tag?: boolean }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${SEVERITY[f.severity].dot}`} />
      <a href={`#${f.step}`} className="min-w-0 hover:underline">
        <span className="font-semibold text-ink">{f.title}.</span> <span className="text-ink-2">{f.detail}</span>
        {tag ? <span className="ml-1.5 whitespace-nowrap text-[11px] text-muted">· {STEP_LABEL[f.step]}</span> : null}
      </a>
    </li>
  );
}

function WatchOuts({ items }: { items: WatchOut[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const important = items.filter((i) => i.severity !== 'low').slice(0, 6);
  const shown = important.length ? important : items.slice(0, 4);
  const rest = items.filter((i) => !shown.includes(i));
  return (
    <Card padding="md" className="border-amber-300/60">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="size-4 text-amber-600" />
        <h2 className="text-sm font-bold text-ink">Watch-outs</h2>
        <span className="text-xs text-muted">what needs attention for this product</span>
      </div>
      <ul className="space-y-1.5">
        {shown.map((f, i) => (
          <WatchOutItem key={i} f={f} />
        ))}
      </ul>
      {rest.length ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="watch-outs-more"
            className="mt-2.5 inline-flex items-center gap-1 rounded-md text-xs font-medium text-brand-ink hover:underline"
          >
            <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            {open ? 'Hide' : 'Show'} {rest.length} smaller note{rest.length > 1 ? 's' : ''}
          </button>
          {open ? (
            <ul id="watch-outs-more" className="mt-2 space-y-1.5 border-t border-line pt-2.5">
              {rest.map((f, i) => (
                <WatchOutItem key={i} f={f} tag />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------- 1 product

function ProductStep({ w }: { w: Workflow }) {
  const p = w.product;
  const net = p.balance == null ? null : p.balance >= 0 ? 'net exporter' : 'net importer';
  const level = p.trade_level === 'hsn8' ? `the 8-digit line ${hsDotted(p.hsn8 ?? '')}` : `the subheading ${hsDotted(p.hs6)}`;
  const lead = (
    <>
      In {fy(p.trade_year)} India exported <strong>{fmtUSD(p.exports)}</strong> and imported <strong>{fmtUSD(p.imports)}</strong> ({level}){net ? <>, a <strong>{net}</strong></> : null}.
      {p.india_rank ? (
        <>
          {' '}
          In world trade of {hsDotted(p.hs6)} India ranks <strong>{fmtOrdinal(p.india_rank)}</strong> of {p.n_exporters} exporters.
        </>
      ) : null}
    </>
  );
  return (
    <Step id="product" n={1} icon={Package} title="The product" lead={lead}>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Fact label={`India's exports (${fy(p.trade_year)})`} value={fmtUSD(p.exports)} sub={p.top_destination ? `Top market: ${p.top_destination}` : undefined} />
        <Fact label={`India's imports (${fy(p.trade_year)})`} value={fmtUSD(p.imports)} sub={p.top_import_source ? `Top source: ${p.top_import_source} (${fmtPct(p.top_import_source_share)})` : undefined} />
        <Fact label="Trade balance" value={fmtUSD(p.balance, { signed: true })} tone={p.balance == null ? undefined : p.balance >= 0 ? 'good' : 'bad'} sub={net ?? undefined} />
        <Fact label="India's world rank" value={p.india_rank ? fmtOrdinal(p.india_rank) : '—'} sub={`of ${p.n_exporters ?? '—'} exporters · ${fmtPct(p.india_world_share)} share`} />
        <Fact label="World trade (HS6)" value={fmtUSD(p.world_trade)} sub={p.world_cagr != null ? `${fmtPct(p.world_cagr, { signed: true })} a year` : undefined} />
        <Fact label="Competitiveness (RCA)" value={fmtRatio(p.rca)} sub={p.rca == null ? undefined : p.rca >= 1 ? 'India is specialised' : 'below 1: not specialised'} tone={p.rca == null ? undefined : p.rca >= 1 ? 'good' : undefined} />
        <Fact label="India's import duty (BCD)" value={fmtRate(p.tax.import_duty_bcd)} sub={`WITS ${p.tax.import_duty_year ?? ''} · GST not in data`} />
        <Fact
          label="DGFT trade policy"
          value={<span className="text-base">{p.dgft_policy.import ?? '—'} / {p.dgft_policy.export ?? '—'}</span>}
          sub="import / export"
        />
      </div>
      {p.ministries.length ? (
        <p className="mt-3 text-xs text-muted">Responsible ministry: {p.ministries.map((m) => m.name).join(', ')}</p>
      ) : null}
    </Step>
  );
}

// ---------------------------------------------------------------------------------------------- 2 made by

const MATCH: Record<WfCluster['match'], { label: string; tone: BadgeTone }> = {
  product: { label: 'Makes this product', tone: 'success' },
  family: { label: 'Same product family', tone: 'info' },
  chain: { label: 'Value-chain cluster', tone: 'neutral' },
  industry: { label: 'Broad industry', tone: 'outline' },
};

function MadeByStep({ w }: { w: Workflow }) {
  const { manufacturers, clusters, land } = w.made_by;
  const main = clusters.filter((c) => c.match !== 'industry');
  const broad = clusters.filter((c) => c.match === 'industry');
  const places = main.map((c) => c.district || c.state).filter(Boolean);
  const lead = main.length ? (
    <>
      Made mainly in <strong>{[...new Set(places)].join(', ')}</strong>
      {manufacturers.length ? <> by producers such as {manufacturers.slice(0, 3).map((m) => m.name).join(', ')}</> : null}.
    </>
  ) : (
    <>No cluster for this exact product is registered{manufacturers.length ? <>; known producers include {manufacturers.slice(0, 3).map((m) => m.name).join(', ')}</> : null}.</>
  );
  const landBy = new Map(land.by_district.map((d) => [d.district.toLowerCase(), d]));
  return (
    <Step id="made_by" n={2} icon={Factory} title="Who makes it, and where" lead={lead}>
      {manufacturers.length ? (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <span className="mr-1 text-xs font-medium text-muted">Manufacturers</span>
          {manufacturers.map((m) => (
            <Badge key={m.name} tone="brand" size="sm">
              {m.name}
            </Badge>
          ))}
        </div>
      ) : null}
      {main.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {main.map((c) => {
            const l = c.district ? landBy.get(c.district.toLowerCase()) : undefined;
            const inputs = (c.nearby ?? []).filter((n) => n.inputs.length);
            return (
              <div key={c.id} className="rounded-xl border border-line p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-ink">{c.name}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                      <MapPinned className="size-3.5" />
                      {[c.district, c.state].filter(Boolean).join(', ') || '—'}
                    </div>
                  </div>
                  <Badge tone={MATCH[c.match].tone} size="xs">
                    {MATCH[c.match].label}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-ink-2">{[c.products, c.detail].filter(Boolean).join(' — ')}</p>
                <dl className="mt-2 space-y-1 text-xs">
                  {inputs.length ? (
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 text-muted">Suppliers nearby:</dt>
                      <dd className="text-ink-2">{inputs.map((n) => n.name).join(', ')}</dd>
                    </div>
                  ) : null}
                  {l ? (
                    <div className="flex gap-1.5">
                      <dt className="shrink-0 text-muted">Industrial land:</dt>
                      <dd className={l.available_ha > 0 ? 'text-emerald-600' : 'text-ink-2'}>
                        {l.parks} parks, {l.available_ha > 0 ? `${l.available_ha.toLocaleString()} ha free` : 'no free land'}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {c.profile_url ? (
                  <a href={c.profile_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-brand-ink hover:underline">
                    Cluster diagnostic study <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={MapPinned} title="No registered cluster for this product" compact />
      )}
      {broad.length ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs text-muted">
            {broad.length} broader industry clusters ({broad[0].products}) — related, not specific to this product
          </summary>
          <p className="mt-2 text-xs text-ink-2">{broad.map((c) => `${c.name} (${c.state})`).join(' · ')}</p>
        </details>
      ) : null}
    </Step>
  );
}

// ---------------------------------------------------------------------------------------------- 3 inputs

const STATUS: Record<WfInput['status'], { label: string; tone: BadgeTone }> = {
  imported: { label: 'Mostly imported', tone: 'danger' },
  exported: { label: 'Mostly exported', tone: 'success' },
  both: { label: 'Both ways', tone: 'neutral' },
  no_data: { label: 'No trade data', tone: 'outline' },
};

function InputsStep({ w }: { w: Workflow }) {
  const s = w.inputs.summary;
  const lead = (
    <>
      {w.chain.name} uses <strong>{s.total}</strong> listed raw materials and components. <strong>{s.imported}</strong> are mostly imported and{' '}
      <strong>{s.exported}</strong> mostly exported{s.china_dependent ? <>; {s.china_dependent} {s.china_dependent === 1 ? 'relies' : 'rely'} on China for over half of its imports</> : null}. Inputs that feed{' '}
      <em>{w.product.name.toLowerCase()}</em> directly are marked.
    </>
  );
  return (
    <Step id="inputs" n={3} icon={Layers} title="What it is made from" lead={lead}>
      <div className="space-y-4">
        {w.inputs.stages.map((st) => (
          <div key={st.stage_id}>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">{st.name}</div>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2">Input</th>
                    <th className="px-3 py-2">HSN</th>
                    <th className="px-3 py-2 text-right">India imports</th>
                    <th className="px-3 py-2 text-right">India exports</th>
                    <th className="px-3 py-2">We…</th>
                    <th className="px-3 py-2 text-right">Import duty</th>
                    <th className="px-3 py-2">Top source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {st.items.map((i) => (
                    <tr key={i.hs_code} className={i.feeds_product === 1 ? 'bg-brand-soft/30' : undefined}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-ink">{i.name}</div>
                        <div className="text-[11px] text-muted">
                          {i.feeds_product === 1 ? 'Direct input to this product' : i.feeds_product ? 'Input via another component' : 'Used elsewhere in the chain'}
                          {i.ministries[0] ? ` · ${i.ministries[0].short_name ?? i.ministries[0].name}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <CodeLink code={i.hs_code} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtUSD(i.india_imports)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtUSD(i.india_exports)}</td>
                      <td className="px-3 py-2">
                        <Badge tone={STATUS[i.status].tone} size="xs">
                          {STATUS[i.status].label}
                        </Badge>
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${i.flags.includes('high_input_duty') ? 'font-semibold text-amber-600' : ''}`}>{fmtRate(i.import_duty_bcd)}</td>
                      <td className="px-3 py-2 text-xs">
                        {i.top_import_source ? `${i.top_import_source} ${fmtPct(i.top_import_source_share)}` : '—'}
                        {i.flags.includes('china_dependent') ? (
                          <Badge tone="warning" size="xs" className="ml-1">
                            China-dependent
                          </Badge>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </Step>
  );
}

// ---------------------------------------------------------------------------------------------- 4 competition

function CompetitionStep({ w }: { w: Workflow }) {
  const c = w.competition;
  const leader = c.world_exporters[0];
  const lead = (
    <>
      {leader ? (
        <>
          <strong>{leader.country}</strong> leads world exports ({fmtPct(leader.share)}).{' '}
        </>
      ) : null}
      India is <strong>{w.product.india_rank ? fmtOrdinal(w.product.india_rank) : 'not ranked'}</strong>
      {c.world_importers[0] ? (
        <>
          ; the biggest buyer is <strong>{c.world_importers[0].country}</strong>
        </>
      ) : null}
      .
    </>
  );
  return (
    <Step id="competition" n={4} icon={Globe2} title="How other countries compare" lead={lead}>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Top exporters (competitors)</h3>
          <CountryBars items={c.world_exporters} limit={10} />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Top importers (markets)</h3>
          <CountryBars items={c.world_importers} limit={10} highlightIso3={null} />
        </div>
        {c.india_destinations.length ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">Where India sells</h3>
            <CountryBars items={c.india_destinations} limit={6} highlightIso3={null} />
          </div>
        ) : null}
        {c.india_sources.length ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">Where India buys from</h3>
            <CountryBars items={c.india_sources} limit={6} highlightIso3={null} />
          </div>
        ) : null}
      </div>
    </Step>
  );
}

// ---------------------------------------------------------------------------------------------- 5 standards

const STD_TONE: Record<WfStandard['status'], BadgeTone> = { mandatory: 'danger', voluntary: 'info', not_applicable: 'neutral', none_found: 'outline' };
const STD_LABEL: Record<WfStandard['status'], string> = { mandatory: 'Mandatory', voluntary: 'Voluntary', not_applicable: 'Not applicable', none_found: 'None in force' };

function StandardRow({ s }: { s: WfStandard }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">
          {s.scheme}: <span className="font-normal">{s.name}</span>
        </div>
        {s.note ? <div className="text-xs text-muted">{s.note}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge tone={STD_TONE[s.status]} size="xs">
          {STD_LABEL[s.status]}
        </Badge>
        {!s.verified ? (
          <Badge tone="warning" size="xs">
            To verify
          </Badge>
        ) : null}
        {s.url ? (
          <a href={s.url} target="_blank" rel="noreferrer" className="text-brand-ink" aria-label={`Source for ${s.name}`}>
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </div>
    </li>
  );
}

function StandardsStep({ w }: { w: Workflow }) {
  const st = w.standards;
  const qco = st.qco_schemes.length > 0 || st.india.some((s) => s.scheme === 'QCO' && s.status === 'mandatory');
  const mandatoryAbroad = st.export_markets.filter((s) => s.status === 'mandatory');
  const lead = (
    <>
      {qco ? <strong>A QCO is in force: the BIS ISI mark is compulsory in India.</strong> : <>No QCO applies in India, so the BIS ISI mark is <strong>voluntary</strong>.</>}{' '}
      {mandatoryAbroad.length ? (
        <>
          Abroad, {mandatoryAbroad.length} market requirement{mandatoryAbroad.length > 1 ? 's are' : ' is'} mandatory ({[...new Set(mandatoryAbroad.map((s) => s.market_name))].join(', ')}).
        </>
      ) : (
        <>No mandatory marking is recorded for the export markets.</>
      )}
    </>
  );
  const groups: [string, WfStandard[]][] = [
    ['In India (QCO / ISI / Hallmark)', st.india],
    ['Export markets', st.export_markets],
    ['Sport federations (buyer requirements)', st.federation],
  ];
  return (
    <Step id="standards" n={5} icon={BadgeCheck} title="Standards required" lead={lead}>
      <div className="grid gap-4 md:grid-cols-3">
        {groups.map(([title, list]) => (
          <div key={title}>
            <h3 className="text-sm font-semibold text-ink">{title}</h3>
            {list.length ? (
              <ul className="divide-y divide-line">
                {list.map((s) => (
                  <StandardRow key={s.id} s={{ ...s, name: s.market_id !== 'in' && s.market_id !== 'global' ? `${s.market_name} — ${s.name}` : s.name }} />
                ))}
              </ul>
            ) : (
              <p className="py-2 text-xs text-muted">None recorded.</p>
            )}
          </div>
        ))}
      </div>
      {st.qco_schemes.length ? (
        <p className="mt-3 text-xs text-ink-2">QCO: {st.qco_schemes.map((q) => q.name).join('; ')}</p>
      ) : null}
    </Step>
  );
}

// ---------------------------------------------------------------------------------------------- 6 markets

const BAND: Record<NonNullable<WfMarket['band']>, { label: string; tone: BadgeTone }> = {
  ready: { label: 'Ready', tone: 'success' },
  emerging: { label: 'Emerging', tone: 'warning' },
  not_ready: { label: 'Not ready', tone: 'danger' },
};

function MarketsStep({ w }: { w: Workflow }) {
  const flagged = useMemo(() => w.markets.filter((m) => m.flags.length), [w.markets]);
  const penalised = w.markets.filter((m) => (m.gap_pts ?? 0) > 0.5);
  const advantaged = w.markets.filter((m) => (m.gap_pts ?? 0) < -0.5);
  const lead = (
    <>
      {penalised.length ? (
        <>
          <strong className="text-rose-600">{penalised.map((m) => m.market).join(', ')}</strong> charge{penalised.length === 1 ? 's' : ''} Indian goods more than competitors.{' '}
        </>
      ) : (
        <>No market charges Indian goods more than competitors. </>
      )}
      {advantaged.length ? (
        <>
          Trade agreements give India a duty advantage in <strong className="text-emerald-600">{advantaged.map((m) => m.market).join(', ')}</strong>.
        </>
      ) : null}
    </>
  );
  return (
    <Step id="markets" n={6} icon={Ship} title="Export markets: duty, margin and readiness" lead={lead}>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Market</th>
              <th className="px-3 py-2 text-right">Duty on India</th>
              <th className="px-3 py-2 text-right">Competitors pay</th>
              <th className="px-3 py-2 text-right">Gap</th>
              <th className="px-3 py-2 text-right">Market size</th>
              <th className="px-3 py-2 text-right">India sells there</th>
              <th className="px-3 py-2">Readiness</th>
              <th className="px-3 py-2">Flag</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {w.markets.map((m) => {
              const worst = m.flags.find((f) => f.severity === 'high') ?? m.flags[0];
              return (
                <tr key={m.market_id} className={m.flags.some((f) => f.severity === 'high') ? 'bg-rose-500/5' : undefined}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{m.market}</div>
                    {m.agreement ? <div className="text-[11px] text-emerald-600">{m.agreement}</div> : null}
                    {m.extra_duty_status === 'user_input' ? <div className="text-[11px] text-amber-600">extra duty: user input, verify</div> : null}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtRate(m.duty_on_india)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink-2">{fmtRate(m.competitor_mfn)}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${(m.gap_pts ?? 0) > 0.5 ? 'text-rose-600' : (m.gap_pts ?? 0) < -0.5 ? 'text-emerald-600' : 'text-muted'}`}>
                    {m.gap_pts == null ? '—' : `${m.gap_pts > 0 ? '+' : ''}${m.gap_pts.toFixed(1)} pts`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtUSD(m.market_imports)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtUSD(m.india_exports_to_market)}</td>
                  <td className="px-3 py-2">
                    {m.band ? (
                      <Badge tone={BAND[m.band].tone} size="xs">
                        {Math.round(m.score ?? 0)} · {BAND[m.band].label}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {worst ? (
                      <span title={m.flags.map((f) => `${f.title}: ${f.detail}`).join('\n')} className={worst.severity === 'high' ? 'font-semibold text-rose-600' : 'text-amber-600'}>
                        {worst.kind === 'margin_risk' ? 'Margin at risk' : worst.kind === 'tariff_penalty' ? 'Tariff penalty' : 'High duty'}
                        {m.flags.length > 1 ? ` +${m.flags.length - 1}` : ''}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {flagged.length ? (
        <ul className="mt-3 space-y-1.5">
          {flagged.flatMap((m) => m.flags).map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${SEVERITY[f.severity].dot}`} />
              <span>
                <span className="font-semibold text-ink">{f.title}.</span> <span className="text-ink-2">{f.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Step>
  );
}
