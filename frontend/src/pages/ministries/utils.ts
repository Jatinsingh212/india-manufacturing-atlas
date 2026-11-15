/**
 * Pure helpers shared by the ministry and sector dashboards (pages/ministries/** and pages/sectors/**).
 *
 * - Provenance fallbacks: the dashboards show a provenance badge next to every number. The API sends
 *   provenance objects on /api/meta/overview (`provenance.trade`, `provenance.mapping`); when that call
 *   is unavailable the badges fall back to the sources SPEC section 1 fixes for these numbers
 *   (trade = DGCIS TRADESTAT for India, CEPII BACI for the world, verified; ministry mapping = official DPIIT
 *   Guidebook, verified).
 * - Mapping labels for `mapping_source` / `mapping_status`.
 * - Small numeric helpers (YoY from a trend, safe ratios, top-N folding).
 */
import type { MappingSource, MappingStatus, Provenance, ProvenanceStatus, TradeSeriesPoint } from '@/api/types';
import { tradeSourceLabel } from '@/components/Provenance';
import { fmtPct, NA_SHORT } from '@/lib/format';

/** Latest trade year used by the Atlas (SPEC section 1: meta.latest_year = 2024). */
export const DEFAULT_LATEST_YEAR = 2024;

/** Trade values: DGCIS TRADESTAT India flows with CEPII BACI world trade (both verified sources). */
export function tradeProvenance(year: number | null = DEFAULT_LATEST_YEAR, override?: Provenance | null): Provenance {
  if (override) return override;
  return { source: 'tradestat', status: 'verified', label: year ? tradeSourceLabel(year) : 'DGFT/DGCIS TRADESTAT (India); CEPII BACI (world)', year };
}

/**
 * Ministry ownership counts: the official DPIIT Guidebook on HSN Code Mapping (16.12.2025 revision)
 * is the source of the verified mapping; lines outside it remain residual.
 */
export function mappingProvenance(override?: Provenance | null): Provenance {
  if (override) return override;
  return {
    source: 'dpiit_guidebook',
    status: 'verified',
    label: 'DPIIT Guidebook on HSN Code Mapping, 16 December 2025 revision',
    year: null,
  };
}

const SOURCE_SHORT: Record<MappingSource, string> = {
  dpiit_guidebook: 'DPIIT Guidebook',
  rule: 'Provisional rule',
  official_upload: 'Data Hub upload',
  manual: 'Manual review',
  unmapped: 'Not in Guidebook',
};

/** Short label for a mapping source. */
export function mappingSourceLabel(source: MappingSource | string | null | undefined): string {
  if (!source) return 'Unknown';
  return SOURCE_SHORT[source as MappingSource] ?? source;
}

/** Provenance status of one product's ministry mapping (SPEC section 1 mapping table). */
export function mappingStatusOf(source: MappingSource | string | null | undefined, status?: MappingStatus | null): ProvenanceStatus {
  if (status === 'residual') return 'not_verified';
  if (source === 'dpiit_guidebook' || source === 'official_upload' || source === 'manual') return 'verified';
  if (source === 'rule' || source === 'unmapped') return 'not_verified';
  return 'not_available';
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A share as "14.0%", or "<0.1%" for a positive share that would round to 0.0% (a non-zero value is
 * never printed as zero); null -> "—".
 */
export function fmtShare(share: number | null | undefined): string {
  if (!isNum(share)) return NA_SHORT;
  if (share > 0 && share < 0.0005) return '<0.1%';
  return fmtPct(share, { digits: 1 });
}

/** a / b, or null when either is missing or b is 0. */
export function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  if (!isNum(a) || !isNum(b) || b === 0) return null;
  return a / b;
}

/** a - b, or null when either is missing. */
export function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  if (!isNum(a) || !isNum(b)) return null;
  return a - b;
}

/** Last two points of a series with a value for `key`, as a YoY fraction (null when not computable). */
export function yoyFromTrend(trend: ReadonlyArray<TradeSeriesPoint> | null | undefined, key: 'exports' | 'imports'): { yoy: number | null; year: number | null; prevYear: number | null } {
  const pts = (trend ?? []).filter((p) => isNum(p[key])).sort((a, b) => a.year - b.year);
  if (pts.length < 2) return { yoy: null, year: pts.at(-1)?.year ?? null, prevYear: null };
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const prevVal = prev[key] as number;
  return { yoy: prevVal > 0 ? (last[key] as number) / prevVal - 1 : null, year: last.year, prevYear: prev.year };
}

/** First and last years present in a trend (for "2018–2024" labels). */
export function trendSpan(trend: ReadonlyArray<TradeSeriesPoint> | null | undefined): { from: number | null; to: number | null } {
  const years = (trend ?? []).map((p) => p.year).sort((a, b) => a - b);
  return { from: years[0] ?? null, to: years.at(-1) ?? null };
}

/** "2018–2024" or "" */
export function spanLabel(trend: ReadonlyArray<TradeSeriesPoint> | null | undefined): string {
  const { from, to } = trendSpan(trend);
  if (!from || !to) return '';
  return from === to ? String(from) : `${from}–${to}`;
}

/** Country label from an OEC country id ('aschn' -> 'CHN') when no name lookup is available. */
export function countryFallback(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length > 3 ? id.slice(-3).toUpperCase() : id.toUpperCase();
}

/** Case-insensitive "all words appear" text match used by the client-side filters. */
export function matchesQuery(q: string, ...fields: Array<string | null | undefined>): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Sum of a numeric field, ignoring nulls; null when no row has a value. */
export function sumOf<T>(rows: ReadonlyArray<T>, get: (r: T) => number | null | undefined): number | null {
  let total = 0;
  let any = false;
  for (const r of rows) {
    const v = get(r);
    if (isNum(v)) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

/** Max of a numeric field (0 when empty). */
export function maxOf<T>(rows: ReadonlyArray<T>, get: (r: T) => number | null | undefined): number {
  let m = 0;
  for (const r of rows) {
    const v = get(r);
    if (isNum(v) && v > m) m = v;
  }
  return m;
}
