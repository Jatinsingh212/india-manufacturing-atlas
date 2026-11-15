/**
 * Sparkline - tiny inline trend (SVG). The line uses a de-emphasis hue and the latest point is marked
 * in the accent, per the dataviz stat-tile spec. Null values break the line (no invented points).
 *
 *   <Sparkline values={series.map((s) => s.exports)} />
 */
import { useId } from 'react';
import clsx from 'clsx';

export interface SparklineProps {
  values: ReadonlyArray<number | null | undefined>;
  width?: number;
  height?: number;
  /** Line colour (CSS colour or var). Default: muted ink. */
  color?: string;
  /** Colour of the last-point marker. Default: series-1 blue. */
  accent?: string;
  /** Fill a ~10 % wash under the line. */
  area?: boolean;
  /** Accessible description, e.g. "Exports 2018-2024, rising". */
  ariaLabel?: string;
  className?: string;
}

export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = 'var(--atlas-muted)',
  accent = 'var(--atlas-series-1)',
  area = true,
  ariaLabel,
  className,
}: SparklineProps) {
  const gradId = useId();
  const nums = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const finite = nums.filter((v): v is number => v !== null);
  if (finite.length < 2) {
    return <svg width={width} height={height} className={className} role="img" aria-label={ariaLabel ?? 'Trend not available'} />;
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const pad = 3;
  const span = max - min || 1;
  const stepX = (width - pad * 2) / Math.max(1, nums.length - 1);
  const x = (i: number) => pad + i * stepX;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  // Split into continuous segments at nulls.
  const segments: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  nums.forEach((v, i) => {
    if (v === null) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push([x(i), y(v)]);
  });
  if (cur.length) segments.push(cur);

  let lastIdx = -1;
  for (let i = nums.length - 1; i >= 0; i -= 1) {
    if (nums[i] !== null) {
      lastIdx = i;
      break;
    }
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={clsx('overflow-visible', className)} role="img" aria-label={ariaLabel ?? 'Trend'}>
      {area ? (
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.16} />
            <stop offset="100%" stopColor={accent} stopOpacity={0} />
          </linearGradient>
        </defs>
      ) : null}
      {segments.map((seg, k) => {
        const d = seg.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
        return (
          <g key={k}>
            {area && seg.length > 1 ? (
              <path d={`${d} L${seg[seg.length - 1][0].toFixed(1)},${height} L${seg[0][0].toFixed(1)},${height} Z`} fill={`url(#${gradId})`} />
            ) : null}
            <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
      {lastIdx >= 0 ? (
        <circle cx={x(lastIdx)} cy={y(nums[lastIdx] as number)} r={3} fill={accent} stroke="var(--atlas-surface)" strokeWidth={1.5} />
      ) : null}
    </svg>
  );
}
