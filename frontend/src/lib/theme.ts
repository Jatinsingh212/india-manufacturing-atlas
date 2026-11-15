/**
 * Chart colour system and ECharts theming.
 *
 * Colour jobs (dataviz method):
 * - Categorical (identity): {@link CATEGORICAL} - 8 hues in a FIXED order, assigned in sequence and never
 *   cycled. Validated with the dataviz `validate_palette.js` against the Atlas card surfaces
 *   (light #ffffff, dark #111c2e): adjacent CVD dE >= 8.4, normal-vision dE >= 19.3. Scatter / bubble /
 *   map forms (all pairs visible) should use at most the first 3 slots; fold the rest into "Other".
 *   Light slots 3-5 sit below 3:1 on white, so charts using them must carry direct labels or a table view.
 * - Entity colours: ministries and sectors keep the colour from data/curated/*.json everywhere
 *   ({@link ministryColor}, {@link sectorColor}) so a ministry is always the same hue.
 * - Sequential (magnitude / 0-100 scores): one blue ramp, light -> dark ({@link SEQUENTIAL_BLUE}).
 * - Diverging (trade balance, deltas): blue <-> red with a neutral grey midpoint ({@link DIVERGING}).
 * - Status: provenance (Verified / Not verified / Not available) and severities - reserved, never series.
 *
 * Text never wears a series colour; labels use the ink tokens.
 */
import type { EChartsOption } from 'echarts';
import type { Archetype, ProvenanceStatus, Severity } from '@/api/types';

export type ThemeMode = 'light' | 'dark';

// ============================================================================ palettes

/** Validated categorical palette (slot order is the CVD-safety mechanism - do not reorder). */
export const CATEGORICAL: Record<ThemeMode, readonly string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

/** Colour for categorical slot `index` (0-based). Past slot 8 returns the "Other" grey - never a new hue. */
export function categorical(index: number, mode: ThemeMode = 'light'): string {
  const list = CATEGORICAL[mode];
  return index >= 0 && index < list.length ? list[index] : OTHER_GREY[mode];
}

/** Grey used for the folded "Other" series and de-emphasised marks. */
export const OTHER_GREY: Record<ThemeMode, string> = { light: '#a7b0bf', dark: '#55657f' };

/**
 * Stable colour assignment by entity key: the colour follows the key's position in `allKeys`
 * (the full, unfiltered list), so filtering never repaints survivors.
 */
export function colorForKey(key: string, allKeys: readonly string[], mode: ThemeMode = 'light'): string {
  return categorical(allKeys.indexOf(key), mode);
}

/** Single-hue sequential blue ramp (steps 100 -> 700). */
export const SEQUENTIAL_BLUE = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
] as const;

/** Diverging blue <-> grey <-> red (negative = red arm, positive = blue arm). */
export const DIVERGING: Record<ThemeMode, readonly string[]> = {
  light: ['#b3261e', '#e34948', '#f2a7a6', '#f0efec', '#9ec5f4', '#3987e5', '#1c5cab'],
  dark: ['#e66767', '#c94b4b', '#7a3a3a', '#383835', '#2b4f80', '#3987e5', '#86b6ef'],
};

/** Map a 0-100 value onto the sequential ramp (null -> grey). Use `minStep` to keep marks visible. */
export function sequentialColor(value: number | null | undefined, minStep = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return OTHER_GREY.light;
  const t = Math.max(0, Math.min(100, value)) / 100;
  const steps = SEQUENTIAL_BLUE.length - 1 - minStep;
  return SEQUENTIAL_BLUE[minStep + Math.round(t * steps)];
}

/** Risk meter colours (0-100, higher = worse): good -> warning -> serious -> critical. */
export const RISK_SCALE = ['#0ca30c', '#fab219', '#ec835a', '#d03b3b'] as const;

/** Colour of a 0-100 risk / vulnerability value on the status scale. */
export function riskColor(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return OTHER_GREY.light;
  if (value < 25) return RISK_SCALE[0];
  if (value < 50) return RISK_SCALE[1];
  if (value < 75) return RISK_SCALE[2];
  return RISK_SCALE[3];
}

/** Provenance status colours (Verified green, Not verified red, Not available orange). */
export const PROVENANCE_COLORS: Record<ProvenanceStatus, string> = {
  verified: '#0ca30c',
  not_verified: '#d03b3b',
  not_available: '#ec835a',
};

export const PROVENANCE_LABELS: Record<ProvenanceStatus, string> = {
  verified: 'Verified',
  not_verified: 'Not verified',
  not_available: 'Not available',
};

export const SEVERITY_COLORS: Record<Severity, string> = {
  high: '#d03b3b',
  medium: '#ec835a',
  low: '#fab219',
};

/** Archetype colours: categorical slots in a fixed order (Champion first). */
export const ARCHETYPE_ORDER: readonly Archetype[] = ['Champion', 'Established', 'Emerging', 'Dependent', 'Marginal'];
export function archetypeColor(a: Archetype | string | null | undefined, mode: ThemeMode = 'light'): string {
  if (!a) return OTHER_GREY[mode];
  const i = ARCHETYPE_ORDER.indexOf(a as Archetype);
  if (a === 'Marginal') return OTHER_GREY[mode];
  return categorical(i, mode);
}

/** India highlight colour in country charts (the brand magenta). */
export const INDIA_COLOR: Record<ThemeMode, string> = { light: '#e6007e', dark: '#ff4da6' };

// ============================================================================ entity colours (data/curated)

/** Ministry colours from data/curated/ministries.json (fallback when the API omits `color`). */
export const MINISTRY_COLORS: Readonly<Record<string, string>> = {
  dpiit: '#1F4E9E',
  mot: '#D9480F',
  dcpc: '#7048E8',
  mofpi: '#2F9E44',
  mhi: '#C2255C',
  dop: '#0C8599',
  dofert: '#8F5E15',
  doc: '#E67700',
  dafw: '#5C940D',
  dahd: '#A61E4D',
  dofish: '#1098AD',
  mos: '#495057',
  mom: '#868E96',
  mocoal: '#343A40',
  mopng: '#5F3DC4',
  meity: '#1C7ED6',
  mnre: '#F59F00',
  mop: '#FAB005',
  dot: '#3B5BDB',
  ddp: '#2B8A3E',
  moca: '#4DABF7',
  mopsw: '#0B7285',
  mor: '#862E9C',
  moefcc: '#37B24D',
  dfpd: '#74B816',
  msme: '#F76707',
  mocul: '#E64980',
  mib: '#BE4BDB',
  dae: '#9C36B5',
  ayush: '#66A80F',
  mohfw: '#F03E3E',
  residual: '#ADB5BD',
};

/** Sector colours from data/curated/sectors.json. */
export const SECTOR_COLORS: Readonly<Record<string, string>> = {
  agriculture: '#5C940D',
  food_processing: '#2F9E44',
  minerals: '#868E96',
  energy: '#5F3DC4',
  chemicals: '#7048E8',
  pharma: '#0C8599',
  fertilizers: '#8F5E15',
  plastics: '#9775FA',
  rubber_tyre: '#212529',
  leather: '#A0522D',
  wood_paper: '#8D6E63',
  textiles: '#D9480F',
  ceramics_glass: '#ADB5BD',
  gems_jewellery: '#E64980',
  iron_steel: '#495057',
  nonferrous: '#74C0FC',
  engineering: '#1F4E9E',
  electronics: '#1C7ED6',
  automotive: '#C2255C',
  transport_equipment: '#4DABF7',
  instruments: '#0B7285',
  defence: '#2B8A3E',
  consumer_goods: '#F59F00',
  art_antiques: '#BE4BDB',
  special: '#CED4DA',
};

/** Colour for a ministry id (API colour wins when provided). */
export function ministryColor(id: string | null | undefined, apiColor?: string | null): string {
  if (apiColor) return apiColor;
  return (id && MINISTRY_COLORS[id]) || '#7b8798';
}

/** Colour for a sector id (API colour wins when provided). */
export function sectorColor(id: string | null | undefined, apiColor?: string | null): string {
  if (apiColor) return apiColor;
  return (id && SECTOR_COLORS[id]) || '#7b8798';
}

// ============================================================================ colour utilities

/** `#rrggbb` + alpha (0..1) -> `rgba(...)`. */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Relative luminance (WCAG) of a hex colour. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = Number.parseInt(full, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Ink (dark or white) that stays legible on top of `bg`. */
export function readableInk(bg: string): string {
  return luminance(bg) > 0.42 ? '#0b1f3a' : '#ffffff';
}

/** Read a CSS custom property from :root (e.g. '--atlas-ink'); returns `fallback` outside the browser. */
export function cssVar(name: string, fallback = ''): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// ============================================================================ ECharts

/** Chart chrome tokens per mode (kept in sync with src/index.css). */
export const CHART_TOKENS: Record<
  ThemeMode,
  { surface: string; ink: string; ink2: string; muted: string; grid: string; axis: string; tooltipBg: string; tooltipBorder: string }
> = {
  light: {
    surface: '#ffffff',
    ink: '#0a1c35',
    ink2: '#40516a',
    muted: '#66788f',
    grid: '#e9edf4',
    axis: '#c2ccda',
    tooltipBg: '#ffffff',
    tooltipBorder: '#e1e7f0',
  },
  dark: {
    surface: '#0f1b2d',
    ink: '#e9eef6',
    ink2: '#b6c2d4',
    muted: '#8d9bb1',
    grid: '#22324c',
    axis: '#304666',
    tooltipBg: '#142238',
    tooltipBorder: '#304666',
  },
};

const FONT_FAMILY =
  "'Manrope Variable', Manrope, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

/**
 * ECharts theme object for `echarts.registerTheme('atlas-light' | 'atlas-dark', ...)`. The <EChart>
 * component registers both and switches automatically with the app theme.
 * Mark specs: bars <= 24 px with 4 px rounded data-ends, 2 px lines, >= 8 px symbols, hairline solid grid.
 */
export function echartsTheme(mode: ThemeMode): Record<string, unknown> {
  const t = CHART_TOKENS[mode];
  const axisCommon = {
    axisLine: { show: true, lineStyle: { color: t.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, fontFamily: FONT_FAMILY },
    splitLine: { show: true, lineStyle: { color: t.grid, width: 1, type: 'solid' } },
    splitArea: { show: false },
    nameTextStyle: { color: t.muted, fontSize: 11 },
  };
  return {
    color: [...CATEGORICAL[mode]],
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT_FAMILY, color: t.ink2 },
    title: {
      textStyle: { color: t.ink, fontSize: 14, fontWeight: 600 },
      subtextStyle: { color: t.muted, fontSize: 12 },
    },
    legend: {
      textStyle: { color: t.ink2, fontSize: 12 },
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 14,
      icon: 'roundRect',
      pageIconColor: t.ink2,
      pageTextStyle: { color: t.muted },
    },
    tooltip: {
      backgroundColor: t.tooltipBg,
      borderColor: t.tooltipBorder,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: t.ink, fontSize: 12 },
      extraCssText: 'box-shadow: 0 16px 38px -18px rgba(10,28,53,0.35); border-radius: 10px;',
      axisPointer: {
        lineStyle: { color: t.axis, width: 1 },
        crossStyle: { color: t.axis },
        shadowStyle: { color: withAlpha(mode === 'light' ? '#0b1f3a' : '#ffffff', 0.04) },
      },
    },
    categoryAxis: { ...axisCommon, splitLine: { show: false } },
    valueAxis: { ...axisCommon, axisLine: { show: false } },
    logAxis: { ...axisCommon, axisLine: { show: false } },
    timeAxis: { ...axisCommon, splitLine: { show: false } },
    line: {
      lineStyle: { width: 2 },
      symbol: 'circle',
      symbolSize: 8,
      smooth: false,
      itemStyle: { borderWidth: 2, borderColor: t.surface },
      label: { color: t.ink2 },
    },
    bar: {
      barMaxWidth: 24,
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      label: { color: t.ink2 },
    },
    scatter: {
      symbolSize: 10,
      itemStyle: { borderWidth: 2, borderColor: t.surface, opacity: 0.9 },
      label: { color: t.ink2 },
    },
    pie: {
      itemStyle: { borderColor: t.surface, borderWidth: 2 },
      label: { color: t.ink2 },
    },
    graph: {
      lineStyle: { color: t.axis },
      label: { color: t.ink },
    },
    visualMap: {
      textStyle: { color: t.muted },
    },
    dataZoom: {
      borderColor: t.grid,
      textStyle: { color: t.muted },
      fillerColor: withAlpha('#2a78d6', 0.12),
      handleStyle: { color: t.surface, borderColor: t.axis },
    },
    markLine: {
      lineStyle: { color: t.axis },
      label: { color: t.muted },
    },
  };
}

/** Default grid with room for axis labels (the container height must include the axis band). */
export const BASE_GRID = { left: 8, right: 16, top: 24, bottom: 8, containLabel: true } as const;

/**
 * Shallow helper to build a horizontal bar option (category on y) following the mark specs.
 * Pages can spread and override anything.
 */
export function horizontalBarOption(params: {
  categories: string[];
  values: Array<number | null>;
  colors?: Array<string | undefined>;
  valueFormatter?: (v: number) => string;
  seriesName?: string;
  showLabels?: boolean;
}): EChartsOption {
  const { categories, values, colors, valueFormatter = (v) => String(v), seriesName = 'Value', showLabels = true } = params;
  return {
    grid: { ...BASE_GRID, right: showLabels ? 56 : 16 },
    tooltip: {
      trigger: 'item',
      valueFormatter: (v) => (typeof v === 'number' ? valueFormatter(v) : String(v ?? '')),
    },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => valueFormatter(v) } },
    yAxis: { type: 'category', data: categories, inverse: true, splitLine: { show: false } },
    series: [
      {
        type: 'bar',
        name: seriesName,
        data: values.map((v, i) => ({ value: v, itemStyle: colors?.[i] ? { color: colors[i] } : undefined })),
        barMaxWidth: 20,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: showLabels
          ? { show: true, position: 'right', formatter: (p) => valueFormatter(Number(p.value)), fontSize: 11 }
          : undefined,
      },
    ],
  };
}
