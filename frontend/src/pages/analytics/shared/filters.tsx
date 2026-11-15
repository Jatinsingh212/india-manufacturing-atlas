/**
 * Shared, URL-synced analytics filters (ministry, sector, value chain) and the one filter row that
 * scopes every chart and table below it (dataviz rule: one filter row above everything it scopes).
 *
 *   const { filters, values, setFilter, reset, activeCount } = useSharedFilters();
 *   <FilterBar api={shared} />                      // renders the three selects + reset
 *   useOpportunities({ ...filters, limit: 200 })    // filters is an AnalyticsFilters object
 *
 * URL params: `?ministry=<id>&sector=<id>&chain=<id>` so filtered views are shareable deep links.
 * Also exports `useAliasedTab`, which resolves alternative / API-provided tab ids (e.g.
 * `import_substitution`) to this page's canonical tab ids for a controlled <Tabs>.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import clsx from 'clsx';
import { FilterX, SlidersHorizontal, X } from 'lucide-react';
import { useMinistryOptions, useSectorOptions, useValueChains } from '@/api/hooks';
import type { AnalyticsFilters } from '@/api/types';
import { Button, Drawer, Select } from '@/components';
import { useSearchParamState } from '@/lib/hooks';

export type FilterKey = 'ministry' | 'sector' | 'chain';

const PARAM_TO_FIELD: Record<FilterKey, keyof Pick<AnalyticsFilters, 'ministry_id' | 'sector_id' | 'chain_id'>> = {
  ministry: 'ministry_id',
  sector: 'sector_id',
  chain: 'chain_id',
};

export interface SharedFiltersApi {
  /** Filters in API shape (undefined fields omitted). */
  filters: AnalyticsFilters;
  /** Raw URL values ('' when unset). */
  values: Record<FilterKey, string>;
  setFilter: (key: FilterKey, value: string | null) => void;
  reset: () => void;
  activeCount: number;
}

/** Ministry / sector / chain filters kept in the URL query string. */
export function useSharedFilters(): SharedFiltersApi {
  const [params, setParams] = useSearchParams();
  const ministry = params.get('ministry') ?? '';
  const sector = params.get('sector') ?? '';
  const chain = params.get('chain') ?? '';

  const setFilter = useCallback(
    (key: FilterKey, value: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const reset = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        (Object.keys(PARAM_TO_FIELD) as FilterKey[]).forEach((k) => next.delete(k));
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  const filters = useMemo<AnalyticsFilters>(() => {
    const f: AnalyticsFilters = {};
    if (ministry) f.ministry_id = ministry;
    if (sector) f.sector_id = sector;
    if (chain) f.chain_id = chain;
    return f;
  }, [ministry, sector, chain]);

  return {
    filters,
    values: { ministry, sector, chain },
    setFilter,
    reset,
    activeCount: [ministry, sector, chain].filter(Boolean).length,
  };
}

/** Options for the value-chain select (curated Phase I chains). */
export function useChainOptions(): Array<{ value: string; label: string }> {
  const { data } = useValueChains();
  return useMemo(() => (data ?? []).map((c) => ({ value: c.id, label: c.name })), [data]);
}

export interface FilterBarProps {
  api: SharedFiltersApi;
  /** Which filters to show (default all three). */
  show?: ReadonlyArray<FilterKey>;
  /** Extra controls at the end of the row. */
  children?: ReactNode;
  /** Explanatory text under the row. */
  note?: ReactNode;
  className?: string;
}

/**
 * The filter row: ministry, sector and value-chain selects plus "Clear filters". On phones it collapses
 * to one "Filters" button with the active filters as removable chips; the selects open in a bottom sheet.
 */
export function FilterBar({ api, show = ['ministry', 'sector', 'chain'], children, note, className }: FilterBarProps) {
  const ministryOptions = useMinistryOptions();
  const sectorOptions = useSectorOptions();
  const chainOptions = useChainOptions();
  const { values, setFilter, reset, activeCount } = api;
  const [sheetOpen, setSheetOpen] = useState(false);
  const labelOf = (key: FilterKey, v: string) =>
    (key === 'ministry' ? ministryOptions : key === 'sector' ? sectorOptions : chainOptions).find((o) => o.value === v)?.label ?? v;
  const chips = show.filter((k) => values[k]);

  const selects = (
    <>
      {show.includes('ministry') ? (
        <Select label="Ministry / Department" size="sm" className="w-full sm:w-64 sm:min-w-48" value={values.ministry}
          onChange={(v) => setFilter('ministry', v)} options={ministryOptions} placeholder="All ministries" />
      ) : null}
      {show.includes('sector') ? (
        <Select label="Sector" size="sm" className="w-full sm:w-56 sm:min-w-44" value={values.sector}
          onChange={(v) => setFilter('sector', v)} options={sectorOptions} placeholder="All sectors" />
      ) : null}
      {show.includes('chain') ? (
        <Select label="Value chain" size="sm" className="w-full sm:w-56 sm:min-w-44" value={values.chain}
          onChange={(v) => setFilter('chain', v)} options={chainOptions} placeholder="All products" />
      ) : null}
    </>
  );

  return (
    <>
      {/* phones: compact bar + bottom sheet */}
      <div className={clsx('sm:hidden', className)}>
        <div className="flex items-center gap-2 overflow-x-auto atlas-scrollbar-none">
          <Button size="sm" variant={activeCount ? 'primary' : 'secondary'} icon={SlidersHorizontal} onClick={() => setSheetOpen(true)}
            className="shrink-0">
            Filters{activeCount ? ` · ${activeCount}` : ''}
          </Button>
          {chips.map((k) => (
            <button key={k} type="button" onClick={() => setFilter(k, null)}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-brand/30 bg-brand-soft px-2.5 py-1 text-[12px] font-medium text-brand-ink active:scale-95">
              <span className="max-w-40 truncate">{labelOf(k, values[k])}</span>
              <X className="size-3.5" aria-label="Remove filter" />
            </button>
          ))}
          {!chips.length ? <span className="text-[12px] text-muted">All ministries, sectors and chains</span> : null}
        </div>
        {children ? <div className="mt-2 flex flex-wrap items-end gap-2">{children}</div> : null}
        {note ? <div className="mt-2 text-xs text-muted">{note}</div> : null}
        <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} side="bottom" title="Filter the analysis"
          footer={
            <div className="flex gap-2">
              <Button variant="ghost" icon={FilterX} onClick={reset} disabled={!activeCount} className="flex-1">Clear</Button>
              <Button variant="primary" onClick={() => setSheetOpen(false)} className="flex-1">Show results</Button>
            </div>
          }>
          <div className="space-y-3">{selects}</div>
        </Drawer>
      </div>

      {/* tablets and desktops: the inline filter row */}
      <div className={clsx('hidden rounded-xl border border-line bg-surface p-3 shadow-card sm:block sm:p-4', className)}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2 self-center pr-1 text-[13px] font-semibold text-ink">
            <SlidersHorizontal className="size-4 text-brand-ink" aria-hidden />
            Filters
          </div>
          {selects}
          {children}
          <div className="ml-auto flex items-center gap-2">
            {activeCount ? <span className="text-xs text-muted">{activeCount} active</span> : null}
            <Button size="sm" variant="ghost" icon={FilterX} onClick={reset} disabled={!activeCount}>
              Clear filters
            </Button>
          </div>
        </div>
        {note ? <div className="mt-2 text-xs text-muted">{note}</div> : null}
      </div>
    </>
  );
}

/**
 * Active tab from `?<param>=`, resolving alternative ids (e.g. `import_substitution` from the policy
 * use-case API, or snake_case variants) to canonical ids synchronously, so deep links never flash the
 * wrong tab. Unknown values fall back to `defaultId`. The setter writes canonical ids (and removes the
 * param for the default tab, keeping URLs short). Use with a controlled `<Tabs value onChange>`.
 */
export function useAliasedTab<V extends string>(
  ids: ReadonlyArray<V>,
  aliases: Readonly<Record<string, V>>,
  defaultId: V,
  param = 'tab',
): [V, (id: V) => void] {
  const [raw, setRaw] = useSearchParamState(param, defaultId);
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const active: V = (ids as ReadonlyArray<string>).includes(raw) ? (raw as V) : (aliases[raw] ?? aliases[key] ?? defaultId);

  // Normalise an alias in the address bar (replace navigation, no history entry).
  useEffect(() => {
    if (raw !== active && raw !== defaultId && (aliases[raw] || aliases[key])) setRaw(active);
  }, [raw, key, active, aliases, defaultId, setRaw]);

  return [active, setRaw as (id: V) => void];
}
