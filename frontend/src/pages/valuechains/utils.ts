/**
 * Helpers for the value-chain pages (/value-chains, /value-chains/:id, /value-chains/:id/mapping).
 *
 * - KPI formatting by unit (SPEC 6.5 `kpis[].unit`: 'usd', 'fraction', 'tonnes', 'units' ...).
 * - Stage-item helpers (distinct item names in chain order, linked counts).
 */
import type { ValueChainDetail, ValueChainItem } from '@/api/types';
import { fmtNum, fmtPct, fmtRate, fmtUSD, NA } from '@/lib/format';

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** "1.5 bn" / "200 mn" / "857,000" for physical quantities. */
function quantity(v: number): string {
  const abs = Math.abs(v);
  const fmt = (x: number, maxDigits: number) => x.toLocaleString('en-US', { maximumFractionDigits: maxDigits });
  if (abs >= 1e9) return `${fmt(v / 1e9, abs >= 1e10 ? 1 : 2)} bn`;
  if (abs >= 1e7) return `${fmt(v / 1e6, abs >= 1e8 ? 0 : 1)} mn`;
  return fmtNum(v);
}

/** Format a KPI value in its unit; null -> "Not available". */
export function fmtKpiValue(value: number | string | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return NA;
  if (typeof value === 'string') return value;
  if (!isNum(value)) return NA;
  const u = (unit ?? '').toLowerCase();
  if (u === 'usd' || u === 'us$' || u === '$') return fmtUSD(value);
  if (u === 'fraction' || u === 'share' || u === 'ratio') return fmtPct(value);
  if (u === 'pct' || u === 'percent' || u === '%') return fmtRate(value, { digits: value < 1 ? 2 : 1 });
  if (u === 'tonnes' || u === 'tons' || u === 't') return `${quantity(value)} tonnes`;
  if (u === 'units' || u === 'unit' || u === 'nos' || u === 'pieces') return `${quantity(value)} units`;
  return u ? `${quantity(value)} ${unit}` : quantity(value);
}

/** Caveat for a stage item whose trade is not a single HS6 subheading (see {@link tradeLevelNote}). */
export interface TradeLevelNote {
  level: string;
  /** Badge text, e.g. "HS4 total". */
  short: string;
  /** Tooltip / footnote text. */
  long: string;
}

/**
 * Explains a non-HS6 `trade_level` on a stage item, or null when the figure is the item's own subheading
 * (or the item has no trade). The C2 endpoint sends `trade_level` 'hs4' / 'hs2' for 4- / 2-digit codes
 * (every subheading under the code summed) and 'hs4_aggregate' when BACI reports the subheading only as its
 * heading total (petroleum oils: 271019 -> 271000), so the figure is the whole heading, not the item.
 */
export function tradeLevelNote(item: Pick<ValueChainItem, 'hs_code' | 'hsn8' | 'hs6' | 'trade_level' | 'linked'>): TradeLevelNote | null {
  const level = item.trade_level;
  if (!item.linked || !level || level === 'hs6') return null;
  const digits = (item.hsn8 ?? item.hs_code ?? '').replace(/\D/g, '');
  const hs4 = digits.slice(0, 4);
  if (level === 'hs4_aggregate') {
    const agg = item.hs6 ?? `${hs4}00`;
    return {
      level,
      short: 'HS4 total',
      long: `Heading aggregate: BACI reports subheading ${digits.slice(0, 6)} only as the heading total ${agg} (all of heading ${hs4}), so exports and imports sum every subheading under the heading - not this item alone.`,
    };
  }
  if (level === 'hs4') {
    return {
      level,
      short: 'HS4 total',
      long: `4-digit code ${hs4}: exports and imports sum every HS6 subheading under the heading, not a single product line.`,
    };
  }
  if (level === 'hs2') {
    return {
      level,
      short: 'Chapter total',
      long: `2-digit code ${digits.slice(0, 2)}: exports and imports sum every subheading of the chapter.`,
    };
  }
  return { level, short: `${level.toUpperCase()} total`, long: `Trade aggregated at the ${level} level, not a single subheading.` };
}

/** Distinct item names of a stage in chain order. */
export function distinctItems(items: ReadonlyArray<ValueChainItem>): Array<{ name: string; lines: ValueChainItem[]; linked: boolean }> {
  const out: Array<{ name: string; lines: ValueChainItem[]; linked: boolean }> = [];
  const byName = new Map<string, { name: string; lines: ValueChainItem[]; linked: boolean }>();
  for (const it of items) {
    const name = (it.item_name ?? '').trim() || it.description || it.hs_code || 'Item';
    const key = name.toLowerCase();
    let entry = byName.get(key);
    if (!entry) {
      entry = { name, lines: [], linked: false };
      byName.set(key, entry);
      out.push(entry);
    }
    entry.lines.push(it);
    entry.linked = entry.linked || it.linked;
  }
  return out;
}

/**
 * Shared leading words of HS labels, so ranked bars can show only what tells the rows apart:
 * ["Rubber; new pneumatic tyres, of a kind used on buses or lorries", "... used on motorcycles"] ->
 * { prefix: "Rubber; new pneumatic tyres, of a kind used on", rest: ["Buses or lorries", "Motorcycles"] }.
 * Returns prefix null (and the labels unchanged) unless at least `minWords` words are shared by 2+
 * labels and every label keeps a non-empty remainder.
 */
export function splitCommonPrefix(labels: ReadonlyArray<string>, minWords = 3): { prefix: string | null; rest: string[] } {
  const unchanged = { prefix: null, rest: [...labels] };
  if (labels.length < 2) return unchanged;
  const words = labels.map((l) => l.trim().split(/\s+/));
  let n = 0;
  while (words.every((w) => w.length > n + 1 && w[n] === words[0][n])) n += 1;
  if (n < minWords) return unchanged;
  const rest = words.map((w) => {
    const tail = w.slice(n).join(' ').replace(/^[\s,;:—–-]+/, '');
    return tail.charAt(0).toUpperCase() + tail.slice(1);
  });
  if (rest.some((r) => !r)) return unchanged;
  return { prefix: words[0].slice(0, n).join(' ').replace(/[\s,;:]+$/, ''), rest };
}

/** "India's rank is 8th in global suppliers" (API text first, else built from the rank). */
export function rankText(rank: ValueChainDetail['india_rank'], ordinal: (n: number) => string): string | null {
  if (rank?.text) return rank.text;
  if (isNum(rank?.rank)) return `India's rank is ${ordinal(rank.rank)} in global suppliers`;
  return null;
}

/** Year of the chain's trade KPIs (falls back to the latest trade year, 2024). */
export function chainYear(d: ValueChainDetail): number {
  const k = d.kpis.find((x) => x.key === 'india_exports') ?? d.kpis.find((x) => isNum(x.year));
  return k?.year ?? k?.provenance?.year ?? 2024;
}
