/**
 * ClustersCard - manufacturing clusters of a value chain. An ECharts scatter on
 * longitude / latitude (no outline map is drawn: the positions alone show where in India the chain
 * concentrates) with direct labels, next to a clean list (name, district, state, products) that
 * carries every value, so the chart never gates information.
 */
import { useMemo } from 'react';
import { MapPin, MapPinned } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import type { Cluster } from '@/api/types';
import { Card, EChart, EmptyState } from '@/components';
import { BASE_GRID, CATEGORICAL, CHART_TOKENS } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';

/** India's approximate bounding box, so a few points keep their geographic context. */
const INDIA_BOUNDS = { lonMin: 65, lonMax: 100, latMin: 5, latMax: 40 };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function ClustersCard({ clusters, chainName, className }: { clusters: Cluster[]; chainName: string; className?: string }) {
  const { mode } = useTheme();
  const located = useMemo(() => clusters.filter((c) => typeof c.lat === 'number' && typeof c.lon === 'number'), [clusters]);

  const option = useMemo<EChartsOption>(() => {
    const t = CHART_TOKENS[mode];
    return {
      grid: { ...BASE_GRID, top: 12, right: 28, bottom: 8, left: 8 },
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const c = located[(p as { dataIndex: number }).dataIndex];
          if (!c) return '';
          const place = [c.district, c.state].filter(Boolean).join(', ');
          return `<div style="font-weight:600">${esc(c.name)}</div><div>${esc(place)}</div>${c.products ? `<div style="max-width:240px;white-space:normal;margin-top:2px">${esc(c.products)}</div>` : ''}`;
        },
      },
      // degree ticks carry the axis meaning (°E / °N), so no rotated axis titles are needed
      xAxis: {
        type: 'value',
        min: INDIA_BOUNDS.lonMin,
        max: INDIA_BOUNDS.lonMax,
        interval: 5,
        axisLabel: { formatter: (v: number) => `${v}°E`, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        min: INDIA_BOUNDS.latMin,
        max: INDIA_BOUNDS.latMax,
        interval: 5,
        axisLabel: { formatter: (v: number) => `${v}°N` },
      },
      series: [
        {
          type: 'scatter',
          name: 'Clusters',
          data: located.map((c) => [c.lon as number, c.lat as number]),
          symbolSize: 13,
          itemStyle: { color: CATEGORICAL[mode][0], borderColor: t.surface, borderWidth: 2, opacity: 1 },
          label: {
            show: true,
            position: 'right',
            fontSize: 11,
            color: t.ink2,
            formatter: (p) => {
              const c = located[(p as { dataIndex: number }).dataIndex];
              return c ? (c.district ?? c.name) : '';
            },
          },
          labelLayout: { hideOverlap: true },
          emphasis: { scale: 1.3 },
        },
      ],
    };
  }, [located, mode]);

  return (
    <Card
      className={className}
      icon={MapPinned}
      title="Manufacturing clusters"
      subtitle={`Where the ${chainName.toLowerCase()} value chain concentrates in India (curated cluster register)`}
    >
      {clusters.length ? (
        <div className="grid gap-4 lg:grid-cols-5">
          {located.length ? (
            <div className="lg:col-span-3">
              <EChart option={option} height={340} ariaLabel={`Scatter of ${located.length} cluster locations by longitude and latitude`} />
            </div>
          ) : null}
          <ul className={located.length ? 'divide-y divide-line lg:col-span-2' : 'divide-y divide-line lg:col-span-5'}>
            {clusters.map((c) => (
              <li key={c.id} className="py-2.5 first:pt-0">
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden />
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-semibold text-ink">{c.name}</div>
                    <div className="text-xs text-muted">{[c.district, c.state].filter(Boolean).join(', ')}</div>
                    {c.products ? <div className="mt-0.5 text-[12.5px] text-ink-2">{c.products}</div> : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <EmptyState compact icon={MapPinned} title="No clusters recorded" message="No manufacturing cluster is registered for this value chain yet." />
      )}
    </Card>
  );
}
