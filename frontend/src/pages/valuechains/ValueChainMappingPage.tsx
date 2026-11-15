/**
 * ValueChainMappingPage - `/value-chains/:id/mapping`, the "Ministry-Wise Product Mapping Across the
 * <chain> Value Chain" table from GET /api/valuechains/{id}/mapping (SPEC 6.5):
 *
 *   S.No. | Item | HS Code | Description | Concerned Ministry      (+ India exports / imports)
 *   grouped by stage with full-width group header rows ("Raw Materials", "Components", ...)
 *
 * - Stage tabs are synced to `?stage=<stage_id>` (the chain page's stage headings link here). All rows
 *   are fetched once and filtered locally, so every stage tab is always available.
 * - Consecutive rows of the same item / ministry are merged (row spans); a blank item or ministry cell in
 *   the source means "same as above".
 * - "HS Code (8-digit level) has trade data linked": linked codes open the product page and show India's
 *   exports / imports, joined from the chain detail's stage items (HS6-level values). Items whose figure
 *   is a heading / chapter aggregate (`trade_level` 'hs4', 'hs2' or BACI's 'hs4_aggregate', e.g.
 *   petroleum oils reported only as 271000) carry an "HS4 total" mark next to the value.
 * - Back button to the chain page; CSV export of the current tab (blank cells filled down).
 * - Mappings are curated by the Atlas team and marked Not verified until the ministry validates them.
 */
import { Fragment, useMemo } from 'react';
import { useParams } from 'react-router';
import clsx from 'clsx';
import { ArrowLeft, Download, Link2, Network, TableProperties } from 'lucide-react';
import { isApiError } from '@/api/client';
import { useValueChains } from '@/api/hooks';
import type { Provenance, ValueChainDetail, ValueChainMappingRow } from '@/api/types';
import { Badge, Button, Card, CodeLink, EmptyState, ErrorState, LoadingBlock, PageHeader, ProvenanceBadge, ProvenanceLegend, Tabs, Tooltip, useToast } from '@/components';
import { downloadCsv } from '@/lib/csv';
import { NA_SHORT } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useSearchParamState } from '@/lib/hooks';
import { LabelledProvenance } from '@/pages/ministries/components/LabelledProvenance';
import { useValueChainDetail, useValueChainMapping } from './api';
import { TradeValue } from './components/TradeLevelMark';
import { tradeLevelNote, type TradeLevelNote } from './utils';

const ALL = 'all';

interface StageGroup {
  stage_id: string;
  stage: string;
  rows: ValueChainMappingRow[];
}

/** One rendered row with merged-cell bookkeeping and filled-down values. */
interface RenderRow {
  row: ValueChainMappingRow;
  item: string;
  ministry: string;
  /** rowSpan for the item cell (0 = covered by a cell above). */
  itemSpan: number;
  ministrySpan: number;
}

function groupByStage(rows: ValueChainMappingRow[]): StageGroup[] {
  const groups: StageGroup[] = [];
  const index = new Map<string, StageGroup>();
  for (const r of rows) {
    let g = index.get(r.stage_id);
    if (!g) {
      g = { stage_id: r.stage_id, stage: r.stage, rows: [] };
      index.set(r.stage_id, g);
      groups.push(g);
    }
    g.rows.push(r);
  }
  return groups;
}

/** Fill blank item / ministry cells down and compute row spans within one stage. */
function layoutGroup(rows: ValueChainMappingRow[]): RenderRow[] {
  const out: RenderRow[] = [];
  let item = '';
  let ministry = '';
  for (const r of rows) {
    const itemText = (r.item ?? '').trim();
    const minText = (r.ministry_text ?? '').trim();
    const newItem = itemText !== '' && itemText !== item;
    const newMin = minText !== '' && minText !== ministry;
    if (itemText) item = itemText;
    if (minText) ministry = minText;
    out.push({ row: r, item, ministry, itemSpan: newItem || out.length === 0 ? 1 : 0, ministrySpan: newMin || out.length === 0 ? 1 : 0 });
  }
  // convert "starts a run" flags into spans
  for (const key of ['itemSpan', 'ministrySpan'] as const) {
    let start = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i][key] === 1) start = i;
      else if (start >= 0) out[start][key] += 1;
    }
  }
  return out;
}

function tradeKey(stageId: string, code: string | null | undefined): string {
  return `${stageId}|${(code ?? '').replace(/[\s.]/g, '')}`;
}

export default function ValueChainMappingPage() {
  const { id = '' } = useParams();
  const mapping = useValueChainMapping(id);
  const detail = useValueChainDetail(id);
  const [stage, setStage] = useSearchParamState('stage', ALL);
  const toast = useToast();

  const { data: chainList } = useValueChains();
  const chain = detail.data?.chain;
  const listed = chainList?.find((c) => c.id === id);
  const name = chain?.name ?? listed?.name ?? null;
  const title = name ? `Ministry-Wise Product Mapping Across the ${name} Value Chain` : 'Ministry-wise product mapping';

  const groups = useMemo(() => groupByStage(mapping.data?.rows ?? []), [mapping.data]);
  const trade = useMemo(() => buildTradeIndex(detail.data), [detail.data]);
  const tradeProv: Provenance = detail.data?.kpis.find((k) => k.key === 'india_exports')?.provenance ?? {
    source: 'tradestat',
    status: 'verified',
    label: "DGFT/DGCIS TRADESTAT (India's trade); world trade: CEPII BACI HS 2022",
    year: null,
  };
  // The API states the mapping's provenance; without it, fall back to the curated mapping status.
  const mappingProv: Provenance =
    mapping.data?.provenance ??
    detail.data?.provenance?.mapping ?? {
      source: 'manual',
      status: 'not_verified',
      label: 'Curated by the Atlas team from the HS nomenclature; awaiting ministry validation',
      year: null,
    };
  const notFound = mapping.isError && isApiError(mapping.error) && mapping.error.isNotFound;

  const activeId = stage !== ALL && groups.some((g) => g.stage_id === stage) ? stage : ALL;
  const visible = activeId === ALL ? groups : groups.filter((g) => g.stage_id === activeId);
  const nRows = visible.reduce((s, g) => s + g.rows.length, 0);
  const nLinked = visible.reduce((s, g) => s + g.rows.filter((r) => r.linked_hsn8).length, 0);

  const nAggregates = visible.reduce((s, g) => s + g.rows.filter((r) => trade.get(tradeKey(g.stage_id, r.linked_hsn8 ?? r.hs_code))?.note).length, 0);

  const exportCsv = () => {
    const header = [
      'S.No.',
      'Stage',
      'Item',
      'HS Code',
      'Description',
      'Concerned Ministry',
      'Linked HSN8',
      'India exports (US$)',
      'India imports (US$)',
      'Trade level',
      'GST line description',
    ];
    const body = visible.flatMap((g) =>
      layoutGroup(g.rows).map((rr) => {
        const r = rr.row;
        const t = trade.get(tradeKey(g.stage_id, r.linked_hsn8 ?? r.hs_code));
        return [
          r.s_no ?? '',
          g.stage,
          rr.item,
          r.hs_code ?? '',
          r.description ?? '',
          rr.ministry,
          r.linked_hsn8 ?? '',
          t?.exports ?? '',
          t?.imports ?? '',
          t ? (t.note?.level ?? 'hs6') : '',
          r.gst_description ?? '',
        ];
      }),
    );
    downloadCsv(`${id}-ministry-wise-mapping${activeId === ALL ? '' : `-${activeId}`}`, header, body);
    toast.success('CSV ready', `${body.length} rows`);
  };

  const crumbs = [
    { label: 'Value chains', to: routes.valueChains() },
    { label: name ?? id, to: routes.valueChain(id) },
    { label: 'Ministry-wise mapping' },
  ];

  return (
    <>
      <PageHeader
        eyebrow={chain?.title ?? 'Value chain mapping'}
        title={title}
        icon={TableProperties}
        iconColor={chain?.lead_ministry?.color ?? undefined}
        breadcrumbs={crumbs}
        subtitle="Item, HS code, description and concerned ministry for every stage of the chain. HS codes at 8-digit level have trade data linked."
        meta={
          <>
            {chain || mapping.data ? <ProvenanceBadge provenance={mappingProv} size="xs" /> : null}
            <ProvenanceLegend compact />
          </>
        }
        actions={
          <>
            <Button to={notFound ? routes.valueChains() : routes.valueChain(id)} size="sm" variant="primary" icon={ArrowLeft}>
              {notFound ? 'All value chains' : 'Back'}
            </Button>
            {nRows ? (
              <Button size="sm" variant="secondary" icon={Download} onClick={exportCsv}>
                CSV
              </Button>
            ) : null}
            {chain ? (
              <Button size="sm" variant="secondary" icon={Network} to={routes.network({ center: chain.anchor_hs })}>
                Network
              </Button>
            ) : null}
          </>
        }
      />

      {mapping.isPending ? (
        <LoadingBlock label="Loading the ministry-wise mapping…" height={320} />
      ) : mapping.isError ? (
        <>
          <ErrorState
            error={mapping.error}
            title={notFound ? `No value chain with id “${id}”` : undefined}
            onRetry={() => void mapping.refetch()}
          />
          {notFound ? (
            <div className="mt-2 flex justify-center">
              <Button to={routes.valueChains()} size="sm" variant="secondary">
                See all value chains
              </Button>
            </div>
          ) : null}
        </>
      ) : !groups.length ? (
        <Card>
          <EmptyState icon={TableProperties} title="No mapping rows for this value chain" message="The chain has no stage items with HS codes yet." />
        </Card>
      ) : (
        <Card padding="sm">
          <Tabs
            value={activeId}
            onChange={(v) => setStage(v)}
            tabs={[{ id: ALL, label: 'All stages', badge: groups.reduce((s, g) => s + g.rows.length, 0) }, ...groups.map((g) => ({ id: g.stage_id, label: g.stage, badge: g.rows.length }))]}
            actions={
              <span className="hidden items-center gap-1.5 text-xs text-muted md:inline-flex">
                <Link2 className="size-3.5 text-brand-ink" aria-hidden />
                {nLinked} of {nRows} codes linked to trade data
              </span>
            }
          >
            <div className="atlas-scroll-x overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label={`${title} (scroll horizontally for all columns)`}>
              <table className="w-full min-w-[56rem] border-collapse text-[13px]">
                <caption className="sr-only">{title}</caption>
                <thead>
                  <tr className="bg-navy text-left text-[12px] font-semibold text-white">
                    <th scope="col" className="w-14 px-3 py-2.5">S.No.</th>
                    <th scope="col" className="w-40 px-3 py-2.5">Item</th>
                    <th scope="col" className="w-32 px-3 py-2.5">HS Code</th>
                    <th scope="col" className="px-3 py-2.5">Description</th>
                    <th scope="col" className="w-48 px-3 py-2.5">Concerned Ministry</th>
                    <th scope="col" className="w-24 px-3 py-2.5 text-right">
                      <Tooltip content="India's exports to the world, latest financial year, HS6 level (DGCIS TRADESTAT). 'HS4 total' marks 4-digit codes and BACI heading aggregates, which sum every subheading under the heading.">
                        <span className="cursor-help underline decoration-white/40 decoration-dotted underline-offset-4">Exports</span>
                      </Tooltip>
                    </th>
                    <th scope="col" className="w-24 px-3 py-2.5 text-right">
                      <Tooltip content="India's imports from the world, latest financial year, HS6 level (DGCIS TRADESTAT). 'HS4 total' marks 4-digit codes and BACI heading aggregates, which sum every subheading under the heading.">
                        <span className="cursor-help underline decoration-white/40 decoration-dotted underline-offset-4">Imports</span>
                      </Tooltip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((g) => (
                    <Fragment key={g.stage_id}>
                      <tr>
                        <th scope="colgroup" colSpan={7} className="border-y border-line bg-kpi-soft px-3 py-2 text-center text-[13.5px] font-bold text-kpi">
                          {g.stage}
                        </th>
                      </tr>
                      {layoutGroup(g.rows).map((rr, i) => {
                        const r = rr.row;
                        const t = trade.get(tradeKey(g.stage_id, r.linked_hsn8 ?? r.hs_code));
                        return (
                          <tr key={`${g.stage_id}-${i}`} className="align-top hover:bg-surface-2">
                            <td className="border-b border-line px-3 py-2 text-muted atlas-num">
                              {r.s_no === null || r.s_no === undefined || r.s_no === '' ? '' : String(r.s_no)}
                            </td>
                            {rr.itemSpan > 0 ? (
                              <td rowSpan={rr.itemSpan} className={clsx('border-b border-l border-line px-3 py-2 font-semibold text-ink', rr.itemSpan > 1 && 'align-middle')}>
                                {rr.item || NA_SHORT}
                              </td>
                            ) : null}
                            <td className="border-b border-l border-line px-3 py-2 whitespace-nowrap">
                              <HsCell row={r} />
                            </td>
                            <td className="border-b border-line px-3 py-2 text-ink-2">
                              {r.description || <span className="text-muted">{NA_SHORT}</span>}
                            </td>
                            {rr.ministrySpan > 0 ? (
                              <td rowSpan={rr.ministrySpan} className={clsx('border-b border-l border-line px-3 py-2 font-medium text-ink', rr.ministrySpan > 1 && 'align-middle')}>
                                {rr.ministry || <span className="text-muted">Not available</span>}
                              </td>
                            ) : null}
                            <td className={clsx('border-b border-l border-line px-3 py-2 text-right whitespace-nowrap atlas-num', !t && 'text-muted')}>
                              {t ? <TradeValue value={t.exports} note={t.note} /> : NA_SHORT}
                            </td>
                            <td className={clsx('border-b border-line px-3 py-2 text-right whitespace-nowrap atlas-num', !t && 'text-muted')}>
                              {t ? <TradeValue value={t.imports} note={t.note} /> : NA_SHORT}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
              <Badge tone="brand" icon={Link2} size="xs">
                HS code (8-digit level) has trade data linked
              </Badge>
              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <span className="text-[11px] font-medium text-ink-2">Mapping</span>
                <ProvenanceBadge provenance={mappingProv} size="xs" />
              </span>
              <LabelledProvenance label="Trade" provenance={tradeProv} />
              <span>
                Mappings are curated by the Atlas team and Not verified until the ministry validates them.
              </span>
              <span>
                Trade figures are HS6-level: lines in the same subheading share its trade.
                {nAggregates ? (
                  <>
                    {' '}
                    <Badge tone="warning" size="xs" className="align-text-bottom">
                      HS4 total
                    </Badge>{' '}
                    marks 4-digit codes and BACI heading aggregates (petroleum oils are reported only as heading 2710): those figures sum every subheading under
                    the heading, not the item alone.
                  </>
                ) : null}{' '}
                Merged cells repeat for every row in the CSV.
              </span>
            </div>
          </Tabs>
        </Card>
      )}
    </>
  );
}

/**
 * HS code cell: linked 8-digit lines open the product page; 4/6-digit codes open the Explorer.
 */
function HsCell({ row }: { row: ValueChainMappingRow }) {
  const code = row.hs_code;
  const linked = row.linked_hsn8;
  if (!code && !linked) return <span className="text-muted">{NA_SHORT}</span>;
  if (!linked) return <CodeLink code={code} style="plain" />;
  return (
    <span className="inline-flex items-center gap-1.5">
      <CodeLink code={linked} style="plain" className="font-semibold" />
      <Tooltip content="Trade data linked: opens the product page">
        <Link2 className="size-3.5 text-brand-ink" aria-label="Trade data linked" />
      </Tooltip>
    </span>
  );
}

interface TradeCell {
  exports: number | null;
  imports: number | null;
  /** Set when the figure is a heading / chapter aggregate rather than the item's own HS6. */
  note: TradeLevelNote | null;
}

/** stage_id|code -> {exports, imports, note} from the chain detail's stage items. */
function buildTradeIndex(d: ValueChainDetail | undefined): Map<string, TradeCell> {
  const m = new Map<string, TradeCell>();
  for (const s of d?.stages ?? []) {
    for (const it of s.items) {
      if (!it.linked) continue;
      const v: TradeCell = { exports: it.exports, imports: it.imports, note: tradeLevelNote(it) };
      if (it.hsn8) m.set(tradeKey(s.stage_id, it.hsn8), v);
      if (it.hs_code) m.set(tradeKey(s.stage_id, it.hs_code), v);
    }
  }
  return m;
}
