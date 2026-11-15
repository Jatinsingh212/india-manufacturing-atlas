/**
 * KpiTile - a headline number (magenta KPI numerals) with label, sub-line, icon,
 * provenance, optional sparkline trend and signed delta. Lay several out with <StatGrid>.
 *
 *   <KpiTile label="Total HS codes mapped" value={fmtNum(k.total_codes)} icon={Hash}
 *            sub={`${fmtNum(13110)} current HS lines`} provenance={overview.provenance.mapping} />
 *   <KpiTile label="India exports 2024" value={fmtUSD(x)} accent="brand"
 *            trend={series.map((s) => s.exports)} delta={{ value: 0.084, label: 'vs 2023' }} />
 *
 * Values are pre-formatted strings (use src/lib/format). Pass `value={null}` to show "Not available".
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import type { Provenance, ProvenanceStatus } from '@/api/types';
import { fmtPct, NA } from '@/lib/format';
import { ProvenanceBadge } from './Provenance';
import { Sparkline } from './Sparkline';
import { Skeleton } from './Loading';
import { Tooltip } from './Tooltip';
import { AnimatedValue } from './AnimatedValue';

export type KpiAccent = 'kpi' | 'brand' | 'ink' | 'ok' | 'bad';

export interface KpiDelta {
  /** Fraction (0.084 = +8.4 %). */
  value: number | null | undefined;
  /** e.g. "vs 2023" */
  label?: string;
  /** Whether an increase is good (green) - default true. Set false for imports / risk. */
  upIsGood?: boolean;
}

export interface KpiTileProps {
  label: ReactNode;
  /** Pre-formatted value; null / undefined renders "Not available". */
  value: ReactNode | null | undefined;
  /** Secondary line (baseline, unit, context). */
  sub?: ReactNode;
  icon?: LucideIcon;
  accent?: KpiAccent;
  provenance?: Provenance | null;
  /** Status only (when no full provenance object exists). */
  status?: ProvenanceStatus;
  /** Sparkline values (e.g. 2018-2024). */
  trend?: ReadonlyArray<number | null | undefined>;
  delta?: KpiDelta;
  /** Definition shown in a tooltip on the label. */
  hint?: ReactNode;
  loading?: boolean;
  /** Makes the tile a link. */
  to?: string;
  onClick?: () => void;
  size?: 'md' | 'lg';
  className?: string;
}

const ACCENT: Record<KpiAccent, string> = {
  kpi: 'text-kpi',
  brand: 'text-brand-ink',
  ink: 'text-ink',
  ok: 'text-ok-ink',
  bad: 'text-bad-ink',
};

const GLOW: Record<KpiAccent, string> = {
  kpi: 'before:bg-kpi-soft',
  brand: 'before:bg-brand-soft',
  ink: 'before:bg-surface-3',
  ok: 'before:bg-ok-soft',
  bad: 'before:bg-bad-soft',
};

function DeltaChip({ delta }: { delta: KpiDelta }) {
  if (typeof delta.value !== 'number' || !Number.isFinite(delta.value)) return null;
  const up = delta.value > 0;
  const good = delta.value === 0 ? null : up === (delta.upIsGood ?? true);
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-0.5 text-xs font-medium',
        good === null ? 'text-muted' : good ? 'text-ok-ink' : 'text-bad-ink',
      )}
    >
      {delta.value !== 0 ? <Icon className="size-3.5" aria-hidden /> : null}
      {fmtPct(delta.value, { signed: true, digits: 1 })}
      {delta.label ? <span className="font-normal text-muted">&nbsp;{delta.label}</span> : null}
    </span>
  );
}

export function KpiTile({
  label,
  value,
  sub,
  icon: Icon,
  accent = 'kpi',
  provenance,
  status,
  trend,
  delta,
  hint,
  loading,
  to,
  onClick,
  size = 'md',
  className,
}: KpiTileProps) {
  const missing = value === null || value === undefined || value === '';
  const body = (
    <>
      <div className="flex items-start gap-2">
        <div className="line-clamp-2 min-w-0 flex-1 text-[11.5px] leading-4 font-semibold text-ink-2 sm:text-[12.5px] sm:leading-5">
          {hint ? (
            <Tooltip content={hint}>
              <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4">{label}</span>
            </Tooltip>
          ) : (
            label
          )}
        </div>
        {Icon ? (
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-brand-soft to-surface text-brand-ink ring-1 ring-brand/10 sm:size-8" aria-hidden>
            <Icon className="size-3.5 sm:size-4" />
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2 sm:gap-3">
        {loading ? (
          <Skeleton className={size === 'lg' ? 'h-10 w-32' : 'h-8 w-24'} />
        ) : (
          <div
            className={clsx(
              'atlas-num min-w-0 leading-none font-extrabold tracking-[-0.035em]',
              size === 'lg'
                ? 'text-[clamp(1.65rem,6.8vw,2.15rem)]'
                : 'text-[clamp(1.3rem,5.6vw,1.8rem)]',
              missing ? 'text-[14px]! font-medium! text-na-ink sm:text-[15px]!' : ACCENT[accent],
            )}
          >
            {missing ? NA : typeof value === 'string' ? <AnimatedValue value={value} /> : value}
          </div>
        )}
        {trend && !loading ? <Sparkline values={trend} className="mb-0.5 hidden shrink-0 sm:block" /> : null}
      </div>
      {(sub || delta || provenance || status) && !loading ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-muted sm:mt-2.5 sm:text-xs">
          {delta ? <DeltaChip delta={delta} /> : null}
          {sub ? <span className="min-w-0">{sub}</span> : null}
          {provenance || status ? <ProvenanceBadge provenance={provenance} status={status} size="xs" className="ml-auto" /> : null}
        </div>
      ) : null}
    </>
  );

  const cls = clsx(
    'relative block min-w-0 overflow-hidden rounded-2xl border border-line/90 bg-surface p-3.5 shadow-card sm:p-5',
    'before:pointer-events-none before:absolute before:-top-12 before:-right-10 before:size-32 before:rounded-full before:opacity-50 before:blur-2xl before:content-[\'\']',
    GLOW[accent],
    (to || onClick) &&
      'text-left transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/35 hover:shadow-[0_18px_34px_-24px_rgba(10,28,53,0.4)] active:translate-y-0 active:scale-[0.995]',
    className,
  );
  if (to) {
    return (
      <Link to={to} className={cls}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={clsx(cls, 'w-full')}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

export interface StatGridProps {
  children: ReactNode;
  /** Columns at the widest breakpoint (default 4). Collapses to 2 / 1 on smaller screens. */
  cols?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

const COLS: Record<NonNullable<StatGridProps['cols']>, string> = {
  2: 'grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'xl:grid-cols-4',
  5: 'lg:grid-cols-3 xl:grid-cols-5',
  6: 'lg:grid-cols-3 xl:grid-cols-6',
};

/** Responsive grid for KpiTiles: two columns on phones, then the requested count. */
export function StatGrid({ children, cols = 4, className }: StatGridProps) {
  return <div className={clsx('grid grid-cols-2 gap-2.5 sm:gap-4', COLS[cols], className)}>{children}</div>;
}
