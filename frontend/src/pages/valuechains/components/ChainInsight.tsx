/**
 * ChainInsight - the value-chain deep-dive in plain sentences: how big the world market is, where India
 * stands in it, where its exports go and where its inputs come from, and how many critical inputs it
 * depends on. Computed from GET /api/valuechains/{id}; a sentence is skipped when its figure is missing.
 */
import type { ReactNode } from 'react';
import type { ValueChainDetail } from '@/api/types';
import { Insight, Term, type InsightPoint } from '@/components';
import { fmtOrdinal, fmtPct, fmtUSD } from '@/lib/format';

const num = (d: ValueChainDetail, key: string): number | null => {
  const v = d.kpis.find((k) => k.key === key)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

export function ChainInsight({ d }: { d: ValueChainDetail }) {
  const name = d.chain.name.toLowerCase();
  const world = num(d, 'global_exports');
  const exports = num(d, 'india_exports');
  const imports = num(d, 'india_imports');
  const share = num(d, 'india_share') ?? (world && exports !== null ? exports / world : null);
  const rank = d.india_rank?.rank ?? null;
  const n = d.india_rank?.n_suppliers ?? null;
  const leader = d.world_top_suppliers[0];
  const dest = d.india_top_destinations[0];
  const source = d.india_top_sources[0];
  const critical = d.risk_flags.length;

  const points: InsightPoint[] = [];
  if (world !== null && exports !== null) {
    points.push({
      tone: share !== null && share >= 0.02 ? 'good' : 'info',
      text: (
        <>
          The world trades <b>{fmtUSD(world)}</b> of {name} a year. India sells <b>{fmtUSD(exports)}</b>
          {share !== null ? <> ({fmtPct(share, { digits: 1 })} <Term k="world_share">world share</Term>)</> : null}
          {rank ? <>, ranking <b>{fmtOrdinal(rank)}</b>{n ? <> of {n} exporting countries</> : null}</> : null}.
          {leader && leader.country !== 'India' ? <> {leader.country} leads with {fmtPct(leader.share, { digits: 0 })}.</> : null}
        </>
      ),
    });
  }
  if (exports !== null && imports !== null) {
    const net = exports - imports;
    points.push({
      tone: net >= 0 ? 'good' : 'bad',
      text: (
        <>
          India is a net <b>{net >= 0 ? 'exporter' : 'importer'}</b> here: it imports {fmtUSD(imports)}, so the balance is{' '}
          <b>{net >= 0 ? '+' : '−'}{fmtUSD(Math.abs(net))}</b>.
        </>
      ),
    });
  }
  const flows: ReactNode[] = [];
  if (dest) flows.push(<>most exports go to <b>{dest.country}</b>{dest.share !== null ? ` (${fmtPct(dest.share, { digits: 0 })})` : ''}</>);
  if (source) flows.push(<>most imports come from <b>{source.country}</b>{source.share !== null ? ` (${fmtPct(source.share, { digits: 0 })})` : ''}</>);
  if (flows.length) {
    points.push({ tone: 'info', text: <>{flows.reduce<ReactNode[]>((acc, f, i) => (i ? [...acc, '; ', f] : [f]), [])}.</> });
  }
  if (critical) {
    points.push({
      tone: 'bad',
      text: (
        <>
          <b>{critical}</b> input{critical === 1 ? '' : 's'} in this chain {critical === 1 ? 'is' : 'are'} flagged as{' '}
          <Term k="vulnerability">critical</Term>: heavily imported from few countries. See "Items & risk" below.
        </>
      ),
    });
  }
  if (!points.length) return null;
  return <Insight points={points} note="India's trade: DGCIS TRADESTAT, latest FY; world trade: CEPII BACI, latest year." />;
}
