/**
 * FilterPanel - the Explorer's single filter row (dataviz rule: one filter row above everything it
 * scopes): free-text / code search, ministry, sector, then "More filters" for chapter, mapping status
 * and source, minimum exports / imports (entered in US$ million, sent in US$) and an RCA range.
 * Active filters are echoed as removable chips.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { FilterX, SlidersHorizontal, X } from 'lucide-react';
import { useMinistryLookup, useMinistryOptions, useSections, useSectorLookup, useSectorOptions } from '@/api/hooks';
import { Button, Drawer, SearchInput, Select, TextInput } from '@/components';
import { fmtCode, fmtNum, truncate } from '@/lib/format';
import { MAPPING_SOURCE_LABELS, MAPPING_STATUS_LABELS } from '../shared';
import { activeFilterCount, scopeFromTypedCode, type ExplorePatch, type ExploreState } from '../useExploreState';

interface NumberFilterProps {
  label: string;
  value: number | null;
  /** Multiply the typed value by this before committing (1e6 for US$ million). */
  scale?: number;
  placeholder?: string;
  onCommit: (v: number | null) => void;
  min?: number;
  step?: string;
}

/** Numeric input that commits on blur, Enter or a short pause - not on every keystroke. */
function NumberFilter({ label, value, scale = 1, placeholder, onCommit, min = 0, step = 'any' }: NumberFilterProps) {
  const shown = value === null ? '' : String(+(value / scale).toPrecision(6));
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);

  const commit = (raw: string) => {
    const t = raw.trim();
    if (t === '') {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < min) {
      setText(shown);
      return;
    }
    const next = n * scale;
    if (next !== value) onCommit(next);
  };

  useEffect(() => {
    if (text === shown) return;
    const t = window.setTimeout(() => commit(text), 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-ink-2">{label}</span>
      <TextInput
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        size="sm"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') commit(text);
        }}
      />
    </label>
  );
}

interface Chip {
  key: keyof ExploreState | 'rca';
  label: string;
  clear: ExplorePatch;
}

export interface FilterPanelProps {
  state: ExploreState;
  update: (patch: ExplorePatch) => void;
  reset: () => void;
  onSearch: (text: string) => void;
}

export function FilterPanel({ state, update, reset, onSearch }: FilterPanelProps) {
  const ministryOptions = useMinistryOptions(true);
  const sectorOptions = useSectorOptions();
  const ministries = useMinistryLookup();
  const sectorsById = useSectorLookup();
  const sections = useSections();

  const chapterOptions = useMemo(
    () =>
      (sections.data ?? []).flatMap((s) =>
        s.chapters.map((c) => ({ value: c.code, label: `${c.code} · ${truncate(c.description, 52)}` })),
      ),
    [sections.data],
  );
  const chapterName = useMemo(() => new Map(chapterOptions.map((o) => [o.value, o.label])), [chapterOptions]);

  const advancedActive = Boolean(
    state.chapter || state.mapping_status || state.mapping_source || state.min_exports !== null || state.min_imports !== null || state.rca_min !== null || state.rca_max !== null,
  );
  const [moreOpen, setMoreOpen] = useState(advancedActive);
  useEffect(() => {
    if (advancedActive) setMoreOpen(true);
  }, [advancedActive]);
  const [sheetOpen, setSheetOpen] = useState(false);

  const nActive = activeFilterCount(state);
  // The search box has its own visible field on phones; the filter badge counts only the panel filters.
  const sheetCount = nActive - (state.q ? 1 : 0);

  const chips: Chip[] = [];
  // Removing a typed code also removes the scope it selected; a tree scope stays when only text is removed.
  if (state.q) chips.push({ key: 'q', label: `Search: ${state.q}`, clear: scopeFromTypedCode(state) ? { q: null, code: state.chapter || null } : { q: null } });
  if (state.ministry_id) chips.push({ key: 'ministry_id', label: `Ministry: ${ministries.get(state.ministry_id)?.short_name ?? state.ministry_id}`, clear: { ministry_id: null } });
  if (state.sector_id) chips.push({ key: 'sector_id', label: `Sector: ${sectorsById.get(state.sector_id)?.name ?? state.sector_id}`, clear: { sector_id: null } });
  if (state.chapter) chips.push({ key: 'chapter', label: `Chapter ${chapterName.get(state.chapter) ?? state.chapter}`, clear: { chapter: null, code: state.code.length === 2 ? null : state.code } });
  if (state.mapping_status) chips.push({ key: 'mapping_status', label: `Status: ${MAPPING_STATUS_LABELS[state.mapping_status]}`, clear: { mapping_status: null } });
  if (state.mapping_source) chips.push({ key: 'mapping_source', label: `Source: ${MAPPING_SOURCE_LABELS[state.mapping_source]}`, clear: { mapping_source: null } });
  if (state.min_exports !== null) chips.push({ key: 'min_exports', label: `Exports ≥ $${fmtNum(state.min_exports / 1e6)} mn`, clear: { min_exports: null } });
  if (state.min_imports !== null) chips.push({ key: 'min_imports', label: `Imports ≥ $${fmtNum(state.min_imports / 1e6)} mn`, clear: { min_imports: null } });
  if (state.rca_min !== null || state.rca_max !== null) {
    const label =
      state.rca_min !== null && state.rca_max !== null
        ? `RCA ${state.rca_min}–${state.rca_max}`
        : state.rca_min !== null
          ? `RCA ≥ ${state.rca_min}`
          : `RCA ≤ ${state.rca_max}`;
    chips.push({ key: 'rca', label, clear: { rca_min: null, rca_max: null } });
  }

  return (
    <>
      <div className="rounded-2xl border border-line bg-surface p-3 shadow-card sm:p-4">
        {/* Phones: search stays visible; the facets move into a bottom sheet. */}
        <div className="flex items-center gap-2 md:hidden">
          <SearchInput
            value={state.q}
            onChange={onSearch}
            debounce={350}
            placeholder="HSN code"
            aria-label="Search HSN code or product"
            className="min-w-0 flex-1 [&_input]:h-10!"
          />
          <Button
            icon={SlidersHorizontal}
            variant="secondary"
            onClick={() => setSheetOpen(true)}
            className="h-10! shrink-0 px-3.5"
            aria-label={sheetCount > 0 ? `Filters, ${sheetCount} active` : 'Filters'}
          >
            Filters
            {sheetCount > 0 ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold text-on-brand">{sheetCount}</span>
            ) : null}
          </Button>
        </div>

        <div className="hidden flex-wrap items-end gap-2.5 md:flex">
          <label className="flex min-w-[14rem] flex-[2] flex-col gap-1">
            <span className="text-xs font-medium text-ink-2">Search code or product</span>
            <SearchInput
              value={state.q}
              onChange={onSearch}
              debounce={350}
              placeholder="e.g. 4011 or 'solar modules'"
              aria-label="Search HSN code or product"
            />
          </label>
          <Select
            label="Ministry"
            value={state.ministry_id}
            onChange={(v) => update({ ministry_id: v })}
            options={ministryOptions}
            placeholder="All ministries"
            className="min-w-[12rem] flex-1"
          />
          <Select
            label="Sector"
            value={state.sector_id}
            onChange={(v) => update({ sector_id: v })}
            options={sectorOptions}
            placeholder="All sectors"
            className="min-w-[11rem] flex-1"
          />
          <Button
            icon={SlidersHorizontal}
            variant={moreOpen ? 'secondary' : 'ghost'}
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            className={clsx(advancedActive && 'text-brand-ink')}
          >
            More filters
          </Button>
          {nActive ? (
            <Button icon={FilterX} variant="ghost" onClick={reset}>
              Clear all
            </Button>
          ) : null}
        </div>

        {moreOpen ? (
          <div className="mt-3 hidden gap-2.5 border-t border-line pt-3 sm:grid-cols-2 md:grid lg:grid-cols-4 2xl:grid-cols-7">
            <Select
              label="Chapter"
              size="sm"
              value={state.chapter}
              onChange={(v) => update({ chapter: v, code: v || (state.code.length === 2 ? null : state.code) })}
              options={chapterOptions}
              placeholder="All chapters"
              className="sm:col-span-2 lg:col-span-2 2xl:col-span-2"
            />
            <Select
              label="Mapping status"
              size="sm"
              value={state.mapping_status}
              onChange={(v) => update({ mapping_status: v })}
              options={[
                { value: 'accepted', label: 'Accepted (owner assigned)' },
                { value: 'residual', label: 'Residual (no clear owner)' },
              ]}
              placeholder="Any status"
            />
            <Select
              label="Mapping source"
              size="sm"
              value={state.mapping_source}
              onChange={(v) => update({ mapping_source: v })}
              options={[
                { value: 'dpiit_guidebook', label: MAPPING_SOURCE_LABELS.dpiit_guidebook },
                { value: 'official_upload', label: MAPPING_SOURCE_LABELS.official_upload },
                { value: 'manual', label: MAPPING_SOURCE_LABELS.manual },
                { value: 'rule', label: MAPPING_SOURCE_LABELS.rule },
                { value: 'unmapped', label: MAPPING_SOURCE_LABELS.unmapped },
              ]}
              placeholder="Any source"
            />
            <NumberFilter label="Min exports ($ mn)" value={state.min_exports} scale={1e6} placeholder="0" onCommit={(v) => update({ min_exports: v })} />
            <NumberFilter label="Min imports ($ mn)" value={state.min_imports} scale={1e6} placeholder="0" onCommit={(v) => update({ min_imports: v })} />
            <div className="grid grid-cols-2 gap-2">
              <NumberFilter label="RCA from" value={state.rca_min} placeholder="0" step="0.1" onCommit={(v) => update({ rca_min: v })} />
              <NumberFilter label="RCA to" value={state.rca_max} placeholder="any" step="0.1" onCommit={(v) => update({ rca_max: v })} />
            </div>
          </div>
        ) : null}

        {chips.length ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Active filters">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => update(c.clear)}
                className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-brand/30 bg-brand-soft pr-1.5 pl-2.5 text-[11.5px] font-medium text-brand-ink hover:border-brand"
                aria-label={`Remove filter ${c.label}`}
              >
                <span className="truncate">{c.key === 'q' && /^\d[\d.\s]*$/.test(state.q) ? `Code: ${fmtCode(state.q.replace(/[\s.]/g, ''))}` : c.label}</span>
                <X className="size-3 shrink-0" aria-hidden />
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <Drawer
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        side="bottom"
        title="Filters"
        subtitle={sheetCount ? `${sheetCount} active facet${sheetCount === 1 ? '' : 's'}` : 'Narrow the HSN register'}
        footer={
          <div className="flex items-center gap-2">
            <Button variant="ghost" icon={FilterX} onClick={reset} disabled={!nActive} className="flex-1">
              Clear all
            </Button>
            <Button variant="primary" onClick={() => setSheetOpen(false)} className="flex-1">
              Show results
            </Button>
          </div>
        }
      >
        <div className="grid gap-3.5">
          <Select
            label="Ministry"
            value={state.ministry_id}
            onChange={(v) => update({ ministry_id: v })}
            options={ministryOptions}
            placeholder="All ministries"
          />
          <Select
            label="Sector"
            value={state.sector_id}
            onChange={(v) => update({ sector_id: v })}
            options={sectorOptions}
            placeholder="All sectors"
          />
          <Select
            label="Chapter"
            value={state.chapter}
            onChange={(v) => update({ chapter: v, code: v || (state.code.length === 2 ? null : state.code) })}
            options={chapterOptions}
            placeholder="All chapters"
          />
          <div className="grid grid-cols-2 gap-2.5">
            <Select
              label="Mapping status"
              value={state.mapping_status}
              onChange={(v) => update({ mapping_status: v })}
              options={[
                { value: 'accepted', label: 'Accepted' },
                { value: 'residual', label: 'Residual' },
              ]}
              placeholder="Any status"
            />
            <Select
              label="Mapping source"
              value={state.mapping_source}
              onChange={(v) => update({ mapping_source: v })}
              options={[
                { value: 'dpiit_guidebook', label: 'Guidebook' },
                { value: 'official_upload', label: 'Upload' },
                { value: 'manual', label: 'Manual' },
                { value: 'rule', label: 'Rule' },
                { value: 'unmapped', label: 'Not listed' },
              ]}
              placeholder="Any source"
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <NumberFilter label="Min exports ($ mn)" value={state.min_exports} scale={1e6} placeholder="0" onCommit={(v) => update({ min_exports: v })} />
            <NumberFilter label="Min imports ($ mn)" value={state.min_imports} scale={1e6} placeholder="0" onCommit={(v) => update({ min_imports: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <NumberFilter label="RCA from" value={state.rca_min} placeholder="0" step="0.1" onCommit={(v) => update({ rca_min: v })} />
            <NumberFilter label="RCA to" value={state.rca_max} placeholder="any" step="0.1" onCommit={(v) => update({ rca_max: v })} />
          </div>
          <p className="text-[11.5px] leading-snug text-muted">Filters apply as you change them. Close this panel to see the updated lines.</p>
        </div>
      </Drawer>
    </>
  );
}
