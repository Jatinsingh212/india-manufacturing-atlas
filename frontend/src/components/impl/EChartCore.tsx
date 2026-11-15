/**
 * EChartCore - the real ECharts wrapper (loaded lazily by components/EChart.tsx so the echarts
 * bundle is only fetched by pages that draw a chart). Do not import this file directly.
 */
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';
import { echartsTheme } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import type { EChartProps } from '../EChart';

let themesRegistered = false;
function ensureThemes(): void {
  if (themesRegistered) return;
  echarts.registerTheme('atlas-light', echartsTheme('light'));
  echarts.registerTheme('atlas-dark', echartsTheme('dark'));
  themesRegistered = true;
}

export default function EChartCore({ option, height = 300, className, onEvents, loading, notMerge = true, ariaLabel, onReady, renderer = 'canvas' }: EChartProps) {
  const { mode } = useTheme();
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const handlersRef = useRef(onEvents);
  handlersRef.current = onEvents;
  const optionRef = useRef<EChartsOption>(option);
  optionRef.current = option;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // (Re)create the instance when the theme or renderer changes.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    ensureThemes();
    const chart = echarts.init(el, `atlas-${mode}`, { renderer });
    chartRef.current = chart;
    chart.setOption({ aria: { enabled: true }, ...optionRef.current }, { notMerge: true });
    onReadyRef.current?.(chart);

    const ro = new ResizeObserver(() => {
      if (!chart.isDisposed()) chart.resize();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [mode, renderer]);

  // Push option updates.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    chart.setOption({ aria: { enabled: true }, ...option }, { notMerge });
  }, [option, notMerge]);

  // Bind event handlers by name; the wrapper always calls the latest handler.
  const eventNames = Object.keys(onEvents ?? {}).sort().join('|');
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !eventNames) return;
    const names = eventNames.split('|');
    const bound = names.map((name) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (params: any) => handlersRef.current?.[name]?.(params, chart);
      chart.on(name, fn);
      return [name, fn] as const;
    });
    return () => {
      if (chart.isDisposed()) return;
      for (const [name, fn] of bound) chart.off(name, fn);
    };
  }, [eventNames, mode, renderer]);

  // Loading overlay.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    if (loading) {
      chart.showLoading('default', {
        text: '',
        color: mode === 'dark' ? '#93b2ff' : '#0033a0',
        maskColor: mode === 'dark' ? 'rgba(17,28,46,0.6)' : 'rgba(255,255,255,0.6)',
      });
    } else chart.hideLoading();
  }, [loading, mode, renderer]);

  return <div ref={elRef} className={className} style={{ height, width: '100%' }} role="img" aria-label={ariaLabel} />;
}
