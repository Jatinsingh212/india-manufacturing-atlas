/**
 * Provenance UI - the data-status legend on every number (SPEC section 1, "Provenance object"):
 *   Verified (green) / Not verified (red) / Not available (orange).
 *
 * - <ProvenanceBadge provenance={trade.provenance} />    pill with icon + label (+ source tooltip)
 * - <ProvenanceBadge status="not_available" compact />   icon-only dot with tooltip
 * - <ProvenanceDot status=... />                         7 px dot for dense tables (label in tooltip)
 * - <ProvenanceLegend />                                 the three-item legend (footer, sector pages)
 * - <ModelEstimateTag method="..." />                    "Model estimate" chip linking to /about#methodology
 */
import clsx from 'clsx';
import { CircleCheck, CircleDashed, CircleX, FlaskConical, type LucideIcon } from 'lucide-react';
import type { Provenance, ProvenanceStatus } from '@/api/types';
import { PROVENANCE_LABELS } from '@/lib/theme';
import { Tooltip } from './Tooltip';

const STATUS_STYLE: Record<ProvenanceStatus, { icon: LucideIcon; pill: string; dot: string; iconColor: string }> = {
  verified: { icon: CircleCheck, pill: 'bg-ok-soft text-ok-ink', dot: 'bg-ok', iconColor: 'text-ok' },
  not_verified: { icon: CircleX, pill: 'bg-bad-soft text-bad-ink', dot: 'bg-bad', iconColor: 'text-bad' },
  not_available: { icon: CircleDashed, pill: 'bg-na-soft text-na-ink', dot: 'bg-na', iconColor: 'text-na' },
};

const SOURCE_LABELS: Record<string, string> = {
  baci: 'CEPII BACI (via OEC)',
  tradestat: 'DGFT/DGCIS TRADESTAT (official 8-digit trade)',
  wits: 'WITS / UNCTAD TRAINS',
  gst_master: 'GST HSN master',
  hs_nomenclature: 'WCO HS2022 nomenclature',
  unido_indstat: 'UNIDO INDSTAT 2026',
  rubber_board: 'Rubber Board of India',
  atma: 'Automotive Tyre Manufacturers Association',
  dpiit_guidebook: 'DPIIT Guidebook on HSN Code Mapping (16.12.2025)',
  dgft_itc_hs: 'DGFT ITC-HS policy (public portal)',
  rule: 'Provisional rule-based mapping',
  official_upload: 'Official mapping upload (DPIIT)',
  manual: 'Manual review',
  unmapped: 'Not listed in the DPIIT Guidebook',
  model: 'Model estimate',
  comtrade: 'UN Comtrade',
};

/**
 * Label for trade figures (same text as the API's `tradestat` provenance): India's exports and imports are the
 * official DGFT/DGCIS TRADESTAT financial-year series; world totals and partner tables stay CEPII BACI.
 */
export function tradeSourceLabel(year: number): string {
  return `DGFT/DGCIS TRADESTAT FY${year}-${String(year + 1).slice(-2)} (India's trade); world trade: CEPII BACI ${year}`;
}

/** Human label for a provenance `source` id. */
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return 'Unknown source';
  return SOURCE_LABELS[source] ?? source;
}

function normaliseStatus(s: string | null | undefined): ProvenanceStatus {
  return s === 'verified' || s === 'not_verified' || s === 'not_available' ? s : 'not_available';
}

function describe(p: Provenance | null | undefined, status: ProvenanceStatus): string {
  if (!p) return PROVENANCE_LABELS[status];
  const parts = [PROVENANCE_LABELS[status], p.label || sourceLabel(p.source)];
  if (p.year && !(p.label ?? '').includes(String(p.year))) parts.push(String(p.year));
  return parts.join(' · ');
}

export interface ProvenanceBadgeProps {
  /** Full provenance object (preferred). */
  provenance?: Provenance | null;
  /** Or just a status. Missing both = Not available. */
  status?: ProvenanceStatus | string | null;
  /** Show the source label inside the pill ("Verified · CEPII BACI 2024"). */
  showSource?: boolean;
  /** Icon-only (tooltip carries the text). */
  compact?: boolean;
  size?: 'xs' | 'sm';
  className?: string;
}

export function ProvenanceBadge({ provenance, status, showSource, compact, size = 'sm', className }: ProvenanceBadgeProps) {
  const isModel = provenance?.source === 'model' && provenance.status !== 'verified';
  if (isModel) {
    const text = provenance.label || 'Model estimate (Atlas methodology)';
    if (compact) {
      return (
        <Tooltip content={text}>
          <span className={clsx('inline-flex items-center text-brand-ink', className)} aria-label={text} role="img">
            <FlaskConical className={size === 'xs' ? 'size-3.5' : 'size-4'} aria-hidden />
          </span>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={text}>
        <span
          className={clsx(
            'inline-flex max-w-full items-center gap-1 rounded-full font-medium whitespace-nowrap bg-brand-soft text-brand-ink border border-brand/20',
            size === 'xs' ? 'h-[18px] px-1.5 text-[10.5px]' : 'h-5 px-2 text-[11px]',
            className,
          )}
        >
          <FlaskConical className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">Model estimate</span>
        </span>
      </Tooltip>
    );
  }

  const st = normaliseStatus(provenance?.status ?? status ?? null);
  const style = STATUS_STYLE[st];
  const Icon = style.icon;
  const text = describe(provenance, st);
  if (compact) {
    return (
      <Tooltip content={text}>
        <span className={clsx('inline-flex items-center', style.iconColor, className)} aria-label={text} role="img">
          <Icon className={size === 'xs' ? 'size-3.5' : 'size-4'} aria-hidden />
        </span>
      </Tooltip>
    );
  }
  const label = showSource && provenance ? text : PROVENANCE_LABELS[st];
  return (
    <Tooltip content={showSource ? null : text}>
      <span
        className={clsx(
          'inline-flex max-w-full items-center gap-1 rounded-full font-medium whitespace-nowrap',
          size === 'xs' ? 'h-[18px] px-1.5 text-[10.5px]' : 'h-5 px-2 text-[11px]',
          style.pill,
          className,
        )}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </span>
    </Tooltip>
  );
}

/** Tiny status dot for dense tables; label in the tooltip and aria-label. */
export function ProvenanceDot({ status, provenance, className }: { status?: ProvenanceStatus | string | null; provenance?: Provenance | null; className?: string }) {
  if (provenance?.source === 'model' && provenance.status !== 'verified') {
    const text = provenance.label || 'Model estimate (Atlas methodology)';
    return (
      <Tooltip content={text}>
        <span role="img" aria-label={text} className={clsx('inline-block size-[7px] shrink-0 rounded-full bg-brand', className)} />
      </Tooltip>
    );
  }
  const st = normaliseStatus(provenance?.status ?? status ?? null);
  const text = describe(provenance, st);
  return (
    <Tooltip content={text}>
      <span role="img" aria-label={text} className={clsx('inline-block size-[7px] shrink-0 rounded-full', STATUS_STYLE[st].dot, className)} />
    </Tooltip>
  );
}

export interface ProvenanceLegendProps {
  className?: string;
  /** Smaller text, no title. */
  compact?: boolean;
  /** Light text for navy backgrounds. */
  onDark?: boolean;
  title?: string;
}

/** The three-item legend: Verified / Not verified / Not available. */
export function ProvenanceLegend({ className, compact, onDark, title = 'Data status' }: ProvenanceLegendProps) {
  const statuses: ProvenanceStatus[] = ['verified', 'not_verified', 'not_available'];
  return (
    <div className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1', compact ? 'text-[11px]' : 'text-xs', className)} role="list" aria-label={title}>
      {!compact ? <span className={clsx('font-medium', onDark ? 'text-on-navy-muted' : 'text-muted')}>{title}:</span> : null}
      {statuses.map((s) => {
        const Icon = STATUS_STYLE[s].icon;
        return (
          <span key={s} role="listitem" className={clsx('inline-flex items-center gap-1', onDark ? 'text-on-navy' : 'text-ink-2')}>
            <Icon className={clsx('size-3.5', STATUS_STYLE[s].iconColor)} aria-hidden />
            {PROVENANCE_LABELS[s]}
          </span>
        );
      })}
    </div>
  );
}

/**
 * "Model estimate" chip for every score / forecast (SPEC data-honesty rule). `method` (e.g.
 * "Balassa RCA, k-means k=6") appears in the tooltip.
 */
export function ModelEstimateTag({ method, className }: { method?: string; className?: string }) {
  return (
    <Tooltip content={method ? `Model estimate: ${method}` : 'Model estimate computed by the Atlas from official data'}>
      <span
        className={clsx(
          'inline-flex h-5 items-center gap-1 rounded-full border border-line-strong px-2 text-[11px] font-medium text-ink-2 hover:border-brand hover:text-brand-ink',
          className,
        )}
      >
        <FlaskConical className="size-3" aria-hidden />
        Model estimate
      </span>
    </Tooltip>
  );
}
