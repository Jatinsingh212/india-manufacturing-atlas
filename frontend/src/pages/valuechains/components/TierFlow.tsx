/**
 * TierFlow - the "how deep does the supply chain run" panel of the value-chain deep-dive.
 *
 * The stage flow (Raw Materials -> Components -> Finished Goods) says what the product is made of.
 * The tier flow says how many hand-offs lie behind those inputs: Tier 1 are the direct suppliers of
 * the manufacturer, Tier 2 the suppliers of those suppliers, Tier 3 the basic materials and commodities
 * underneath them. Each tier shows the study's definition and example supplier types, and below it the
 * Atlas's HS-coded items with India's trade on each line (so a reader can see which tier is actually
 * import-exposed rather than being told that it is).
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Layers, type LucideIcon } from 'lucide-react';
import type { ValueChainTier, ValueChainTierItem } from '@/api/types';
import { Badge, Card, CodeLink, EmptyState, MinistryPill } from '@/components';
import { fmtUSD } from '@/lib/format';

const TONE: Record<number, string> = {
  1: 'bg-brand',
  2: 'bg-brand/60',
  3: 'bg-brand/35',
};

export interface TierFlowProps {
  tiers: ValueChainTier[];
  className?: string;
}

/** India's imports minus exports on one tier line: a positive number is a net import. */
function netBalance(item: ValueChainTierItem): number | null {
  if (item.exports == null && item.imports == null) return null;
  return (item.imports ?? 0) - (item.exports ?? 0);
}

function TierItems({ items }: { items: ValueChainTierItem[] }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((i) => {
        const bal = netBalance(i);
        return (
          <li key={i.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-ink">{i.item_name}</span>
                {i.hs_code ? <CodeLink code={i.hs_code} /> : null}
              </div>
              {i.description ? <div className="mt-0.5 text-xs text-muted">{i.description}</div> : null}
              {i.ministries.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {i.ministries.map((m) => (
                    <MinistryPill key={m.id} ministry={m} size="xs" />
                  ))}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-4 text-right text-xs tabular-nums">
              <div>
                <div className="text-[10.5px] text-muted">India imports</div>
                <div className="font-semibold text-ink">{fmtUSD(i.imports)}</div>
              </div>
              <div>
                <div className="text-[10.5px] text-muted">India exports</div>
                <div className="font-semibold text-ink">{fmtUSD(i.exports)}</div>
              </div>
              {bal != null ? (
                <div>
                  <div className="text-[10.5px] text-muted">Balance</div>
                  <div className={bal > 0 ? 'font-semibold text-rose-600' : 'font-semibold text-emerald-600'}>
                    {fmtUSD(bal, { signed: true })}
                  </div>
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function TierCard({ tier, icon: Icon }: { tier: ValueChainTier; icon: LucideIcon }) {
  const [open, setOpen] = useState(true);
  const totals = useMemo(() => {
    const sum = (pick: (i: ValueChainTierItem) => number | null) =>
      tier.items.reduce((acc, i) => {
        const v = pick(i);
        return v == null ? acc : acc + v;
      }, 0);
    const imports = tier.items.some((i) => i.imports != null);
    const exports = tier.items.some((i) => i.exports != null);
    return {
      imports: imports ? sum((i) => i.imports) : null,
      exports: exports ? sum((i) => i.exports) : null,
      nItems: tier.items.length,
    };
  }, [tier.items]);

  return (
    <li className="rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left hover:bg-surface-2/60"
      >
        <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${TONE[tier.tier_level] ?? 'bg-brand/40'} text-white`}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-bold text-ink">{tier.name}</span>
            <Badge tone="outline" size="xs">
              {totals.nItems} {totals.nItems === 1 ? 'item' : 'items'}
            </Badge>
          </span>
          {tier.description ? <span className="mt-1 block text-xs leading-relaxed text-ink-2">{tier.description}</span> : null}
          {tier.examples.length ? (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {tier.examples.map((e) => (
                <span key={e} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2">
                  {e}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="hidden text-right text-xs tabular-nums sm:block">
            <span className="block text-[10.5px] text-muted">Imports / exports</span>
            <span className="font-semibold text-ink">
              {fmtUSD(totals.imports)} / {fmtUSD(totals.exports)}
            </span>
          </span>
          {open ? <ChevronUp className="size-4 text-muted" aria-hidden /> : <ChevronDown className="size-4 text-muted" aria-hidden />}
        </span>
      </button>
      {open ? (
        <div className="border-t border-line px-3.5 pb-2 pt-1">
          {tier.items.length ? <TierItems items={tier.items} /> : <p className="py-3 text-xs text-muted">No items mapped for this tier.</p>}
        </div>
      ) : null}
    </li>
  );
}

export function TierFlow({ tiers, className }: TierFlowProps) {
  if (!tiers.length) {
    return (
      <Card className={className}>
        <EmptyState icon={Layers} title="No supplier tiers mapped" compact message="Add tiers to data/curated/supply_tiers.json and rebuild." />
      </Card>
    );
  }
  return (
    <Card
      className={className}
      title="Supply chain depth"
      subtitle="How many hand-offs lie behind the finished product: Tier 1 are the direct suppliers, Tier 3 the basic materials and commodities underneath them"
    >
      <ol className="space-y-2.5">
        {tiers.map((t) => (
          <TierCard key={t.tier_level} tier={t} icon={Layers} />
        ))}
      </ol>
      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        Trade figures are the HS6 lines that carry each item&rsquo;s HS code (DGFT/DGCIS TRADESTAT for India&rsquo;s flows,
        CEPII BACI for the world); a tier total is the sum of its items, so a line may be counted twice when two
        items share an HS6.
      </p>
    </Card>
  );
}
