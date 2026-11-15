/**
 * HsnLookupCard - the "Enter HSN Code" card.
 *
 * Input: 8 / 6 / 4 / 2 digits (dots and spaces allowed) or a product name picked from the typeahead.
 * - 8-digit line -> Assigned Ministry, Sector, HS Code, Product label, India's exports to World ($ Mn.),
 *   India's imports from World ($ Mn.), BCD and RCA, with provenance badges and a product-page link.
 * - 2 / 4 / 6 digits -> the HS node, its children (click to drill down) and its 8-digit lines.
 * The entered code is kept in the URL (`?hsn=`), default 61091000.
 */
import { useMemo, useState } from 'react';
import { ArrowUpRight, ChevronRight, CornerLeftUp, Search, SearchX } from 'lucide-react';
import { isApiError, normalizeCode } from '@/api/client';
import type { HsNodeChild, LookupResponse, ProductDetail } from '@/api/types';
import {
  Badge,
  Button,
  Card,
  CodeLink,
  DataTable,
  EmptyState,
  ErrorState,
  HsnSearchBox,
  KeyValueList,
  LoadingBlock,
  MinistryPill,
  ProvenanceBadge,
  SectorPill,
} from '@/components';
import { fmtCode, fmtPct, fmtRatio, fmtUSD, fmtUSDMn, hsLevelName, plural } from '@/lib/format';
import { useSearchParamState } from '@/lib/hooks';
import { routes } from '@/lib/routes';
import { bcdText, distinctLabels, mappingProvenance, MAPPING_SOURCE_LABELS, productColumns, tariffProvenance } from '@/pages/explore/shared';
import { bcdProvenance, type HsNodeWithTrade } from '@/pages/product/extras';
import { isLookupCode, useHsnLookup } from '../api';

export const DEFAULT_LOOKUP_CODE = '61091000';

const EXAMPLES: Array<{ code: string; label: string }> = [
  { code: '61091000', label: 'Cotton T-shirts' },
  { code: '4011', label: 'New pneumatic tyres' },
  { code: '854143', label: 'Solar PV modules' },
  { code: '30', label: 'Pharmaceutical products' },
];

function ProductResult({ p }: { p: ProductDetail }) {
  const primary = p.ministries.find((m) => m.role === 'primary') ?? {
    id: p.ministry_id,
    short_name: p.ministry_short ?? p.ministry_id,
    name: p.ministry_name ?? p.ministry_id,
    color: null,
    role: 'primary',
  };
  const secondary = p.ministries.filter((m) => m.role !== 'primary');
  const tradeProv = p.trade?.provenance ?? { source: 'tradestat', status: 'not_available' as const, label: 'No DGCIS TRADESTAT record', year: 2024 };
  const bcd = bcdText(p);
  const mapProv = p.mapping?.provenance ?? mappingProvenance(p.mapping_source, p.mapping?.status ?? p.mapping_status);

  return (
    <div className="space-y-3">
      <KeyValueList
        labelWidth="44%"
        items={[
          {
            label: 'Assigned Ministry',
            value: (
              <span className="flex flex-wrap items-center gap-1.5">
                <MinistryPill ministry={primary} full />
                {secondary.map((m) => (
                  <MinistryPill key={m.id} ministry={m} role={m.role} size="xs" />
                ))}
              </span>
            ),
            aside: <ProvenanceBadge provenance={mapProv} size="xs" />,
          },
          { label: 'Sector', value: p.sector_id ? <SectorPill sector={{ id: p.sector_id, name: p.sector_name }} /> : 'Not available' },
          { label: 'HS Code', value: <CodeLink code={p.hsn8} style="plain" /> },
          { label: 'Product label', value: <span className="leading-snug">{p.description}</span> },
          {
            label: "India's exports to World ($ Mn.)",
            value: fmtUSDMn(p.exports),
            numeric: true,
            aside: <ProvenanceBadge provenance={tradeProv} compact size="xs" />,
          },
          {
            label: "India's imports from World ($ Mn.)",
            value: fmtUSDMn(p.imports),
            numeric: true,
            aside: <ProvenanceBadge provenance={tradeProv} compact size="xs" />,
          },
          {
            label: 'BCD',
            value: bcd ?? 'Not available',
            numeric: Boolean(bcd),
            aside: <ProvenanceBadge provenance={bcdProvenance(p) ?? tariffProvenance(p)} compact size="xs" />,
          },
          {
            label: 'RCA',
            value: fmtRatio(p.rca),
            numeric: p.rca !== null,
            aside: <ProvenanceBadge provenance={tradeProv} compact size="xs" />,
          },
        ]}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
        <span>
          Mapping: {MAPPING_SOURCE_LABELS[p.mapping_source] ?? p.mapping_source}
          {p.mapping_confidence !== null ? ` · confidence ${fmtPct(p.mapping_confidence, { digits: 0 })}` : ''}
        </span>
        {p.lines_in_hs6 > 1 ? (
          <span>
            Trade values are for subheading {fmtCode(p.hs6)}, shared by {plural(p.lines_in_hs6, 'national line')}.
          </span>
        ) : null}
        <Button to={routes.product(p.hsn8)} size="sm" variant="primary" iconRight={ArrowUpRight} className="ml-auto">
          Open product page
        </Button>
      </div>
    </div>
  );
}

function childNoun(level: number): string {
  return level === 2 ? 'heading' : level === 4 ? 'subheading' : 'national line';
}

function NodeResult({ data, onPick }: { data: Extract<LookupResponse, { type: 'node' }>; onPick: (code: string) => void }) {
  const { children, products } = data;
  const node = data.node as HsNodeWithTrade;
  const trade = node.trade ?? null;
  const columns = useMemo(() => productColumns({ variant: 'compact' }), []);
  // Sibling subheadings usually repeat their heading's words; show what tells them apart.
  const childLabels = useMemo(() => distinctLabels(children.map((c) => c.description), Infinity, false), [children]);
  // For a subheading the children are its 8-digit lines, which the product table already lists.
  const showChildren = node.level < 6 && children.length > 0;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand">{hsLevelName(node.level)}</Badge>
          <CodeLink code={node.code} noLink />
          {node.parent ? (
            <Button size="xs" variant="ghost" icon={CornerLeftUp} onClick={() => onPick(node.parent as string)} className="ml-auto">
              Up to {fmtCode(node.parent)}
            </Button>
          ) : null}
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-ink">{node.description}</p>
        {node.ownership ? (
          <div className="mt-2.5 border-t border-line pt-2.5">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="font-medium text-ink">Guidebook ownership under this code</span>
              <Badge tone={node.ownership.coverage >= 0.8 ? 'success' : node.ownership.coverage >= 0.4 ? 'warning' : 'orange'}>
                {fmtPct(node.ownership.coverage, { digits: 0 })} of national lines mapped
              </Badge>
              <ProvenanceBadge
                provenance={{
                  source: 'dpiit_guidebook',
                  status: 'verified',
                  label: 'Aggregated from the 8-digit lines accepted by the DPIIT Guidebook (16.12.2025)',
                  year: null,
                }}
                size="xs"
              />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {node.ownership.owners.slice(0, 5).map((o) => (
                <MinistryPill key={o.id} ministry={o} role={o.role} size="xs" />
              ))}
              {node.ownership.n_owners > 5 ? <span className="text-[11px] text-muted">+{node.ownership.n_owners - 5} more</span> : null}
              {!node.ownership.owners.length ? <span className="text-[12px] text-muted">No accepted owner under this code.</span> : null}
            </div>
            <p className="mt-1 text-[11px] text-muted">
              {node.ownership.mapped_lines} of {node.ownership.total_lines} national lines are accepted in the Guidebook.
              The leading owner is the ministry with the most directly accepted lines; all owners are listed. This is a
              derived parent-level view, not a separate code-level acceptance.
            </p>
          </div>
        ) : null}
        {trade ? (
          <dl className="mt-2.5 grid grid-cols-3 gap-2 border-t border-line pt-2.5 text-[12px]">
            <div>
              <dt className="text-muted">India exports</dt>
              <dd className="font-semibold text-ink">{fmtUSD(trade.exports)}</dd>
            </div>
            <div>
              <dt className="text-muted">India imports</dt>
              <dd className="font-semibold text-ink">{fmtUSD(trade.imports)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1 text-muted">
                World trade {trade.provenance ? <ProvenanceBadge provenance={trade.provenance} compact size="xs" /> : null}
              </dt>
              <dd className="font-semibold text-ink">{fmtUSD(trade.world_trade)}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      {showChildren ? (
        <div>
          <div className="mb-1 text-xs font-medium text-ink-2">
            Contains {plural(children.length, childNoun(node.level))} · select one to drill down
          </div>
          <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {children.map((c: HsNodeChild, i) => (
              <li key={c.code}>
                <button
                  type="button"
                  onClick={() => onPick(c.code)}
                  title={c.description}
                  className="grid w-full grid-cols-[4.5rem_1fr_auto_1rem] items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-3"
                >
                  <span className="font-mono text-brand-ink atlas-num">{fmtCode(c.code)}</span>
                  <span className="leading-snug text-ink">
                    <span className="line-clamp-2">{childLabels[i]}</span>
                    {c.ownership?.owners?.[0] ? (
                      <span className="mt-0.5 block text-[10.5px] text-muted">
                        {c.ownership.owners[0].short_name} · {fmtPct(c.ownership.coverage, { digits: 0 })} mapped
                        {c.ownership.n_owners > 1 ? ` · +${c.ownership.n_owners - 1}` : ''}
                      </span>
                    ) : c.ownership ? (
                      <span className="mt-0.5 block text-[10.5px] text-muted">No accepted owner</span>
                    ) : null}
                  </span>
                  <span className="text-[11px] whitespace-nowrap text-muted atlas-num">{plural(c.n_products, 'line')}</span>
                  <ChevronRight className="size-3.5 text-muted" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={products}
        rowKey={(r) => r.hsn8}
        dense
        maxHeight={null}
        pagination={{ mode: 'client', pageSize: 5, pageSizeOptions: [5, 10, 25, 50] }}
        emptyTitle="No 8-digit lines under this code"
        caption={`8-digit lines under ${fmtCode(node.code)}`}
        toolbar={<span className="text-xs font-medium text-ink-2">{products.length >= 50 ? 'First 50 national lines' : plural(products.length, 'national line')}</span>}
        toolbarRight={
          <Button to={routes.explore({ q: node.code })} size="sm" variant="secondary" iconRight={ArrowUpRight}>
            Open in Explorer
          </Button>
        }
      />
    </div>
  );
}

export function HsnLookupCard() {
  const [code, setCode] = useSearchParamState('hsn', DEFAULT_LOOKUP_CODE);
  const [inputError, setInputError] = useState<string | null>(null);
  const normalized = normalizeCode(code);
  const valid = isLookupCode(normalized);
  const q = useHsnLookup(normalized);

  const submit = (raw: string) => {
    const c = normalizeCode(raw.trim());
    if (isLookupCode(c)) {
      setInputError(null);
      setCode(c);
    } else if (/^\d+$/.test(c)) {
      setInputError(`"${raw.trim()}" has ${c.length} digits. Enter 2, 4, 6 or 8 digits.`);
    } else {
      setInputError('Enter 2, 4, 6 or 8 digits, or pick a product from the suggestions.');
    }
  };

  const notFound = isApiError(q.error) && q.error.isNotFound;

  return (
    <Card title="Enter HSN code" subtitle="8, 6, 4 or 2 digits - dots and spaces are fine" icon={Search}>
      <div className="space-y-3">
        <HsnSearchBox
          key={normalized}
          defaultValue={valid ? normalized : ''}
          onSelect={(s) => submit(s.hsn8)}
          onSubmit={submit}
          clearOnSelect={false}
          placeholder="e.g. 6109.10.00, 4011 or 'cotton t-shirts'"
          ariaLabel="Enter an HSN code"
        />
        {inputError ? (
          <p className="text-xs text-bad-ink" role="alert">
            {inputError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Try:</span>
          {EXAMPLES.map((e) => (
            <button
              key={e.code}
              type="button"
              onClick={() => submit(e.code)}
              title={e.label}
              className={
                'rounded-full border px-2 py-0.5 font-mono text-[11.5px] transition-colors ' +
                (e.code === normalized ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line bg-surface text-ink-2 hover:border-brand/50 hover:text-ink')
              }
            >
              {fmtCode(e.code)}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[linear-gradient(135deg,#07182f_0%,#0b2140_100%)] px-3.5 py-2.5 text-on-navy">
          <span className="text-[9.5px] font-bold tracking-[0.16em] text-on-navy-muted uppercase">Entered</span>
          <span className="font-mono atlas-num text-[13px] font-semibold text-white">{normalized || 'no code yet'}</span>
        </div>

        {!valid ? (
          <EmptyState compact icon={Search} title="Enter an HSN code to look it up" message="Results show the owning ministry, sector, trade, BCD and RCA." />
        ) : q.isPending ? (
          <LoadingBlock label="Looking up the code…" height={260} />
        ) : notFound ? (
          <EmptyState
            compact
            icon={SearchX}
            title={`No HSN code ${fmtCode(normalized)} in the Atlas`}
            message="Check the digits, or search by product name. Codes must exist in the HS 2022 nomenclature or the GST HSN master."
            action={
              <Button to={routes.explore({ q: normalized.slice(0, 4) })} size="sm">
                Browse {fmtCode(normalized.slice(0, 4))} in the Explorer
              </Button>
            }
          />
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
        ) : q.data ? (
          <div className={q.isFetching ? 'opacity-60 transition-opacity' : undefined}>
            {q.data.type === 'product' ? <ProductResult p={q.data.product} /> : <NodeResult data={q.data} onPick={submit} />}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
