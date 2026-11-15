/**
 * ValueChainPage - `/value-chains/:id`, the sector deep-dive from GET /api/valuechains/{id} (SPEC 6.5):
 *
 *   title "Tyre Sector (HS Code 4011)"
 *   "<Name> Manufacturing Value Chain" stage cards with ministry boxes (heading -> mapping)
 *   top global suppliers + "India's rank is 8th in global suppliers" | top global markets
 *   major export destinations | major import partners | top export categories | leading manufacturers
 *
 * Also: manufacturing clusters, sector skill council, PLI / QCO schemes, risk flags (critical inputs,
 * model estimate), the item table with live trade, "Open in network view", Download report and the
 * Verified / Not verified / Not available legend. Ministry mappings are curated by the Atlas team and
 * marked Not verified until the ministry validates them.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Award,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Factory,
  GraduationCap,
  Layers,
  Network,
  PackageOpen,
  ShieldAlert,
  Ship,
  ShoppingCart,
  TableProperties,
  Trophy,
  Workflow,
} from 'lucide-react';
import { isApiError } from '@/api/client';
import type { Provenance, ValueChainDetail, ValueChainItem } from '@/api/types';
import {
  Badge,
  Button,
  Card,
  CodeLink,
  DataTable,
  DownloadMenu,
  EmptyState,
  ErrorState,
  LoadingBlock,
  MinistryPill,
  ModelEstimateTag,
  PageHeader,
  ProvenanceBadge,
  ProvenanceLegend,
  ScoreBar,
  SectionLabel,
  Tabs,
  tradeSourceLabel,
  type Column,
  type TabDef,
} from '@/components';
import { fmtOrdinal, fmtRate, fmtRatio, fmtUSD, NA_SHORT } from '@/lib/format';
import { routes } from '@/lib/routes';
import { LabelledProvenance } from '@/pages/ministries/components/LabelledProvenance';
import { useValueChainDetail, useValueChainTiers } from './api';
import { ClustersCard } from './components/ClustersCard';
import { StageFlow } from './components/StageFlow';
import { TierFlow } from './components/TierFlow';
import { CategoryCard, CountryCard, TradeEditionNote } from './components/TradeCards';
import { TradeValue } from './components/TradeLevelMark';
import { chainYear, rankText, tradeLevelNote } from './utils';

type DetailView = 'trade' | 'ecosystem' | 'tiers' | 'items';

const DETAIL_TABS: TabDef<DetailView>[] = [
  { id: 'trade', label: 'Trade', icon: Ship },
  { id: 'ecosystem', label: 'Ecosystem', icon: Factory },
  { id: 'tiers', label: 'Supply tiers', icon: Layers },
  { id: 'items', label: 'Items & risk', icon: ShieldAlert },
];

export default function ValueChainPage() {
  const { id = '' } = useParams();
  const query = useValueChainDetail(id);
  const crumbs = [{ label: 'Value chains', to: routes.valueChains() }];

  if (query.isPending) {
    return (
      <>
        <PageHeader eyebrow="Value chain deep-dive" title="Loading value chain…" icon={Workflow} breadcrumbs={[...crumbs, { label: id }]} />
        <LoadingBlock label="Loading the sector deep-dive…" height={360} />
      </>
    );
  }
  if (query.isError || !query.data) {
    const notFound = isApiError(query.error) && query.error.isNotFound;
    return (
      <>
        <PageHeader eyebrow="Value chain deep-dive" title={notFound ? 'Value chain not found' : 'Value chain'} icon={Workflow} breadcrumbs={[...crumbs, { label: id }]} />
        <ErrorState error={query.error} title={notFound ? `No value chain with id “${id}”` : undefined} onRetry={() => void query.refetch()} />
        {notFound ? (
          <div className="mt-2 flex justify-center">
            <Button to={routes.valueChains()} variant="primary" size="sm">
              See all value chains
            </Button>
          </div>
        ) : null}
      </>
    );
  }
  return <ValueChainBody d={query.data} />;
}

function ValueChainBody({ d }: { d: ValueChainDetail }) {
  const c = d.chain;
  const year = chainYear(d);
  const title = c.title ?? `${c.name} Sector (HS Code ${c.anchor_hs})`;
  const tradeKpi = d.kpis.find((k) => k.key === 'india_exports' || k.key === 'global_exports');
  const trade: Provenance = d.provenance?.trade ?? tradeKpi?.provenance ?? { source: 'tradestat', status: 'verified', label: tradeSourceLabel(year), year };
  // supplier, market and partner-country tables are BACI (India's own partner split is not in TRADESTAT here)
  const partners: Provenance = { source: 'baci', status: 'verified', label: `CEPII BACI ${year} (via OEC), partner tables`, year };

  const liveRank = rankText(d.india_rank, (n) => fmtOrdinal(n));

  const mappingProv = d.provenance?.mapping ?? null;

  // The supplier-tiers tab only exists for chains that have tiers; the data loads when it is opened.
  const hasTiers = Boolean(d.has_tiers);
  const tabs = DETAIL_TABS.filter((t) => t.id !== 'tiers' || hasTiers);

  return (
    <>
      <PageHeader
        eyebrow="Value chain deep-dive"
        title={title}
        icon={Workflow}
        iconColor={c.lead_ministry?.color ?? undefined}
        breadcrumbs={[{ label: 'Value chains', to: routes.valueChains() }, { label: c.name }]}
        subtitle={c.description ?? undefined}
        meta={
          <>
            {c.lead_ministry ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                Lead ministry <MinistryPill ministry={c.lead_ministry} size="xs" />
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              Anchor <CodeLink code={c.anchor_hs} />
            </span>
            <Badge tone="outline" size="xs">
              Curated chain
            </Badge>
            {mappingProv ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <span className="text-[11px] font-medium text-ink-2">Ministry mapping</span>
                <ProvenanceBadge provenance={mappingProv} size="xs" />
              </span>
            ) : null}
            <ProvenanceLegend compact />
          </>
        }
        actions={
          <>
            <Button size="sm" variant="secondary" icon={Network} to={routes.network({ center: c.anchor_hs })}>
              Open in network view
            </Button>
            <Button size="sm" variant="secondary" icon={TableProperties} to={routes.valueChainMapping(c.id)}>
              Ministry-wise mapping
            </Button>
            <DownloadMenu kind="valuechain" id={c.id} variant="primary" />
          </>
        }
      />

      <div className="space-y-6">
        <StageFlow chainId={c.id} chainName={c.name} stages={d.stages} />

        <section aria-labelledby="value-chain-more" className="space-y-3">
          <SectionLabel>
            <span id="value-chain-more">More on this chain</span>
          </SectionLabel>

          <Tabs<DetailView> tabs={tabs} urlParam="view" defaultValue="trade">
            {(view) =>
              view === 'trade' ? (
                <div className="space-y-3">
                  <TradeEditionNote year={year} />
                  <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                    <CountryCard
                      icon={Trophy}
                      title={`Top global suppliers, ${year}`}
                      subtitle={`Exporters of ${c.name.toLowerCase()} (HS ${c.anchor_hs}) · CEPII BACI HS 2022, US$`}
                      items={d.world_top_suppliers}
                      trade={partners}
                      emptyText="No supplier data"
                      note={
                        <div className="text-[13px]">
                          <div className="font-semibold text-ink">{liveRank ?? 'India is not among the recorded suppliers'}</div>
                          {typeof d.india_rank?.n_suppliers === 'number' ? (
                            <div className="text-xs text-muted">{d.india_rank.n_suppliers} supplying countries</div>
                          ) : null}
                        </div>
                      }
                    />
                    <CountryCard
                      icon={ShoppingCart}
                      title={`Top global markets, ${year}`}
                      subtitle={`Importers of ${c.name.toLowerCase()} (HS ${c.anchor_hs}) · CEPII BACI HS 2022, US$`}
                      items={d.world_top_markets}
                      trade={partners}
                      emptyText="No market data"
                    />
                    <CountryCard
                      icon={ArrowUpFromLine}
                      title="Major export destinations of India"
                      subtitle={`US$, ${year} · CEPII BACI HS 2022`}
                      items={d.india_top_destinations}
                      trade={partners}
                      emptyText="No export destinations recorded"
                    />
                    <CountryCard
                      icon={ArrowDownToLine}
                      title="Major import partners of India"
                      subtitle={`US$, ${year} · CEPII BACI HS 2022`}
                      items={d.india_top_sources}
                      trade={partners}
                      emptyText="No import partners recorded"
                    />
                    <CategoryCard
                      icon={PackageOpen}
                      title={`India's top ${c.name.toLowerCase()} export categories`}
                      rows={d.top_export_categories.map((x) => ({ code: x.code, label: x.label, value: x.value }))}
                      trade={trade}
                    />
                    <ManufacturersCard name={c.name} items={d.manufacturers} />
                  </div>
                </div>
              ) : view === 'ecosystem' ? (
                <div className="grid gap-6 xl:grid-cols-3">
                  <ClustersCard className="xl:col-span-2" clusters={d.clusters} chainName={c.name} />
                  <div className="grid content-start gap-6 md:grid-cols-2 xl:grid-cols-1">
                    <SkillCouncilCard council={d.skill_council} />
                    <SchemesCard schemes={d.schemes} />
                  </div>
                </div>
              ) : view === 'tiers' ? (
                <TiersPanel chainId={c.id} />
              ) : (
                <div className="space-y-6">
                  <RiskFlagsCard flags={d.risk_flags} />
                  <ItemsTable d={d} trade={trade} mapping={mappingProv} />

                  <Card tone="subtle" padding="sm">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
                      <span>India's trade: DGFT/DGCIS TRADESTAT FY{year}-{String(year + 1).slice(-2)}; world trade and partner tables: CEPII BACI HS 2022, {year}. Aggregated over distinct HS6 under {c.anchor_hs}.</span>
                      <span className="basis-full">Ministry mappings are curated by the Atlas team and marked Not verified until validated by the ministry.</span>
                    </div>
                  </Card>
                </div>
              )
            }
          </Tabs>
        </section>
      </div>
    </>
  );
}

/**
 * TiersPanel - loads the chain's supplier tiers when the tab is opened (the tab bar is lazy, so a
 * chain without tiers never pays for the request).
 */
function TiersPanel({ chainId }: { chainId: string }) {
  const query = useValueChainTiers(chainId, true);
  if (query.isPending) return <LoadingBlock label="Loading the supplier tiers" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const tiers = query.data?.tiers ?? [];
  return (
    <div className="space-y-3">
      <TierFlow tiers={tiers} />
      {tiers.length ? (
        <Card tone="subtle" padding="sm">
          <div className="text-xs leading-relaxed text-muted">
            <span className="font-semibold text-ink">How to read this.</span> The stages above show what the product is
            made of; the tiers show how many hand-offs lie behind those inputs. A Tier 3 line that India imports
            almost entirely is a dependency one step removed from the factory &mdash; it is invisible in the stage
            flow but decides whether the chain can scale.
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function ManufacturersCard({ name, items }: { name: string; items: ValueChainDetail['manufacturers'] }) {  return (
    <Card padding="sm" icon={Factory} title={`Leading ${name.toLowerCase()} manufacturers in India`} subtitle="Company websites open in a new tab">
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((m) => (
            <li key={m.name} className="py-1.5 text-[13px]">
              {m.url ? (
                <a href={m.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-brand-ink hover:underline">
                  {m.name}
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <span className="font-medium text-ink">{m.name}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={Factory} title="No manufacturers listed" />
      )}
    </Card>
  );
}

function SkillCouncilCard({ council }: { council: ValueChainDetail['skill_council'] }) {
  return (
    <Card padding="sm" icon={GraduationCap} title="Sector skill council" subtitle="Skilling programmes for the chain's workforce">
      {council ? (
        council.url ? (
          <a href={council.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-brand-ink hover:underline">
            {council.name}
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
        ) : (
          <span className="text-[13.5px] font-semibold text-ink">{council.name}</span>
        )
      ) : (
        <EmptyState compact icon={GraduationCap} title="No skill council mapped" />
      )}
    </Card>
  );
}

function SchemesCard({ schemes }: { schemes: ValueChainDetail['schemes'] }) {
  return (
    <Card padding="sm" icon={Award} title="PLI schemes and QCOs" subtitle="Schemes whose HS prefixes cover the chain's products">
      {schemes.length ? (
        <ul className="divide-y divide-line">
          {schemes.map((s) => (
            <li key={s.id} className="flex items-center gap-2 py-1.5">
              <Badge tone={s.kind === 'PLI' ? 'brand' : s.kind === 'QCO' ? 'info' : 'neutral'} size="xs">
                {s.kind}
              </Badge>
              <Link to={routes.policy()} className="min-w-0 flex-1 truncate text-[13px] text-ink hover:text-brand-ink hover:underline" title={s.name}>
                {s.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={Award} title="No scheme covers these products" />
      )}
    </Card>
  );
}

/**
 * Optional risk-flag fields the C2 endpoint sends beyond SPEC 6.5 (the chain item behind the code, its
 * stage, India's imports and the top source's name); every one is read defensively.
 */
type RiskFlagRow = ValueChainDetail['risk_flags'][number] & {
  item_name?: string | null;
  stage?: string | null;
  imports?: number | null;
  top_import_source?: string | null;
};

/** Flags shown before "Show all" (fills two rows of the 3-column grid). */
const RISK_LIMIT = 6;

function RiskFlagsCard({ flags }: { flags: RiskFlagRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const sorted = useMemo(() => [...flags].sort((a, b) => (b.vulnerability_score ?? -1) - (a.vulnerability_score ?? -1)), [flags]);
  const shown = expanded ? sorted : sorted.slice(0, RISK_LIMIT);
  return (
    <Card
      padding="sm"
      icon={ShieldAlert}
      title="Critical inputs at risk"
      subtitle="Import-dependent or concentrated inputs, most vulnerable first"
      actions={<ModelEstimateTag method="Vulnerability = 30% dependency ratio + 25% import HHI + 20% China share + 25% import size percentile" />}
    >
      {sorted.length ? (
        <>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown.map((f) => (
              <li key={f.code} className="flex min-w-0 flex-col rounded-lg border border-line p-3">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-[13.5px] leading-snug font-semibold text-ink">{f.item_name || f.description}</span>
                  {f.stage ? (
                    <Badge tone="outline" size="xs" className="shrink-0">
                      {f.stage}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-baseline gap-2 text-xs text-ink-2">
                  <CodeLink code={f.code} className="shrink-0" />
                  {f.item_name && f.description ? (
                    <span className="min-w-0 truncate" title={f.description}>
                      {f.description}
                    </span>
                  ) : null}
                </div>
                <ScoreBar value={f.vulnerability_score} scale="risk" label="Vulnerability" className="mt-1.5" />
                {typeof f.imports === 'number' || f.top_import_source ? (
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-2">
                    {typeof f.imports === 'number' ? (
                      <span>
                        Imports <span className="font-semibold atlas-num">{fmtUSD(f.imports)}</span>
                      </span>
                    ) : null}
                    {f.top_import_source ? (
                      <span>
                        Top source <span className="font-semibold">{f.top_import_source}</span>
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <p className="mt-1 text-xs leading-relaxed text-muted">{f.reason}</p>
              </li>
            ))}
          </ul>
          {sorted.length > RISK_LIMIT ? (
            <Button variant="link" size="xs" className="mt-2" iconRight={expanded ? ChevronUp : ChevronDown} onClick={() => setExpanded((e) => !e)}>
              {expanded ? `Show top ${RISK_LIMIT}` : `Show all ${sorted.length} flagged inputs`}
            </Button>
          ) : null}
        </>
      ) : (
        <EmptyState compact icon={ShieldAlert} title="No critical inputs flagged" message="No input of this chain crosses the vulnerability thresholds." />
      )}
    </Card>
  );
}

type ItemRow = ValueChainItem & { stage: string; stageOrder: number };

interface ItemsTableProps {
  d: ValueChainDetail;
  trade: Provenance;
  mapping: Provenance | null;
  className?: string;
}

function ItemsTable({ d, trade, mapping, className }: ItemsTableProps) {
  const rows = useMemo<ItemRow[]>(
    () => [...d.stages].sort((a, b) => a.order - b.order).flatMap((s) => s.items.map((it) => ({ ...it, stage: s.name, stageOrder: s.order }))),
    [d.stages],
  );
  const NA = { na: NA_SHORT };
  const columns: Column<ItemRow>[] = [
    { key: 'stage', header: 'Stage', value: (r) => r.stageOrder, csv: (r) => r.stage, render: (r) => <span className="whitespace-nowrap text-ink-2">{r.stage}</span> },
    {
      key: 'item',
      header: 'Item',
      value: (r) => r.item_name,
      csv: (r) => (r.description ? `${r.item_name} (${r.description})` : r.item_name),
      // one item can sit under several HS codes, so the line description tells the rows apart
      render: (r) => (
        <span className="inline-block min-w-[11rem] max-w-[22rem] whitespace-normal">
          <span className="block font-medium text-ink">{r.item_name}</span>
          {r.description ? (
            <span className="line-clamp-1 text-xs text-muted" title={r.description}>
              {r.description}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'code',
      header: 'HS code',
      value: (r) => r.hsn8 ?? r.hs_code,
      render: (r) => (r.hsn8 || r.hs_code ? <CodeLink code={r.hsn8 ?? r.hs_code} /> : <span className="text-muted">{NA_SHORT}</span>),
    },
    { key: 'gst_description', header: 'GST line description', csvOnly: true, value: (r) => r.gst_description ?? null },
    {
      key: 'ministries',
      header: 'Ministry',
      hideBelow: 'lg',
      value: (r) => r.ministries.map((m) => m.short_name).join(', ') || r.ministry_text,
      render: (r) =>
        r.ministries.length ? (
          <span className="flex flex-wrap gap-1">
            {r.ministries.map((m) => (
              <MinistryPill key={m.id} ministry={m} size="xs" />
            ))}
          </span>
        ) : (
          <span className="text-xs text-ink-2">{r.ministry_text || NA_SHORT}</span>
        ),
    },
    {
      key: 'exports',
      header: 'Exports',
      align: 'right',
      value: (r) => r.exports,
      render: (r) => <TradeValue value={r.exports} note={tradeLevelNote(r)} />,
      hint: "India's exports to the world (DGCIS TRADESTAT, latest FY), US$ at HS6 level. 'HS4 total' marks 4-digit items and BACI heading aggregates, which sum every subheading under the heading.",
    },
    {
      key: 'imports',
      header: 'Imports',
      align: 'right',
      value: (r) => r.imports,
      render: (r) => <TradeValue value={r.imports} note={tradeLevelNote(r)} />,
      hint: "India's imports from the world (DGCIS TRADESTAT, latest FY), US$ at HS6 level ('HS4 total' = heading-level aggregate).",
    },
    {
      key: 'trade_level',
      header: 'Trade level',
      // CSV only: on screen the "HS4 total" mark sits next to the values.
      csvOnly: true,
      value: (r) => (r.linked ? (tradeLevelNote(r)?.level ?? 'hs6') : null),
    },
    { key: 'rca', header: 'RCA', align: 'right', hideBelow: 'md', value: (r) => r.rca, render: (r) => fmtRatio(r.rca, NA) },
    { key: 'mfn', header: 'MFN', align: 'right', hideBelow: 'xl', value: (r) => r.mfn_tariff, render: (r) => fmtRate(r.mfn_tariff, NA), hint: 'India MFN applied tariff, simple average of the subheading (WITS)' },
  ];
  const aggregates = rows.filter((r) => tradeLevelNote(r)).length;
  return (
    <Card
      className={className}
      padding="sm"
      icon={TableProperties}
      title="Value-chain items with live trade"
      subtitle="Every item of the chain with its HS code and India's trade (HS6 level)"
      actions={
        <>
          {mapping ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
              <span className="text-[11px] font-medium text-ink-2">Mapping</span>
              <ProvenanceBadge provenance={mapping} size="xs" />
            </span>
          ) : null}
          <LabelledProvenance label="Trade" provenance={trade} />
        </>
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        pagination={{ mode: 'client', pageSize: 10, pageSizeOptions: [10, 25, 50] }}
        maxHeight={null}
        dense
        csvFilename={`${d.chain.id}-value-chain-items`}
        emptyTitle="No items mapped yet"
        caption="Value-chain items"
        footer={
          <span>
            {aggregates
              ? `Trade is HS6-level: lines in the same subheading share its trade. ${aggregates} ${aggregates === 1 ? 'item is' : 'items are'} marked HS4 total: 4-digit codes and BACI heading aggregates (e.g. petroleum oils, reported only as heading 2710) sum every subheading under the heading.`
              : 'Trade is HS6-level: lines in the same subheading share its trade.'}
          </span>
        }
      />
    </Card>
  );
}
