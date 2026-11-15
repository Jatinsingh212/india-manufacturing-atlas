/**
 * ScoreBar - horizontal 0-100 meter for model scores.
 * - scale="sequential" (default): single-hue blue ramp; for "higher = more" scores
 *   (export potential, substitution).
 * - scale="risk": good -> warning -> serious -> critical; for "higher = worse" scores
 *   (vulnerability, import dependency). The value is always printed, so colour is never the only cue.
 *
 *   <ScoreBar value={scores.export_potential_score} />
 *   <ScoreBar value={item.vulnerability_score} scale="risk" label="Vulnerability" />
 */
import clsx from 'clsx';
import { fmtScore } from '@/lib/format';
import { riskColor, sequentialColor } from '@/lib/theme';

export interface ScoreBarProps {
  value: number | null | undefined;
  scale?: 'sequential' | 'risk';
  label?: string;
  /** Print the number (default true). */
  showValue?: boolean;
  size?: 'sm' | 'md';
  /** Fixed bar width in px (default fills the container, min 64). */
  width?: number;
  className?: string;
}

export function ScoreBar({ value, scale = 'sequential', label, showValue = true, size = 'sm', width, className }: ScoreBarProps) {
  const has = typeof value === 'number' && Number.isFinite(value);
  const v = has ? Math.max(0, Math.min(100, value as number)) : 0;
  const color = scale === 'risk' ? riskColor(v) : sequentialColor(v);
  const text = has ? fmtScore(value) : 'n/a';
  return (
    <div className={clsx('flex min-w-0 items-center gap-2', className)} title={label ? `${label}: ${has ? text : 'Not available'} / 100` : undefined}>
      {label ? <span className="w-28 shrink-0 truncate text-xs text-ink-2">{label}</span> : null}
      <div
        className={clsx('relative min-w-16 flex-1 overflow-hidden rounded-full', size === 'sm' ? 'h-1.5' : 'h-2.5', scale === 'risk' ? 'bg-surface-3' : 'bg-info-soft')}
        style={width ? { width, flex: 'none' } : undefined}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={has ? Math.round(v) : undefined}
        aria-label={label ?? 'Score'}
      >
        {has ? <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(v, 2)}%`, backgroundColor: color }} /> : null}
      </div>
      {showValue ? <span className={clsx('w-7 shrink-0 text-right text-xs font-semibold atlas-num', has ? 'text-ink' : 'text-muted')}>{text}</span> : null}
    </div>
  );
}
