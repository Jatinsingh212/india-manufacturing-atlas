/**
 * LabelledProvenance - a provenance badge preceded by what it qualifies ("Ministry mapping", "Trade").
 * Used wherever two badges sit side by side (a footer with a mapping badge and a trade badge)
 * or where the full source label is too long for a header line: the badge keeps its tooltip with the
 * full source, the short label says which number it speaks for.
 *
 *   <LabelledProvenance label="Ministry mapping" provenance={mapping} />
 */
import clsx from 'clsx';
import type { Provenance } from '@/api/types';
import { ProvenanceBadge } from '@/components';

export interface LabelledProvenanceProps {
  label: string;
  provenance: Provenance | null | undefined;
  size?: 'xs' | 'sm';
  className?: string;
}

export function LabelledProvenance({ label, provenance, size = 'xs', className }: LabelledProvenanceProps) {
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap', className)}>
      <span className={clsx('font-medium text-ink-2', size === 'xs' ? 'text-[11px]' : 'text-xs')}>{label}</span>
      <ProvenanceBadge provenance={provenance} size={size} />
    </span>
  );
}
