/**
 * OverviewPage (`/`) - the "Guidebook on mapping of HSN codes" dashboard (docs/SPEC.md section 8), in
 * four calm blocks with each number said once:
 *
 * 1. Hero: search first, the four common questions as chips, Ask Atlas.
 * 2. One KPI row: lines mapped, residual, ministries, exports, imports, balance.
 * 3. The ownership flow: sector -> register -> owning ministry -> mapping status, with the HS code
 *    distribution by ministry and the sectoral distribution.
 * 4. "Enter HSN code" lookup beside the value chains.
 *
 * Guidebook context and data notes stay one click away at the bottom.
 */
import { BookOpen, ChevronDown } from 'lucide-react';
import { useHealth } from '@/api/hooks';
import { useOverview } from './api';
import { HsnLookupCard } from './components/HsnLookupCard';
import { InfoCards } from './components/InfoCards';
import { MappingNoteCard } from './components/MappingNoteCard';
import { OverviewHero } from './components/OverviewHero';
import { OverviewKpis } from './components/OverviewKpis';
import { OwnershipFlowCard } from './components/OwnershipFlowCard';
import { ValueChainLinks } from './components/ValueChainLinks';


export default function OverviewPage() {
  const overview = useOverview();
  const health = useHealth();
  const d = overview.data;

  return (
    <div className="space-y-5 sm:space-y-7">
      <OverviewHero overview={d} builtAt={health.data?.built_at} />

      <OverviewKpis data={d} loading={overview.isPending} error={overview.error} onRetry={() => void overview.refetch()} />

      <OwnershipFlowCard />


      <div className="grid gap-5 sm:gap-6 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-5">
          <HsnLookupCard />
        </div>
        <div className="min-w-0 xl:col-span-7">
          <ValueChainLinks />
        </div>
      </div>

      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-left shadow-card transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:outline-none sm:px-5 [&::-webkit-details-marker]:hidden">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink" aria-hidden>
            <BookOpen className="size-4" />
          </span>
          <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">About the Guidebook, the mapping and the data</span>
          <ChevronDown className="size-4 text-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="mt-4 space-y-4">
          <InfoCards />
          {d ? <MappingNoteCard mappingSources={d.mapping_sources} mappingByLevel={d.mapping_by_level} freshness={d.data_freshness} /> : null}
        </div>
      </details>
    </div>
  );
}
