/**
 * Skilling tab (Policy Workbench) - GET /api/policy/skilling?chain_id=|sector_id=.
 *
 * The Sector Skill Councils (NSDC) relevant to each value chain or sector, so skilling programmes can
 * follow the products a ministry wants to grow. Filter by value
 * chain or sector (`?skill_chain=` / `?skill_sector=`); each council links to its website and to the
 * chains it serves.
 */
import { Link } from 'react-router';
import { ExternalLink, GraduationCap } from 'lucide-react';
import { useSectorLookup, useSectorOptions, useValueChains } from '@/api/hooks';
import type { SkillCouncil } from '@/api/types';
import { Button, QueryState, SectorPill, SegmentedControl, Select } from '@/components';
import { fmtNum } from '@/lib/format';
import { useSearchParamState } from '@/lib/hooks';
import { routes } from '@/lib/routes';
import { useChainOptions } from '../analytics/shared/filters';
import { useSkilling } from './api';

function CouncilCard({ c }: { c: SkillCouncil }) {
  const sectors = useSectorLookup();
  const chains = useValueChains();
  const chainName = (id: string) => chains.data?.find((x) => x.id === id)?.name ?? id;
  return (
    <article className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink" aria-hidden>
          <GraduationCap className="size-4" />
        </span>
        <h3 className="min-w-0 flex-1 text-[14px] leading-snug font-semibold text-ink">{c.name}</h3>
      </div>
      {c.sectors?.length ? (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Sectors</div>
          <div className="flex flex-wrap gap-1.5">
            {c.sectors.map((s) => {
              const sec = sectors.get(s);
              return <SectorPill key={s} size="xs" sector={{ id: s, name: sec?.name ?? s, color: sec?.color ?? null }} />;
            })}
          </div>
        </div>
      ) : null}
      {c.chains?.length ? (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">Value chains</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {c.chains.map((ch) => (
              <Link key={ch} to={routes.valueChain(ch)} className="text-[12.5px] text-brand-ink hover:underline">
                {chainName(ch)}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
      {c.url ? (
        <div className="mt-auto pt-4">
          <Button href={c.url} size="sm" icon={ExternalLink}>
            Council website
          </Button>
        </div>
      ) : null}
    </article>
  );
}

export function SkillingTab() {
  const [by, setBy] = useSearchParamState('skill_by', 'chain');
  const [chain, setChain] = useSearchParamState('skill_chain', '');
  const [sector, setSector] = useSearchParamState('skill_sector', '');
  const chainOptions = useChainOptions();
  const sectorOptions = useSectorOptions();
  const bySector = by === 'sector';
  const q = useSkilling(bySector ? { sector_id: sector || undefined } : { chain_id: chain || undefined });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-card">
        <SegmentedControl
          value={bySector ? 'sector' : 'chain'}
          onChange={(v) => setBy(v)}
          ariaLabel="Filter councils by"
          options={[
            { value: 'chain', label: 'By value chain' },
            { value: 'sector', label: 'By sector' },
          ]}
        />
        {bySector ? (
          <Select size="sm" className="w-64" value={sector} onChange={(v) => setSector(v)} options={sectorOptions} placeholder="All sectors" aria-label="Sector" />
        ) : (
          <Select size="sm" className="w-64" value={chain} onChange={(v) => setChain(v)} options={chainOptions} placeholder="All value chains" aria-label="Value chain" />
        )}
        <span className="ml-auto text-xs text-muted">Sector Skill Councils are industry-led bodies set up under NSDC.</span>
      </div>
      <QueryState query={q} isEmpty={(d) => d.length === 0} emptyIcon={GraduationCap} emptyTitle="No Sector Skill Council is mapped to this selection">
        {(d) => (
          <>
            <div className="text-[13px] text-ink-2">
              <span className="font-semibold text-ink">{fmtNum(d.length)}</span> {d.length === 1 ? 'council' : 'councils'}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {d.map((c) => (
                <CouncilCard key={c.id} c={c} />
              ))}
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
