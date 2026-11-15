/**
 * Loading states.
 * - <Spinner />                     inline spinner
 * - <LoadingBlock label height />   centred spinner + label filling a card / section
 * - <Skeleton className="h-4 w-32" /> shimmering placeholder block
 * - <SkeletonRows rows={6} />       table-like placeholder
 *
 * Prefer keeping the previous render while refetching (React Query `placeholderData: keepPreviousData`)
 * and dimming it, instead of flashing a skeleton (dataviz rule: refetch keeps the frame).
 */
import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return <LoaderCircle className={clsx('size-4 animate-spin text-brand-ink', className)} aria-label={label ?? 'Loading'} role="status" />;
}

export interface LoadingBlockProps {
  label?: string;
  /** Minimum height in px (default 160). */
  height?: number;
  className?: string;
}

export function LoadingBlock({ label = 'Loading…', height = 160, className }: LoadingBlockProps) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-2 text-sm text-muted', className)} style={{ minHeight: height }} role="status" aria-live="polite">
      <LoaderCircle className="size-6 animate-spin text-brand-ink" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-surface-3', className)} aria-hidden />;
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx('space-y-2', className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Thin indeterminate progress bar (top of the page during navigation / background refetch). */
export function ProgressBar({ active, className }: { active: boolean; className?: string }) {
  return (
    <div className={clsx('pointer-events-none h-0.5 w-full overflow-hidden', className)} aria-hidden>
      {active ? <div className="h-full w-1/3 animate-progress bg-kpi" /> : null}
    </div>
  );
}
