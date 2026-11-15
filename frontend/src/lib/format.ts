/**
 * Number / code / date formatting for the Atlas UI.
 *
 * Every formatter accepts `null | undefined` and returns the "Not available" label (SPEC: absent data is
 * null and rendered as "Not available"). Dense tables can pass `{ na: NA_SHORT }` for a dash instead.
 *
 * Units recap (SPEC section 1): money = US$ (not millions); shares / CAGRs = fractions; tariff rates =
 * percentages (12.5 means 12.5 %).
 */

/** Label for missing data (SPEC data-honesty rule). */
export const NA = 'Not available';
/** Compact missing-data marker for dense tables. */
export const NA_SHORT = '—';

export interface FmtOptions {
  /** Text for null / undefined / NaN (default {@link NA}). */
  na?: string;
}

const MINUS = '−';

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Round to `sig` significant digits but never show more than `maxDecimals` decimals. */
function sigFixed(v: number, sig = 3, maxDecimals = 2): string {
  if (v === 0) return '0';
  const digits = Math.floor(Math.log10(Math.abs(v))) + 1;
  const decimals = Math.max(0, Math.min(maxDecimals, sig - digits));
  return v.toFixed(decimals).replace(/\.0+$|(\.\d*?[1-9])0+$/, '$1');
}

type UsdUnit = 'tn' | 'bn' | 'mn' | 'k' | '';

const UNITS: ReadonlyArray<readonly [number, UsdUnit]> = [
  [1e12, 'tn'],
  [1e9, 'bn'],
  [1e6, 'mn'],
  [1e3, 'k'],
];

const UNIT_DIV: Record<UsdUnit, number> = { tn: 1e12, bn: 1e9, mn: 1e6, k: 1e3, '': 1 };

export interface FmtUSDOptions extends FmtOptions {
  /** Significant digits (default 3: $3.11 bn, $812 mn, $45.2 k). */
  sig?: number;
  /** Force a unit instead of auto-scaling. */
  unit?: UsdUnit;
  /** Prefix positive values with '+' (for deltas). */
  signed?: boolean;
}

/**
 * US$ with automatic tn / bn / mn / k scaling: `fmtUSD(3.106e9)` -> "$3.11 bn", `fmtUSD(8.12e8)` -> "$812 mn",
 * `fmtUSD(950)` -> "$950". Negative values use a true minus sign.
 */
export function fmtUSD(v: number | null | undefined, opts: FmtUSDOptions = {}): string {
  if (!isNum(v)) return opts.na ?? NA;
  const sig = opts.sig ?? 3;
  const sign = v < 0 ? MINUS : opts.signed && v > 0 ? '+' : '';
  const abs = Math.abs(v);
  let unit: UsdUnit = opts.unit ?? (UNITS.find(([d]) => abs >= d)?.[1] ?? '');
  let body = unit ? sigFixed(abs / UNIT_DIV[unit], sig, 2) : abs < 10 && abs > 0 ? sigFixed(abs, sig, 2) : Math.round(abs).toLocaleString('en-US');
  // Rounding can carry into the next unit ($999.6 k -> $1 mn).
  if (opts.unit === undefined && Number(body.replace(/,/g, '')) >= 1000) {
    const idx = UNITS.findIndex(([, u]) => u === unit);
    const up = idx > 0 ? UNITS[idx - 1] : unit === '' ? UNITS[UNITS.length - 1] : undefined;
    if (up) {
      unit = up[1];
      body = sigFixed(abs / up[0], sig, 2);
    }
  }
  return `${sign}$${body}${unit ? ` ${unit}` : ''}`;
}

export interface FmtUSDMnOptions extends FmtOptions {
  /** Append the unit: "$1,723 Mn." (default false: "1,723" for a "($ Mn.)" column header). */
  withUnit?: boolean;
  /** Decimals for values < 10 mn (default 1). */
  smallDecimals?: number;
}

/**
 * Compact "$ Mn." figures: `fmtUSDMn(1.723e9)` -> "1,723"; with `withUnit` -> "$1,723 Mn.".
 * Values under 10 mn keep one decimal ("8.1"), under 0.05 mn show "<0.1".
 */
export function fmtUSDMn(v: number | null | undefined, opts: FmtUSDMnOptions = {}): string {
  if (!isNum(v)) return opts.na ?? NA;
  const mn = v / 1e6;
  const abs = Math.abs(mn);
  let body: string;
  if (abs === 0) body = '0';
  else if (abs < 0.05) body = '<0.1';
  else if (abs < 10) body = abs.toFixed(opts.smallDecimals ?? 1).replace(/\.0$/, '');
  else body = Math.round(abs).toLocaleString('en-US');
  const sign = mn < 0 ? MINUS : '';
  return opts.withUnit ? `${sign}$${body} Mn.` : `${sign}${body}`;
}

export interface FmtPctOptions extends FmtOptions {
  /** Decimals (default: 1, or 2 when |value| < 1 %). */
  digits?: number;
  /** Prefix positive values with '+'. */
  signed?: boolean;
}

/** Fraction -> percent: `fmtPct(0.0307)` -> "3.1%", `fmtPct(0.0005)` -> "0.05%", `fmtPct(0.25)` -> "25.0%", `fmtPct(0.05, {signed:true})` -> "+5.0%". */
export function fmtPct(v: number | null | undefined, opts: FmtPctOptions = {}): string {
  if (!isNum(v)) return opts.na ?? NA;
  const pct = v * 100;
  const digits = opts.digits ?? (Math.abs(pct) < 1 && pct !== 0 ? 2 : 1);
  const sign = pct < 0 ? MINUS : opts.signed && pct > 0 ? '+' : '';
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

/** A value that is already a percentage (tariffs): `fmtRate(12.5)` -> "12.5%", `fmtRate(20)` -> "20%". */
export function fmtRate(v: number | null | undefined, opts: FmtOptions & { digits?: number } = {}): string {
  if (!isNum(v)) return opts.na ?? NA;
  const d = opts.digits ?? (Number.isInteger(v) ? 0 : 1);
  return `${v.toFixed(d)}%`;
}

export interface FmtNumOptions extends FmtOptions {
  /** Fixed decimals (default: 0 for |v| >= 100, else up to 2 significant decimals). */
  digits?: number;
  /** Compact notation: 12.9K, 1.2M. */
  compact?: boolean;
  /** Append a unit with a space ("857,000 tonnes"). */
  unit?: string;
}

/** Plain number with thousands separators: `fmtNum(13110)` -> "13,110", `fmtNum(857000, {unit:'tonnes'})`. */
export function fmtNum(v: number | null | undefined, opts: FmtNumOptions = {}): string {
  if (!isNum(v)) return opts.na ?? NA;
  let out: string;
  if (opts.compact) {
    out = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: opts.digits ?? 1 }).format(v);
  } else {
    const digits = opts.digits ?? (Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 2);
    out = v.toLocaleString('en-US', { minimumFractionDigits: opts.digits ?? 0, maximumFractionDigits: digits });
  }
  out = out.replace('-', MINUS);
  return opts.unit ? `${out} ${opts.unit}` : out;
}

/** Compact count: 12.9K, 1.2M. */
export function fmtCompact(v: number | null | undefined, opts: FmtOptions = {}): string {
  return fmtNum(v, { ...opts, compact: true });
}

/** RCA / ratios to two decimals: `fmtRatio(1.2)` -> "1.20". */
export function fmtRatio(v: number | null | undefined, opts: FmtOptions & { digits?: number } = {}): string {
  if (!isNum(v)) return opts.na ?? NA;
  return v.toFixed(opts.digits ?? 2).replace('-', MINUS);
}

/** 0-100 model score, rounded: "73". */
export function fmtScore(v: number | null | undefined, opts: FmtOptions = {}): string {
  if (!isNum(v)) return opts.na ?? NA;
  return String(Math.round(v));
}

/**
 * HS code display. `style: 'dotted'` (default) -> "4011.10.10" / "4011.10" / "4011"; `'plain'` -> as is.
 * Non-numeric codes (section roman numerals) are returned unchanged.
 */
export function fmtCode(code: string | null | undefined, style: 'dotted' | 'plain' = 'dotted', opts: FmtOptions = {}): string {
  if (code === null || code === undefined || code === '') return opts.na ?? NA;
  const c = String(code).replace(/[\s.]/g, '');
  if (style === 'plain' || !/^\d+$/.test(c)) return String(code);
  if (c.length === 6) return `${c.slice(0, 4)}.${c.slice(4)}`;
  if (c.length === 8) return `${c.slice(0, 4)}.${c.slice(4, 6)}.${c.slice(6)}`;
  return c;
}

/** HS level name for a code length (or section). */
export function hsLevelName(code: string | number): string {
  const n = typeof code === 'number' ? code : String(code).replace(/[\s.]/g, '').length;
  switch (n) {
    case 0:
      return 'Section';
    case 2:
      return 'Chapter';
    case 4:
      return 'Heading';
    case 6:
      return 'Subheading';
    case 8:
      return 'Tariff line';
    default:
      return 'Code';
  }
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const DATETIME_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function toDate(v: string | number | Date): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v);
  // Backend timestamps are UTC without a zone suffix sometimes ("2026-10-19 08:30:00").
  const s = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "19 Oct 2026" or, with `withTime`, "19 Oct 2026, 14:05". */
export function fmtDate(v: string | number | Date | null | undefined, opts: FmtOptions & { withTime?: boolean } = {}): string {
  if (v === null || v === undefined || v === '') return opts.na ?? NA;
  const d = toDate(v);
  if (!d) return String(v);
  return (opts.withTime ? DATETIME_FMT : DATE_FMT).format(d);
}

/** Relative time: "just now", "5 min ago", "3 h ago", "2 days ago", else the date. */
export function fmtAgo(v: string | number | Date | null | undefined, opts: FmtOptions = {}): string {
  if (v === null || v === undefined || v === '') return opts.na ?? NA;
  const d = toDate(v);
  if (!d) return String(v);
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 0) return fmtDate(d);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  if (sec < 86400 * 30) {
    const days = Math.floor(sec / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return fmtDate(d);
}

/**
 * CAGR label: `cagrLabel(0.123, 2018, 2024)` -> "+12.3% CAGR 2018–24"; without years "+12.3% CAGR".
 */
export function cagrLabel(
  cagr: number | null | undefined,
  fromYear?: number | null,
  toYear?: number | null,
  opts: FmtOptions = {},
): string {
  if (!isNum(cagr)) return opts.na ?? NA;
  const pct = fmtPct(cagr, { signed: true, digits: 1 });
  if (fromYear && toYear) return `${pct} CAGR ${fromYear}–${String(toYear).slice(-2)}`;
  return `${pct} CAGR`;
}

/** Year-on-year label: "+8.4% YoY". */
export function yoyLabel(yoy: number | null | undefined, opts: FmtOptions = {}): string {
  if (!isNum(yoy)) return opts.na ?? NA;
  return `${fmtPct(yoy, { signed: true, digits: 1 })} YoY`;
}

/** Ordinal: 1 -> "1st", 8 -> "8th" (India's supplier rank). */
export function fmtOrdinal(n: number | null | undefined, opts: FmtOptions = {}): string {
  if (!isNum(n)) return opts.na ?? NA;
  const r = Math.round(n);
  const m100 = r % 100;
  const m10 = r % 10;
  const suffix = m100 >= 11 && m100 <= 13 ? 'th' : m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th';
  return `${r}${suffix}`;
}

/** Truncate long product labels for chart axes: "T-shirts, singlets and…". */
export function truncate(text: string | null | undefined, max = 48): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "1 code" / "12 codes". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${fmtNum(n)} ${n === 1 ? singular : pluralForm}`;
}

/** Humanise snake_case ids: "not_verified" -> "Not verified", "import_surge" -> "Import surge". */
export function humanize(id: string | null | undefined): string {
  if (!id) return '';
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
