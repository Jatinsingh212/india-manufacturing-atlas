/**
 * ValueChainLinks - quick-link cards to the value chains (GET /api/valuechains), each with
 * its lead ministry, India's exports and India's share of world trade for the anchor HS code.
 */
import { Link } from 'react-router';
import clsx from 'clsx';
import { ArrowUpRight, Workflow } from 'lucide-react';
import { useValueChains } from '@/api/hooks';
import { isApiError } from '@/api/client';
import { Button, Card, EmptyState, ErrorState, MinistryPill, ProvenanceBadge, Skeleton } from '@/components';
import { fmtCode, fmtPct, fmtUSD } from '@/lib/format';
import { routes } from '@/lib/routes';
import { tradeProvenance } from '@/pages/explore/shared';

const HOME_LIMIT = 4;

export function ValueChainLinks() {
  const q = useValueChains();
  const chains = q.data ?? [];
  const shown = chains.slice(0, HOME_LIMIT);

  return (
    <Card
      title="Value chains"
      subtitle="Raw materials to finished goods, ministry by ministry"
      icon={Workflow}
      actions={
        <Button to={routes.valueChains()} size="sm" variant="ghost" iconRight={ArrowUpRight}>
          {chains.length > HOME_LIMIT ? `All ${chains.length} value chains` : 'All value chains'}
        </Button>
      }
    >
      {q.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : q.isError && !q.data && isApiError(q.error) && q.error.isNotFound ? (
        <EmptyState compact icon={Workflow} title="Value chains are not published on this server yet" message="The sector deep-dives appear here once the value-chain service is loaded." />
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : !chains.length ? (
        <p className="text-sm text-muted">No value chains have been loaded yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((c, i) => (
            <Link
              key={c.id}
              to={routes.valueChain(c.id)}
              className={clsx(
                'group min-w-0 flex-col rounded-2xl border border-line/80 bg-surface-2/60 p-4 transition-[border-color,background-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/30 hover:bg-surface hover:shadow-card sm:flex',
                // Phones get the four flagship chains; the remaining quick links and the full index stay one tap away.
                i >= 4 ? 'hidden sm:flex' : 'flex',
              )}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-ink group-hover:text-brand-ink">{c.name}</div>
                  <div className="mt-0.5 text-[11.5px] text-muted">
                    Anchor HS <span className="font-mono">{fmtCode(c.anchor_hs)}</span> · {c.n_stages} stages · {c.n_items} items
                  </div>
                </div>
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted transition-colors group-hover:border-brand/25 group-hover:bg-brand-soft group-hover:text-brand-ink">
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </span>
              </div>
              <div className="mt-4 flex items-end justify-between gap-2">
                <div>
                  <div className="text-[10.5px] font-semibold tracking-wide text-muted uppercase">India exports</div>
                  <div className="atlas-num mt-0.5 text-[15.5px] font-bold text-ink">{fmtUSD(c.india_exports)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10.5px] font-semibold tracking-wide text-muted uppercase">World share</div>
                  <div className="atlas-num mt-0.5 text-[15.5px] font-bold text-kpi">{fmtPct(c.india_share)}</div>
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {c.lead_ministry ? <MinistryPill ministry={c.lead_ministry} link={false} size="xs" /> : null}
                <ProvenanceBadge provenance={tradeProvenance(c.india_exports)} compact size="xs" className="ml-auto" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
