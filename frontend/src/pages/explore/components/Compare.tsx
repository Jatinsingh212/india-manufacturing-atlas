/**
 * Compare tray and comparison view for the Explorer.
 *
 * - usePinned(): up to 5 pinned lines, persisted per viewer in localStorage. Each pin keeps a fixed
 *   colour slot from the moment it is pinned, so removing one product never repaints the others
 *   (dataviz rule: colour follows the entity, never its rank).
 * - <CompareTray>: sticky bar listing the pins, with "Compare" and "Clear".
 * - <CompareModal>: GET /api/hsn/compare -> a side-by-side table (metrics x products) and an overlaid
 *   2018-2024 trend chart on one US$ axis (Exports / Imports / World trade toggle).
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { EChartsOption } from 'echarts';
import { ArrowUpRight, GitCompareArrows, Trash2, X } from 'lucide-react';
import type { CompareItem, ProductSummary } from '@/api/types';
import {
  Button,
  CodeLink,
  EChart,
  ErrorState,
  LoadingBlock,
  MinistryPill,
  Modal,
  ProvenanceBadge,
  SectorPill,
  SegmentedControl,
  useToast,
} from '@/components';
import { fmtCode, fmtNum, fmtPct, fmtRatio, fmtUSD, truncate } from '@/lib/format';
import { useLocalStorage } from '@/lib/hooks';
import { routes } from '@/lib/routes';
import { BASE_GRID, categorical } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { useCompare } from '../api';
import { BcdCell, distinctLabels, mappingProvenance, MAPPING_SOURCE_LABELS, tradeProvenance } from '../shared';

export const MAX_COMPARE = 5;

export interface PinnedItem {
  hsn8: string;
  description: string;
  /** Fixed categorical colour slot (0-4). */
  slot: number;
}

export interface PinnedApi {
  pinned: PinnedItem[];
  isPinned: (hsn8: string) => boolean;
  toggle: (row: Pick<ProductSummary, 'hsn8' | 'description'>) => void;
  remove: (hsn8: string) => void;
  clear: () => void;
}

export function usePinned(): PinnedApi {
  const [stored, setStored] = useLocalStorage<PinnedItem[]>('atlas.explore.compare', []);
  const toast = useToast();
  const pinned = useMemo(() => (Array.isArray(stored) ? stored.filter((p) => p && /^\d{8}$/.test(p.hsn8)).slice(0, MAX_COMPARE) : []), [stored]);

  return useMemo<PinnedApi>(
    () => ({
      pinned,
      isPinned: (hsn8) => pinned.some((p) => p.hsn8 === hsn8),
      toggle: (row) => {
        if (pinned.some((p) => p.hsn8 === row.hsn8)) {
          setStored(pinned.filter((p) => p.hsn8 !== row.hsn8));
          return;
        }
        if (pinned.length >= MAX_COMPARE) {
          toast.info('Compare holds up to 5 products', 'Remove one from the tray to add another.');
          return;
        }
        const used = new Set(pinned.map((p) => p.slot));
        const slot = [0, 1, 2, 3, 4].find((s) => !used.has(s)) ?? 0;
        setStored([...pinned, { hsn8: row.hsn8, description: row.description, slot }]);
      },
      remove: (hsn8) => setStored(pinned.filter((p) => p.hsn8 !== hsn8)),
      clear: () => setStored([]),
    }),
    [pinned, setStored, toast],
  );
}

export function CompareTray({ api, onCompare }: { api: PinnedApi; onCompare: () => void }) {
  const { mode } = useTheme();
  if (!api.pinned.length) return null;
  return (
    <div
      className="sticky bottom-[calc(var(--atlas-bottomnav-h)+0.75rem+env(safe-area-inset-bottom,0px))] z-20 mt-4 lg:bottom-3"
      role="region"
      aria-label="Compare tray"
    >
      {/* Phones: label and buttons on the first row, the pins on their own full-width row below. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-navy px-3 py-2.5 text-on-navy shadow-pop sm:px-4">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-white">
          <GitCompareArrows className="size-4" aria-hidden />
          Compare {api.pinned.length}/{MAX_COMPARE}
        </span>
        <ul className="order-last flex min-w-0 basis-full flex-wrap gap-1.5 sm:order-none sm:flex-1 sm:basis-0">
          {api.pinned.map((p) => (
            <li
              key={p.hsn8}
              className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-white/10 pr-1 pl-2.5 text-[12px] sm:max-w-[15rem]"
              title={p.description}
            >
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: categorical(p.slot, mode) }} aria-hidden />
              <span className="shrink-0 font-mono atlas-num">{fmtCode(p.hsn8)}</span>
              <span className="hidden min-w-0 truncate text-on-navy-muted sm:inline">{truncate(p.description, 26)}</span>
              <button
                type="button"
                onClick={() => api.remove(p.hsn8)}
                className="shrink-0 rounded-full p-0.5 text-on-navy-muted hover:bg-white/15 hover:text-white"
                aria-label={`Remove ${fmtCode(p.hsn8)} from compare`}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <span className="ml-auto inline-flex items-center gap-2 sm:ml-0">
          <Button size="sm" variant="navy" icon={Trash2} onClick={api.clear}>
            Clear
          </Button>
          <Button size="sm" variant="accent" icon={GitCompareArrows} onClick={onCompare} disabled={api.pinned.length < 2} title={api.pinned.length < 2 ? 'Pin at least two products' : undefined}>
            Compare
          </Button>
        </span>
      </div>
    </div>
  );
}

type Metric = 'exports' | 'imports' | 'world_trade';
const METRIC_LABEL: Record<Metric, string> = { exports: "India's exports", imports: "India's imports", world_trade: 'World trade' };

interface RowDef {
  label: string;
  render: (item: CompareItem) => ReactNode;
}

const ROWS: RowDef[] = [
  { label: 'Product', render: (i) => <span className="line-clamp-3 leading-snug">{i.description}</span> },
  { label: 'Ministry', render: (i) => <MinistryPill ministry={{ id: i.ministry_id, short_name: i.ministry_short, name: i.ministry_name }} size="xs" /> },
  { label: 'Sector', render: (i) => (i.sector_id ? <SectorPill sector={{ id: i.sector_id, name: i.sector_name }} size="xs" /> : 'Not available') },
  {
    label: 'Mapping',
    render: (i) => (
      <span className="inline-flex flex-wrap items-center gap-1">
        <ProvenanceBadge provenance={mappingProvenance(i.mapping_source, i.mapping_status)} size="xs" />
        <span className="text-[11px] text-muted">{MAPPING_SOURCE_LABELS[i.mapping_source] ?? i.mapping_source}</span>
      </span>
    ),
  },
  { label: 'Exports 2024', render: (i) => fmtUSD(i.exports) },
  { label: 'Imports 2024', render: (i) => fmtUSD(i.imports) },
  {
    label: 'Trade balance',
    render: (i) => (typeof i.exports === 'number' && typeof i.imports === 'number' ? fmtUSD(i.exports - i.imports, { signed: true }) : 'Not available'),
  },
  { label: 'World trade', render: (i) => fmtUSD(i.world_trade) },
  { label: "India's share of world exports", render: (i) => fmtPct(i.india_world_share) },
  { label: 'RCA', render: (i) => fmtRatio(i.rca) },
  { label: 'Export CAGR 2018–24', render: (i) => fmtPct(i.export_cagr, { signed: true }) },
  { label: 'Import CAGR 2018–24', render: (i) => fmtPct(i.import_cagr, { signed: true }) },
  { label: 'BCD / MFN tariff', render: (i) => <BcdCell row={i} /> },
  { label: 'National lines in HS6', render: (i) => fmtNum(i.lines_in_hs6) },
];

function CompareChart({ items, slotOf }: { items: CompareItem[]; slotOf: Map<string, number> }) {
  const [metric, setMetric] = useState<Metric>('exports');
  const { mode } = useTheme();
  const option = useMemo<EChartsOption>(() => {
    const years = Array.from(new Set(items.flatMap((i) => i.series.map((s) => s.year)))).sort((a, b) => a - b);
    const labels = distinctLabels(items.map((i) => i.description));
    return {
      grid: { ...BASE_GRID, top: 40 },
      legend: { top: 0, left: 0, type: 'scroll' },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (typeof v === 'number' ? fmtUSD(v) : 'Not available') },
      xAxis: { type: 'category', data: years.map(String), boundaryGap: false },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtUSD(v, { sig: 2 }) } },
      series: items.map((i, idx) => {
        const byYear = new Map(i.series.map((s) => [s.year, s[metric] ?? null]));
        const color = categorical(slotOf.get(i.hsn8) ?? 0, mode);
        return {
          type: 'line',
          name: `${fmtCode(i.hsn8)} ${labels[idx]}`,
          data: years.map((y) => byYear.get(y) ?? null),
          itemStyle: { color },
          lineStyle: { color, width: 2 },
          connectNulls: false,
          emphasis: { focus: 'series' },
        };
      }),
    } as EChartsOption;
  }, [items, slotOf, metric, mode]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-ink">{METRIC_LABEL[metric]}, 2018–2024 (US$)</div>
        <SegmentedControl<Metric>
          value={metric}
          onChange={setMetric}
          size="xs"
          ariaLabel="Trend measure"
          className="ml-auto"
          options={[
            { value: 'exports', label: 'Exports' },
            { value: 'imports', label: 'Imports' },
            { value: 'world_trade', label: 'World trade' },
          ]}
        />
      </div>
      <EChart option={option} height={300} ariaLabel={`${METRIC_LABEL[metric]} trend for the compared products`} />
      <div className="mt-1 flex items-center gap-2 text-[11.5px] text-muted">
        <ProvenanceBadge provenance={tradeProvenance()} size="xs" />
        HS6-level values; lines sharing a subheading share its series.
      </div>
    </div>
  );
}

export function CompareModal({ open, onClose, pinned }: { open: boolean; onClose: () => void; pinned: PinnedItem[] }) {
  const codes = useMemo(() => pinned.map((p) => p.hsn8), [pinned]);
  const q = useCompare(codes, open);
  const slotOf = useMemo(() => new Map(pinned.map((p) => [p.hsn8, p.slot])), [pinned]);
  const { mode } = useTheme();
  // Keep the tray order (the API may return items in any order).
  const items = useMemo(() => {
    const byCode = new Map((q.data?.items ?? []).map((i) => [i.hsn8, i]));
    return codes.map((c) => byCode.get(c)).filter((i): i is CompareItem => Boolean(i));
  }, [q.data, codes]);
  // Only judge a fresh response: while new pins load, the previous comparison is a placeholder.
  const missing = useMemo(
    () => (q.data && !q.isPlaceholderData ? codes.filter((c) => !items.some((i) => i.hsn8 === c)) : []),
    [q.data, q.isPlaceholderData, codes, items],
  );

  return (
    <Modal open={open} onClose={onClose} size="xl" title="Compare products" description="Side-by-side trade, tariff and competitiveness for the pinned lines (2024, HS6 level).">
      {q.isPending ? (
        <LoadingBlock height={320} label="Loading the comparison…" />
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : !items.length ? (
        <p className="py-8 text-center text-sm text-muted">None of the pinned lines could be found.</p>
      ) : (
        <div className="space-y-6">
          {missing.length ? (
            <p className="rounded-lg border border-na/30 bg-na-soft px-3 py-2 text-[12.5px] text-na-ink" role="status">
              {missing.length === 1 ? 'One pinned line is' : `${missing.length} pinned lines are`} no longer in the Atlas and left out:{' '}
              <span className="font-mono">{missing.map((c) => fmtCode(c)).join(', ')}</span>. Remove {missing.length === 1 ? 'it' : 'them'} from the tray.
            </p>
          ) : null}
          <div className="atlas-scroll-x overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Comparison of pinned products (scroll horizontally for all columns)">
            <table className="w-full min-w-[640px] text-[12.5px]">
              <caption className="sr-only">Comparison of pinned products</caption>
              <thead>
                <tr className="bg-surface-2">
                  <th scope="col" className="w-40 px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-ink-2 uppercase">
                    Measure
                  </th>
                  {items.map((i) => (
                    <th key={i.hsn8} scope="col" className="px-3 py-2 text-left align-bottom">
                      <span className="flex items-center gap-1.5">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: categorical(slotOf.get(i.hsn8) ?? 0, mode) }} aria-hidden />
                        <CodeLink code={i.hsn8} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.label} className="border-t border-line">
                    <th scope="row" className="px-3 py-2 text-left align-top font-medium text-ink-2">
                      {r.label}
                    </th>
                    {items.map((i) => (
                      <td key={i.hsn8} className="px-3 py-2 align-top text-ink atlas-num">
                        {r.render(i)}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-line">
                  <th scope="row" className="px-3 py-2 text-left font-medium text-ink-2">
                    Details
                  </th>
                  {items.map((i) => (
                    <td key={i.hsn8} className="px-3 py-2">
                      <Button to={routes.product(i.hsn8)} size="xs" variant="link" iconRight={ArrowUpRight}>
                        Product page
                      </Button>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <CompareChart items={items} slotOf={slotOf} />
        </div>
      )}
    </Modal>
  );
}
