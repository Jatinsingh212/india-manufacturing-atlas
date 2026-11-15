/**
 * Trade cards of the value-chain deep-dive ("Top global suppliers", "Top global markets", "Major export
 * destinations of India", "Major import partners of India", "India's top export categories"):
 * - live CEPII BACI values with shares and ranks, India highlighted in magenta (CountryBars);
 * - an expand control to see up to 10 rows.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Info, type LucideIcon } from 'lucide-react';
import type { CountryValue, Provenance } from '@/api/types';
import { Button, Card, CodeLink, CountryBars, EmptyState, ProvenanceBadge } from '@/components';
import { fmtUSD } from '@/lib/format';
import { splitCommonPrefix } from '../utils';

/**
 * TradeEditionNote - states the HS edition behind every trade card, because OEC's public country profiles
 * default to HS 2017 while the Atlas uses the HS 2022 BACI cube for 2022-2024. Without this note, an HS17
 * page looks like a contradictory source even though both views come from the same BACI data.
 */
export function TradeEditionNote({ year, className }: { year: number; className?: string }) {
  return (
    <Card className={className} tone="subtle" padding="sm">
      <div className="flex items-start gap-2.5">
        <Info className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden />
        <div className="space-y-1 text-xs leading-relaxed text-ink-2">
          <p>
            <span className="font-semibold text-ink">HS 2022 trade edition.</span> The supplier, market and partner
            cards use CEPII BACI under the HS 2022 classification for {year}; India&rsquo;s export categories are the
            official DGCIS TRADESTAT figures for FY{year}-{String(year + 1).slice(-2)}. OEC country profiles default to HS 2017; change{' '}
            <span className="font-medium text-ink">Harmonized System Version</span> to{' '}
            <span className="font-medium text-ink">HS22</span> to compare the same classification.
          </p>
          <p className="text-muted">
            HS editions move a small number of products between codes, so totals, ranks and partner shares can
            differ slightly even when both views use the same BACI data.
          </p>
        </div>
      </div>
    </Card>
  );
}

export interface CountryCardProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  items: ReadonlyArray<CountryValue>;
  trade: Provenance;
  /** Extra line under the bars (e.g. "India's rank is 8th in global suppliers"). */
  note?: ReactNode;
  emptyText: string;
  /** Rows before "Show more". */
  limit?: number;
  className?: string;
}

export function CountryCard({ title, subtitle, icon, items, trade, note, emptyText, limit = 5, className }: CountryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? Math.max(limit, items.length) : limit;
  return (
    <Card
      className={className}
      padding="sm"
      icon={icon}
      title={title}
      subtitle={subtitle ?? 'US$, latest year'}
      actions={<ProvenanceBadge provenance={trade} size="xs" compact />}
    >
      {items.length ? (
        <>
          <CountryBars items={items} limit={shown} />
          {items.length > limit ? (
            <Button variant="link" size="xs" className="mt-1 ml-8" iconRight={expanded ? ChevronUp : ChevronDown} onClick={() => setExpanded((e) => !e)}>
              {expanded ? `Show top ${limit}` : `Show all ${items.length}`}
            </Button>
          ) : null}
          {note ? <div className="mt-2 border-t border-line pt-2">{note}</div> : null}
        </>
      ) : (
        <>
          <EmptyState compact title={emptyText} message="No partner rows in the latest trade year." />
          {note ? <div className="mt-2 border-t border-line pt-2">{note}</div> : null}
        </>
      )}
    </Card>
  );
}

export interface CategoryRow {
  code: string | null;
  label: string;
  value: number | null;
  /** Unshortened label for the hover title (defaults to `label`). */
  fullLabel?: string;
}

/** Ranked HTML bars for labelled categories (top export categories): label, code, bar, value. */
export function RankedBars({ rows, emptyText }: { rows: CategoryRow[]; emptyText: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  if (!rows.length) return <EmptyState compact title={emptyText} />;
  return (
    <ol className="space-y-2.5">
      {rows.map((r, i) => {
        const pct = typeof r.value === 'number' ? Math.max(1.5, (Math.max(0, r.value) / max) * 100) : 0;
        return (
          <li key={`${r.code ?? r.label}-${i}`} className="text-[12.5px]">
            <div className="flex items-baseline gap-2">
              <span className="w-4 shrink-0 text-right text-[11px] text-muted atlas-num">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-ink" title={r.fullLabel ?? r.label}>
                {r.label}
              </span>
              <span className="shrink-0 font-medium whitespace-nowrap text-ink atlas-num">{fmtUSD(r.value)}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 pl-6">
              <span className="h-2.5 min-w-0 flex-1">
                <span className="block h-full rounded-r-[4px]" style={{ width: `${pct}%`, backgroundColor: 'var(--atlas-series-1)' }} aria-hidden />
              </span>
              {r.code ? <CodeLink code={r.code} className="shrink-0 text-[11px]" /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface CategoryCardProps {
  title: string;
  icon?: LucideIcon;
  rows: CategoryRow[];
  trade: Provenance;
  className?: string;
}

/**
 * "India's top <name> categories exports" (top 5 HS6 under the anchor by India's exports). HS labels
 * that share their opening words ("Rubber; new pneumatic tyres, of a kind used on …") show that phrase
 * once in the subtitle and only the distinguishing remainder on each bar (full label on hover).
 */
export function CategoryCard({ title, icon, rows, trade, className }: CategoryCardProps) {
  const { prefix, rest } = splitCommonPrefix(rows.map((r) => r.label));
  const shown = rows.map((r, i) => ({ ...r, label: rest[i] ?? r.label, fullLabel: r.label }));
  return (
    <Card
      className={className}
      padding="sm"
      icon={icon}
      title={title}
      subtitle={prefix ? `${prefix} … · DGCIS TRADESTAT, by India's exports, US$` : "Top subheadings under the anchor code by India's exports · DGCIS TRADESTAT, US$"}
      actions={<ProvenanceBadge provenance={trade} size="xs" compact />}
    >
      <RankedBars rows={shown} emptyText="No export categories with recorded trade" />
    </Card>
  );
}
