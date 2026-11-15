/**
 * EChart - theme-aware Apache ECharts wrapper.
 *
 *   <EChart option={option} height={320} onEvents={{ click: (p) => navigate(routes.ministry(p.data.id)) }} />
 *
 * - The Atlas ECharts themes ('atlas-light' / 'atlas-dark', from src/lib/theme.ts) apply automatically
 *   and switch with the app theme: validated categorical palette, hairline solid grid, 2 px lines,
 *   <= 24 px bars with 4 px rounded ends, surface-ringed symbols, ink-coloured labels.
 * - Resizes with its container (ResizeObserver). `height` must include the axis-label band.
 * - `notMerge` (default true) replaces the whole option on every change.
 * - `onReady(chart)` exposes the instance (dispatchAction, getDataURL ...).
 * - The echarts library is code-split: it downloads only when a chart first renders.
 *
 * Dataviz rules to follow in options: one y-axis (never dual axes); colour follows the entity (use
 * ministryColor / sectorColor / colorForKey); a legend for >= 2 series; selective direct labels;
 * tooltips enhance but never gate - keep a table view (DataTable) for the numbers.
 */
import { lazy, Suspense } from 'react';
import type { ECharts, EChartsOption } from 'echarts';
import { Skeleton } from './Loading';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EChartEventHandler = (params: any, chart: ECharts) => void;

export interface EChartProps {
  option: EChartsOption;
  /** px or CSS length (default 300). */
  height?: number | string;
  className?: string;
  /** ECharts events by name: click, mouseover, legendselectchanged, datazoom ... */
  onEvents?: Record<string, EChartEventHandler>;
  /** Shows the ECharts loading mask. */
  loading?: boolean;
  /** Replace instead of merge on option change (default true). */
  notMerge?: boolean;
  /** Accessible label for the chart region. */
  ariaLabel?: string;
  onReady?: (chart: ECharts) => void;
  renderer?: 'canvas' | 'svg';
}

const EChartCore = lazy(() => import('./impl/EChartCore'));

export function EChart(props: EChartProps) {
  const height = props.height ?? 300;
  return (
    <Suspense
      fallback={
        <div style={{ height }} className="w-full">
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      }
    >
      <div style={{ minHeight: height }} className="w-full">
        <EChartCore {...props} height={height} />
      </div>
    </Suspense>
  );
}
