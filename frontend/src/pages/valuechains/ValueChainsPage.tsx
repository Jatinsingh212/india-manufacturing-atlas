/**
 * ValueChainsPage - `/value-chains`, the curated value chains from GET /api/valuechains (SPEC 6.5):
 * a ranked chart of India's share of world exports by chain, and one
 * card per chain (anchor HS, lead ministry, India
 * exports, world market, India share, stages and items) linking to the deep-dive, its ministry-wise
 * mapping table and the network view.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, ChartBar, Network, SearchX, TableProperties, Workflow } from 'lucide-react';
import { useValueChains } from '@/api/hooks';
import type { Provenance, ValueChainListItem } from '@/api/types';
import {
  Button,
  Card,
  CodeLink,
  EChart,
  EmptyState,
  ErrorState,
  LoadingBlock,
  MinistryPill,
  PageHeader,
  ProvenanceBadge,
  ProvenanceLegend,
  SearchInput,
  SegmentedControl,
} from '@/components';
import { fmtNum, fmtPct, fmtUSD, NA_SHORT, plural } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useTheme } from '@/theme/ThemeContext';
import { useAtlasProvenance } from '@/pages/ministries/api';
import { barChartHeight, rankedBarOption, type BarRow } from '@/pages/ministries/charts';
import { matchesQuery } from '@/pages/ministries/utils';

type SortKey = 'default' | 'exports' | 'share' | 'market';

export default function ValueChainsPage() {
  const query = useValueChains();
  const { trade } = useAtlasProvenance();
  return (
    <>
      <PageHeader
        eyebrow="Sectoral deep-dives"
        title="Value chains"
        icon={Workflow}
        subtitle="From raw materials to finished goods, with the ministry at every stage."
        meta={<ProvenanceLegend compact />}
        actions={
          <Button to={routes.network()} size="sm" variant="secondary" icon={Network}>
            Network of all chains
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingBlock label="Loading value chains…" height={320} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data?.length ? (
        <EmptyState icon={Workflow} title="No value chains loaded" message="The curated value-chain register is empty; rebuild the Atlas database." />
      ) : (
        <ValueChainsBody chains={query.data} trade={trade} />
      )}
    </>
  );
}

function ValueChainsBody({ chains, trade }: { chains: ValueChainListItem[]; trade: Provenance }) {
  const navigate = useNavigate();
  const { mode } = useTheme();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('default');

  const bars = useMemo<BarRow[]>(
    () =>
      [...chains]
        .sort((a, b) => (b.india_share ?? -1) - (a.india_share ?? -1))
        .map((c) => ({ id: c.id, label: c.name, value: c.india_share })),
    [chains],
  );
  const option = useMemo(
    () =>
      rankedBarOption({
        rows: bars,
        mode,
        format: (v) => fmtPct(v, { digits: v < 0.01 ? 2 : 1 }),
        seriesName: "India's share of world exports",
        labelWidth: 150,
        hideValueAxis: true,
      }),
    [bars, mode],
  );

  const shown = useMemo(() => {
    const list = chains.filter((c) => matchesQuery(q, c.name, c.title, c.description, c.anchor_hs, c.lead_ministry?.name, c.lead_ministry?.short_name));
    const by = (f: (c: ValueChainListItem) => number | null) => [...list].sort((a, b) => (f(b) ?? -1) - (f(a) ?? -1));
    if (sort === 'exports') return by((c) => c.india_exports);
    if (sort === 'share') return by((c) => c.india_share);
    if (sort === 'market') return by((c) => c.world_trade);
    return list;
  }, [chains, q, sort]);

  return (
    <div className="space-y-6">
      <Card
          icon={ChartBar}
          title="India's share of world exports, by chain"
          subtitle="Click a bar to open the deep-dive"
          actions={<ProvenanceBadge provenance={trade} size="xs" />}
        >
          <EChart
            option={option}
            height={barChartHeight(bars.length, 26)}
            ariaLabel="Bar chart of India's share of world exports by value chain"
            onEvents={{
              click: (p: { dataIndex?: number }) => {
                const bar = typeof p.dataIndex === 'number' ? bars[p.dataIndex] : undefined;
                if (bar) navigate(routes.valueChain(bar.id));
              },
            }}
          />
      </Card>

      <section aria-labelledby="vc-cards">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 id="vc-cards" className="text-[15px] font-semibold text-ink">
            Value chains <span className="font-normal text-muted">({fmtNum(shown.length)})</span>
          </h2>
          <SearchInput value={q} onChange={setQ} size="sm" placeholder="Search chain, HS code or ministry…" className="w-full max-w-xs" aria-label="Search value chains" />
          <SegmentedControl
            className="ml-auto"
            ariaLabel="Sort chains"
            size="xs"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'default', label: 'Default' },
              { value: 'exports', label: 'India exports' },
              { value: 'share', label: 'India share' },
              { value: 'market', label: 'World market' },
            ]}
          />
        </div>
        {shown.length ? (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {shown.map((c) => (
              <ChainCard key={c.id} c={c} trade={trade} />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState compact icon={SearchX} title="No value chain matches this search" />
          </Card>
        )}
      </section>
    </div>
  );
}

function ChainCard({ c, trade }: { c: ValueChainListItem; trade: Provenance }) {
  const share = c.india_share;
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-line bg-surface shadow-card">
      <div className="flex-1 p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Link to={routes.valueChain(c.id)} className="text-[15px] leading-snug font-bold text-ink hover:text-brand-ink hover:underline">
              {c.title ?? c.name}
            </Link>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1">
                Anchor <CodeLink code={c.anchor_hs} />
              </span>
              {c.lead_ministry ? (
                <span className="inline-flex items-center gap-1">
                  Lead <MinistryPill ministry={c.lead_ministry} size="xs" />
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-surface-2 p-2.5">
          <div className="min-w-0">
            <dt className="text-[11px] text-muted">India exports</dt>
            <dd className="text-[15px] font-bold text-kpi">{fmtUSD(c.india_exports, { na: NA_SHORT })}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-muted">World market</dt>
            <dd className="text-[15px] font-bold text-kpi">{fmtUSD(c.world_trade, { na: NA_SHORT })}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] text-muted">India share</dt>
            <dd className="text-[15px] font-bold text-kpi">{fmtPct(share, { na: NA_SHORT })}</dd>
          </div>
        </dl>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>
            {plural(c.n_stages, 'stage')} · {plural(c.n_items, 'item')}
          </span>
          <ProvenanceBadge provenance={trade} size="xs" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
        <Button to={routes.valueChain(c.id)} size="xs" variant="primary" iconRight={ArrowRight}>
          Open deep-dive
        </Button>
        <Button to={routes.valueChainMapping(c.id)} size="xs" variant="ghost" icon={TableProperties}>
          Mapping
        </Button>
        <Button to={routes.network({ center: c.anchor_hs })} size="xs" variant="ghost" icon={Network}>
          Network
        </Button>
      </div>
    </article>
  );
}
