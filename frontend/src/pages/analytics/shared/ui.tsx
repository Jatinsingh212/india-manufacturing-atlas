/**
 * Small presentational helpers shared by the D3 pages (Opportunity Lab, Policy Workbench,
 * Supply-chain Risk, Network). They only compose foundation components (`@/components`) so the
 * look stays identical to the rest of the Atlas.
 *
 * - <ProductCell hs6 hsn8 description />   HS6 code + product label; links to the sample 8-digit line
 * - <ItemMinistry id short />              ministry chip for HS6-level analytics items
 * - <SourceNote provenances />             provenance badges for a card footer (the status legend)
 * - <MethodNote method>...</MethodNote>    "how to read this" box with the Model-estimate chip
 * - useTradeProvenance() / TARIFF_PROVENANCE / MODEL_PROVENANCE  provenance objects for footers
 * - <ScoresPendingNote response />          notice when the API reports `scored: false` (scores not built)
 * - usd / pct / ratio                       dense-table formatters ("—" for null)
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { FlaskConical, Info } from 'lucide-react';
import { useHealth, useMinistryLookup } from '@/api/hooks';
import type { Provenance } from '@/api/types';
import { CodeLink, MinistryPill, ModelEstimateTag, ProvenanceBadge, tradeSourceLabel } from '@/components';
import { fmtPct, fmtRatio, fmtUSD, NA_SHORT, truncate } from '@/lib/format';
import { routeForCode, routes } from '@/lib/routes';

// ============================================================================ formatters

/** US$ for dense tables ("—" when null). */
export const usd = (v: number | null | undefined) => fmtUSD(v, { na: NA_SHORT });
/** Fraction as percent for dense tables. */
export const pct = (v: number | null | undefined, signed = false) => fmtPct(v, { na: NA_SHORT, signed });
/** RCA / HHI style ratio for dense tables. */
export const ratio = (v: number | null | undefined) => fmtRatio(v, { na: NA_SHORT });

/** Median of the finite values (null when none). */
export function median(values: ReadonlyArray<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Quantile (0..1) of the finite values (null when none). */
export function quantile(values: ReadonlyArray<number | null | undefined>, q: number): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** Sum of the finite values (null when there are none, so "Not available" is never shown as 0). */
export function sumOrNull(values: ReadonlyArray<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

// ============================================================================ provenance objects

/** WITS / UNCTAD TRAINS MFN applied tariffs (raw/wits_india_mfn_2022.csv). */
export const TARIFF_PROVENANCE: Provenance = { source: 'wits', status: 'verified', label: 'WITS / UNCTAD TRAINS MFN applied 2022', year: 2022 };

/** Scores, clusters and forecasts computed by the platform (SPEC section 4) - a model estimate, not verified. */
export const MODEL_PROVENANCE: Provenance = { source: 'model', status: 'not_verified', label: 'Model estimate - Atlas analytical model (derived from official DGFT/DGCIS & UN trade data)', year: null };

/** Trade provenance (TRADESTAT India flows, BACI world) for the latest year reported by /api/health (2024 by SPEC). */
export function useTradeProvenance(): Provenance {
  const { data } = useHealth();
  const year = data?.latest_year ?? 2024;
  return { source: 'tradestat', status: 'verified', label: tradeSourceLabel(year), year };
}

// ============================================================================ cells & chips

export interface ProductCellProps {
  hs6: string;
  /** A representative 8-digit line of the hs6 (links to its product page). */
  hsn8?: string | null;
  description?: string | null;
  /** Max characters of the description (default 70). */
  max?: number;
  className?: string;
}

/** HS6 code over the product label; the code links to the sample 8-digit product page. */
export function ProductCell({ hs6, hsn8, description, max = 70, className }: ProductCellProps) {
  const to = hsn8 ? routes.product(hsn8) : (routeForCode(hs6) ?? undefined);
  return (
    <div className={clsx('min-w-0', className)}>
      <CodeLink code={hs6} to={to} />
      {description ? (
        <div className="mt-0.5 text-[12.5px] leading-snug text-ink-2" title={description}>
          {truncate(description, max)}
        </div>
      ) : null}
    </div>
  );
}

/** HS6 code in monospace linking to the sample 8-digit product page (or the Explorer). */
export function Hs6Code({ hs6, hsn8 }: { hs6: string; hsn8?: string | null }) {
  const to = hsn8 ? routes.product(hsn8) : (routeForCode(hs6) ?? undefined);
  return <CodeLink code={hs6} to={to} />;
}

/** Product label clamped to two lines (full text in the title attribute). */
export function ProductText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return <span className="text-muted">{NA_SHORT}</span>;
  return (
    <span className={clsx('line-clamp-2 min-w-48 text-[12.5px] leading-snug text-ink', className)} title={text}>
      {text}
    </span>
  );
}

/** Ministry chip for analytics items, which carry only `ministry_id` / `ministry_short`. */
export function ItemMinistry({ id, short, size = 'xs' }: { id: string | null | undefined; short?: string | null; size?: 'xs' | 'sm' }) {
  const lookup = useMinistryLookup();
  if (!id) return <span className="text-xs text-muted">{NA_SHORT}</span>;
  const m = lookup.get(id);
  return <MinistryPill size={size} ministry={{ id, short_name: short ?? m?.short_name ?? id, name: m?.name ?? null, color: m?.color ?? null }} />;
}

/** Provenance badges with their source labels, for card footers. */
export function SourceNote({ provenances, children, className }: { provenances: ReadonlyArray<Provenance>; children?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}>
      <span className="text-muted">Sources:</span>
      {provenances.map((p) => (
        <ProvenanceBadge key={`${p.source}-${p.label}`} provenance={p} showSource size="xs" />
      ))}
      {children}
    </div>
  );
}

/**
 * Explanatory box for a score or model: what it means, with the methodology link. `estimate={false}`
 * (for derived statistics such as RCA, which are not model estimates) shows a plain methodology link.
 */
export function MethodNote({
  method,
  title = 'How to read this',
  estimate = true,
  children,
  className,
}: {
  method?: string;
  title?: string;
  estimate?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-ink-2', className)}>
      <Info className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{title}</span>
          {estimate ? <ModelEstimateTag method={method} /> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Thin label/value row used inside summary cards. */
export function StatLine({ label, value, aside }: { label: ReactNode; value: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[13px]">
      <span className="text-ink-2">{label}</span>
      <span className="flex items-center gap-2 font-semibold text-ink atlas-num">
        {value}
        {aside}
      </span>
    </div>
  );
}

/**
 * The analytics API adds `scored: false` to a response when the model-scoring step of the data
 * pipeline has not run for the current database build (scores, archetypes and clusters are then
 * null). SPEC does not list the flag, so it is read defensively.
 */
export function isUnscored(response: unknown): boolean {
  return Boolean(response && typeof response === 'object' && (response as { scored?: unknown }).scored === false);
}

/** Notice shown above score-based views while model scores are not available. */
export function ScoresPendingNote({ response, what = 'Model scores', className }: { response: unknown; what?: string; className?: string }) {
  if (!isUnscored(response)) return null;
  return (
    <div className={clsx('flex gap-3 rounded-lg border border-na/40 bg-na-soft px-3.5 py-3 text-[13px] leading-relaxed text-ink', className)} role="status">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-na-ink" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{what} are not available in the current data build.</span> Trade figures below are verified source data;
        score, archetype and cluster fields read <i>Not available</i> until the scoring step of the data pipeline has run.
      </div>
    </div>
  );
}
