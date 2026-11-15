/**
 * CountryBars - ranked horizontal bars for `CountryValue[]` (top suppliers, markets, destinations,
 * sources). One series = one hue (slot 1 blue); India is emphasised in the brand magenta and labelled,
 * so the highlight never relies on colour alone. Values are printed at the bar end (no tooltip gate).
 *
 *   <CountryBars items={detail.world_top_suppliers} />                         // India appended if outside top 10
 *   <CountryBars items={detail.top_destinations} limit={5} valueFormat={(v) => fmtUSD(v)} />
 */
import clsx from 'clsx';
import type { CountryValue } from '@/api/types';
import { fmtPct, fmtUSD } from '@/lib/format';
import { EmptyState } from './EmptyState';

export interface CountryBarsProps {
  items: ReadonlyArray<CountryValue> | null | undefined;
  /** Rows to show (default 10). An India row beyond the limit is still shown after a gap. */
  limit?: number;
  valueFormat?: (v: number) => string;
  /** Show share (fraction) next to the value (default true). */
  showShare?: boolean;
  /** Show the rank number (default true). */
  showRank?: boolean;
  /** ISO3 code to emphasise (default 'IND'). Set null to disable. */
  highlightIso3?: string | null;
  onCountryClick?: (item: CountryValue) => void;
  emptyText?: string;
  className?: string;
}

function isHighlight(c: CountryValue, iso3: string | null): boolean {
  if (!iso3) return false;
  return (c.iso3 ?? '').toUpperCase() === iso3.toUpperCase() || (iso3 === 'IND' && c.country_id === 'asind');
}

export function CountryBars({
  items,
  limit = 10,
  valueFormat = (v) => fmtUSD(v),
  showShare = true,
  showRank = true,
  highlightIso3 = 'IND',
  onCountryClick,
  emptyText = 'No partner data available',
  className,
}: CountryBarsProps) {
  const list = items ?? [];
  if (!list.length) return <EmptyState compact title={emptyText} />;
  const top = list.slice(0, limit);
  const extra = list.slice(limit).filter((c) => isHighlight(c, highlightIso3));
  const max = Math.max(...list.map((c) => c.value || 0), 1);

  const row = (c: CountryValue, i: number) => {
    const hi = isHighlight(c, highlightIso3);
    const pct = Math.max(1.5, (Math.max(0, c.value) / max) * 100);
    const Tag = onCountryClick ? 'button' : 'div';
    return (
      <Tag
        key={`${c.country_id}-${i}`}
        type={onCountryClick ? 'button' : undefined}
        onClick={onCountryClick ? () => onCountryClick(c) : undefined}
        className={clsx(
          'grid w-full grid-cols-[1.15rem_minmax(4.5rem,7rem)_1fr] items-center gap-1.5 rounded-md px-1 py-[3px] text-left text-[12.5px] min-[360px]:grid-cols-[1.5rem_minmax(5.5rem,9rem)_1fr] min-[360px]:gap-2',
          hi && 'bg-kpi-soft',
          onCountryClick && 'hover:bg-surface-3',
        )}
      >
        <span className="text-right text-[11px] text-muted atlas-num">{showRank ? (c.rank ?? i + 1) : ''}</span>
        <span className={clsx('truncate', hi ? 'font-semibold text-ink' : 'text-ink-2')} title={c.country}>
          {c.country}
          {hi && !/india/i.test(c.country) ? <span className="ml-1 text-[10.5px] font-semibold text-kpi uppercase">India</span> : null}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-3 min-w-0 flex-1">
            <span
              className="block h-full rounded-r-[4px]"
              style={{ width: `${pct}%`, backgroundColor: hi ? 'var(--atlas-india)' : 'var(--atlas-series-1)' }}
              aria-hidden
            />
          </span>
          <span className="shrink-0 text-right text-[12px] font-medium whitespace-nowrap text-ink atlas-num">
            {valueFormat(c.value)}
            {showShare && c.share !== null && c.share !== undefined ? <span className="ml-1 font-normal text-muted">{fmtPct(c.share, { digits: 1 })}</span> : null}
          </span>
        </span>
      </Tag>
    );
  };

  return (
    <div className={clsx('flex flex-col', className)} role="list">
      {top.map(row)}
      {extra.length ? (
        <>
          <div className="py-0.5 pl-8 text-[11px] text-muted" aria-hidden>
            ⋯
          </div>
          {extra.map((c, i) => row(c, limit + i))}
        </>
      ) : null}
    </div>
  );
}
