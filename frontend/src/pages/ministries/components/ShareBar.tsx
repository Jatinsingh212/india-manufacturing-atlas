/**
 * ShareBar - a value with an inline magnitude bar for dense tables (the ministries index "share bars").
 * One hue (series slot 1) for every row, the residual bucket in the de-emphasis grey; the formatted
 * value and its share are always printed, so the bar is never the only cue.
 *
 *   <ShareBar value={m.codes} max={maxCodes} total={totalCodes} format={(v) => fmtNum(v)} />
 */
import clsx from 'clsx';
import { NA_SHORT } from '@/lib/format';
import { fmtShare } from '../utils';

export interface ShareBarProps {
  value: number | null | undefined;
  /** Largest value in the column (bar length = value / max). */
  max: number;
  /** Column total; when given, the share of total is printed after the value. */
  total?: number | null;
  format: (v: number) => string;
  muted?: boolean;
  className?: string;
}

export function ShareBar({ value, max, total, format, muted, className }: ShareBarProps) {
  const has = typeof value === 'number' && Number.isFinite(value);
  const pct = has && max > 0 ? Math.max(1.5, (Math.max(0, value as number) / max) * 100) : 0;
  const share = has && total ? (value as number) / total : null;
  return (
    <div className={clsx('flex min-w-0 items-center justify-end gap-2 sm:min-w-[9rem]', className)}>
      <span className="hidden h-2 w-16 shrink-0 overflow-hidden rounded-full bg-surface-3 sm:block" aria-hidden>
        {has ? (
          <span
            className="block h-full rounded-r-[4px]"
            style={{ width: `${pct}%`, backgroundColor: muted ? 'var(--atlas-line-strong)' : 'var(--atlas-series-1)' }}
          />
        ) : null}
      </span>
      <span className="min-w-0 text-right whitespace-nowrap atlas-num sm:min-w-[4.5rem]">
        {has ? format(value as number) : <span className="text-muted">{NA_SHORT}</span>}
        {share !== null ? <span className="ml-1 text-[11px] text-muted">{fmtShare(share)}</span> : null}
      </span>
    </div>
  );
}
