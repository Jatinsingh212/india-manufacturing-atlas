/**
 * NodePanel - the side panel of the Value-chain Network, with three stat boxes for the selected HSN
 * node:
 *   Production stats  | EXPORT stats  | Demand / Sales stats
 * with today's real figures (CEPII BACI trade, the production table, model scores) and "Not
 * available" wherever the data does not exist (e.g. production at HSN level, GSTN domestic sales).
 *
 * For 8-digit lines the product detail (GET /api/hsn/product/{hsn8}) is loaded to add provenance,
 * production rows, the supplier rank and the top import source. Actions: trace upstream / downstream
 * (GET /api/network/trace), centre the graph on the node, open the product page. When a trace is
 * active the panel lists its critical inputs.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftToLine, ArrowRightToLine, Crosshair, ExternalLink, Factory, ShieldAlert, ShoppingCart, Ship, X } from 'lucide-react';
import { api } from '@/api/client';
import { queryKeys } from '@/api/hooks';
import type { NetworkNode, Provenance, TraceDirection, TraceResponse } from '@/api/types';
import { Badge, Button, CodeLink, ErrorState, MinistryPill, ModelEstimateTag, ProvenanceBadge, ScoreBar, Skeleton, Spinner } from '@/components';
import { fmtCode, fmtNum, fmtOrdinal, fmtPct, fmtRatio, fmtUSD, hsLevelName, humanize, NA, truncate } from '@/lib/format';
import { routeForCode, routes } from '@/lib/routes';
import { CRITICAL_VULNERABILITY } from './graphStyle';

/** The three stat-box colours (production orange, export blue, demand light orange). */
const BOX = {
  production: { bar: '#e8692c', title: 'Production stats', icon: Factory },
  export: { bar: '#3b82d6', title: 'EXPORT stats', icon: Ship },
  demand: { bar: '#f2a27a', title: 'Demand / Sales stats', icon: ShoppingCart },
} as const;

function StatBox({ kind, children }: { kind: keyof typeof BOX; children: ReactNode }) {
  const b = BOX[kind];
  const Icon = b.icon;
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5">
        <span className="h-3.5 w-5 rounded-[3px]" style={{ backgroundColor: b.bar }} aria-hidden />
        <Icon className="size-3.5 text-ink-2" aria-hidden />
        <h4 className="text-[12px] font-semibold tracking-wide text-ink">{b.title}</h4>
      </header>
      <dl className="divide-y divide-line px-3">{children}</dl>
    </section>
  );
}

function Row({ label, value, aside }: { label: ReactNode; value: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]">
      <dt className="text-ink-2">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-right font-semibold text-ink atlas-num">
        <span className="truncate">{value}</span>
        {aside}
      </dd>
    </div>
  );
}

const NA_BADGE = <ProvenanceBadge status="not_available" size="xs" compact />;

/** Production attached to a graph node; the API adds label / source / status to the SPEC's {value, unit}. */
type NodeProduction = NonNullable<NetworkNode['production']> & { label?: string | null; source?: string | null; status?: string | null };

/** Readable production label; the API may send a KPI key such as "india_production". */
function productionLabel(label: string | null | undefined): string {
  if (!label) return 'Domestic production';
  if (label === 'india_production') return "India's production";
  if (label === 'global_production') return 'Global production';
  return /^[a-z0-9_]+$/.test(label) ? humanize(label) : label;
}

export interface NodePanelProps {
  node: NetworkNode;
  chainName: (id: string) => string;
  tradeProvenance: Provenance;
  trace: { direction: TraceDirection; data: TraceResponse | undefined; loading: boolean; error: unknown } | null;
  onTrace: (direction: TraceDirection) => void;
  onClearTrace: () => void;
  onCenter: () => void;
  onClose: () => void;
  onSelectCode: (code: string) => void;
}

export function NodePanel({ node, chainName, tradeProvenance, trace, onTrace, onClearTrace, onCenter, onClose, onSelectCode }: NodePanelProps) {
  const isLine = /^\d{8}$/.test(node.code);
  const detail = useQuery({
    queryKey: queryKeys.product(node.code),
    queryFn: ({ signal }) => api.product(node.code, { signal }),
    enabled: isLine,
    staleTime: 10 * 60 * 1000,
  });
  const p = detail.data;
  const tr = p?.trade ?? null;
  // `top_import_source` is a country id ("aschn"); the API adds the readable name alongside it.
  const topSource = tr ? ((tr as typeof tr & { top_import_source_name?: string | null }).top_import_source_name ?? p?.top_sources?.[0]?.country ?? tr.top_import_source) : null;
  const tradeProv = tr?.provenance ?? tradeProvenance;
  const critical = (node.vulnerability_score ?? -1) >= CRITICAL_VULNERABILITY;
  const share = node.exports !== null && node.world_trade ? node.exports / node.world_trade : null;
  const balance = node.exports !== null && node.imports !== null ? node.exports - node.imports : null;
  const productionRows = (p?.production ?? []).filter((r) => r.value !== null);
  const nodeProd = node.production as NodeProduction | null;
  const loadingDetail = isLine && detail.isPending;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CodeLink code={node.code} />
            <Badge tone="neutral" size="xs">
              {hsLevelName(node.code)}
            </Badge>
            {node.is_center ? (
              <Badge tone="magenta" size="xs">
                Centre
              </Badge>
            ) : null}
            {critical ? (
              <Badge tone="danger" size="xs" icon={ShieldAlert}>
                Critical input
              </Badge>
            ) : null}
          </div>
          <h3 className="mt-1 text-[14.5px] leading-snug font-semibold text-ink">{node.label}</h3>
          {node.description && node.description !== node.label ? <p className="mt-0.5 text-[12px] leading-snug text-muted">{truncate(node.description, 160)}</p> : null}
        </div>
        <button type="button" onClick={onClose} className="-m-1 rounded-md p-1.5 text-muted hover:bg-surface-3 hover:text-ink" aria-label="Close details">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {node.ministry_id ? <MinistryPill size="xs" ministry={{ id: node.ministry_id, short_name: node.ministry_short, color: node.color }} /> : null}
        {(node.chain_ids ?? []).map((c) => (
          <Badge key={c} tone="outline" size="xs">
            {chainName(c)}
          </Badge>
        ))}
      </div>

      <StatBox kind="production">
        {loadingDetail ? (
          <div className="py-2">
            <Skeleton className="h-4 w-full" />
          </div>
        ) : productionRows.length ? (
          productionRows.slice(0, 3).map((r, i) => (
            <Row
              key={i}
              label={`${productionLabel(r.label)}${r.year ? ` (${r.year})` : ''}`}
              value={fmtNum(r.value, { unit: r.unit ?? undefined, compact: (r.value ?? 0) >= 1e6 })}
              aside={<ProvenanceBadge status={r.status} size="xs" compact />}
            />
          ))
        ) : nodeProd && nodeProd.value !== null ? (
          <Row
            label={productionLabel(nodeProd.label)}
            value={fmtNum(nodeProd.value, { unit: nodeProd.unit ?? undefined, compact: nodeProd.value >= 1e6 })}
            aside={<ProvenanceBadge status={nodeProd.status ?? 'not_verified'} size="xs" compact />}
          />
        ) : (
          <Row label="Domestic production" value={<span className="font-medium text-na-ink">{NA}</span>} aside={NA_BADGE} />
        )}
        <div className="py-1.5 text-[11px] leading-snug text-muted">Production is not published at HSN level; figures come from UNIDO INDSTAT, the Rubber Board, ATMA or ministry uploads.</div>
      </StatBox>

      <StatBox kind="export">
        <Row label="India exports" value={fmtUSD(node.exports)} aside={<ProvenanceBadge provenance={tradeProv} size="xs" compact />} />
        <Row label="Revealed comparative advantage" value={fmtRatio(node.rca)} />
        <Row label="India share of world trade" value={fmtPct(share)} />
        {tr ? <Row label="India's rank among suppliers" value={tr.india_supplier_rank ? `${fmtOrdinal(tr.india_supplier_rank)} of ${fmtNum(tr.n_suppliers)}` : NA} /> : null}
        {tr ? <Row label="Export growth (CAGR 2018–24)" value={fmtPct(tr.export_cagr, { signed: true })} /> : null}
      </StatBox>

      <StatBox kind="demand">
        <Row label="World market (global demand)" value={fmtUSD(node.world_trade)} aside={<ProvenanceBadge provenance={tradeProv} size="xs" compact />} />
        <Row label="India imports" value={fmtUSD(node.imports)} aside={<ProvenanceBadge provenance={tradeProv} size="xs" compact />} />
        <Row label="Trade balance" value={fmtUSD(balance, { signed: true })} />
        {tr ? <Row label="Top import source" value={topSource ? `${topSource} · ${fmtPct(tr.top_import_source_share, { digits: 0 })}` : NA} /> : null}
        <Row label="Domestic sales (GSTN)" value={<span className="font-medium text-na-ink">{NA}</span>} aside={NA_BADGE} />
        <div className="py-2">
          <div className="mb-1 flex items-center justify-between text-[12px] text-ink-2">
            <span>Supply-chain vulnerability</span>
            <ModelEstimateTag method="Vulnerability score (SPEC section 4)" />
          </div>
          <ScoreBar value={node.vulnerability_score} scale="risk" size="md" />
        </div>
      </StatBox>

      {detail.isError && isLine ? <div className="text-[11.5px] text-muted">Product details could not be loaded; graph figures are shown.</div> : null}

      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant={trace?.direction === 'upstream' ? 'primary' : 'secondary'} icon={ArrowLeftToLine} onClick={() => onTrace('upstream')}>
          Trace upstream
        </Button>
        <Button size="sm" variant={trace?.direction === 'downstream' ? 'primary' : 'secondary'} icon={ArrowRightToLine} onClick={() => onTrace('downstream')}>
          Trace downstream
        </Button>
        <Button size="sm" variant="ghost" icon={Crosshair} onClick={onCenter} disabled={node.is_center}>
          Centre graph here
        </Button>
        <Button size="sm" variant="ghost" icon={ExternalLink} to={isLine ? routes.product(node.code) : (routeForCode(node.code) ?? undefined)}>
          {isLine ? 'Product page' : 'Explore code'}
        </Button>
      </div>

      {trace ? (
        <section className="rounded-lg border border-line bg-surface-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[12.5px] font-semibold text-ink">
              {trace.direction === 'upstream' ? 'Upstream trace: inputs feeding this product' : 'Downstream trace: products that use it'}
            </h4>
            <button type="button" className="text-[12px] font-medium text-brand-ink hover:underline" onClick={onClearTrace}>
              Clear
            </button>
          </div>
          {trace.loading ? (
            <div className="flex items-center gap-2 py-3 text-[12.5px] text-muted">
              <Spinner /> Tracing paths…
            </div>
          ) : trace.error ? (
            <ErrorState error={trace.error} compact />
          ) : trace.data ? (
            <>
              <p className="mt-1 text-[12px] text-muted">
                {fmtNum(Math.max(0, trace.data.nodes.length - 1))} linked products on {fmtNum(trace.data.edges.length)} links, highlighted in the graph.
              </p>
              <div className="mt-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
                {trace.direction === 'downstream' ? 'Critical products on these paths' : 'Critical inputs'}
              </div>
              {trace.data.critical_inputs.length ? (
                <ul className="mt-1 space-y-2">
                  {trace.data.critical_inputs.map((c) => (
                    <li key={c.code} className="rounded-md border border-line bg-surface px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <button type="button" className="min-w-0 truncate text-left font-mono text-[12.5px] text-brand-ink hover:underline" onClick={() => onSelectCode(c.code)} title="Select in the graph">
                          {fmtCode(c.code)}
                        </button>
                        <span className="shrink-0 text-[11.5px] text-ink-2 atlas-num">{fmtUSD(c.imports)} imports</span>
                      </div>
                      <div className="mt-0.5 text-[12px] leading-snug text-ink">{truncate(c.description, 90)}</div>
                      <ScoreBar value={c.vulnerability_score} scale="risk" className="mt-1" label="Vulnerability" />
                      <div className="mt-1 text-[11.5px] leading-snug text-muted">
                        {c.top_import_source && !c.reason?.includes(c.top_import_source) ? <>Top source {c.top_import_source}. </> : null}
                        {c.reason}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[12px] text-ink-2">
                  Nothing critical on {trace.direction === 'downstream' ? 'these paths' : 'this path'}: no linked product reaches a vulnerability score of{' '}
                  {CRITICAL_VULNERABILITY}.
                </p>
              )}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
