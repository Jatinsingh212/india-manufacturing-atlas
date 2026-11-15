/**
 * URL-synced state of the HSN Explorer (`/explore`).
 *
 * Every filter lives in the query string so a view can be shared or bookmarked:
 *   q, ministry_id, sector_id, chapter, mapping_status, mapping_source,
 *   min_exports, min_imports (US$, same unit as the API), rca_min, rca_max,
 *   sort, order, page, page_size, code (the HS tree node that is selected / expanded).
 *
 * Defaults are omitted from the URL: sort = relevance when `q` is set, else exports; order = asc for
 * `code`, else desc; page 1; page_size 25. Changing any filter returns to page 1. Updates use
 * `replace` navigation so tweaking filters does not flood the browser history.
 *
 * Scope (`code`): the selected HS tree node narrows the table independently of the text query -
 * a 2-8 digit code is sent as the API's `prefix` filter, a section (roman numeral) as the list of its
 * chapters. A code typed into the search box selects its tree node too (`/explore?q=4011` scopes the
 * table to heading 4011 exactly, without description hits that merely cite the code).
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { normalizeCode } from '@/api/client';
import type { MappingSource, MappingStatus, SearchSort, SortOrder } from '@/api/types';
import type { ExploreSearchParams } from './api';

export const SEARCH_SORTS: readonly SearchSort[] = ['relevance', 'exports', 'imports', 'rca', 'code', 'world_trade'];
const MAPPING_STATUSES: readonly MappingStatus[] = ['accepted', 'residual'];
const MAPPING_SOURCES: readonly MappingSource[] = ['dpiit_guidebook', 'rule', 'official_upload', 'manual', 'unmapped'];
export const PAGE_SIZES = [25, 50, 100, 200] as const;

export interface ExploreState {
  q: string;
  ministry_id: string;
  sector_id: string;
  chapter: string;
  mapping_status: MappingStatus | '';
  mapping_source: MappingSource | '';
  min_exports: number | null;
  min_imports: number | null;
  rca_min: number | null;
  rca_max: number | null;
  sort: SearchSort;
  order: SortOrder;
  page: number;
  page_size: number;
  /** Selected HS tree node: section roman numeral, or a 2/4/6/8-digit code. */
  code: string;
}

export type ExplorePatch = Partial<Record<keyof ExploreState, string | number | null | undefined>>;

/** Keys that narrow the result set (used for the active-filter count and chips). */
export const FILTER_KEYS = [
  'q',
  'ministry_id',
  'sector_id',
  'chapter',
  'mapping_status',
  'mapping_source',
  'min_exports',
  'min_imports',
  'rca_min',
  'rca_max',
] as const satisfies ReadonlyArray<keyof ExploreState>;

function num(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pick<T extends string>(v: string | null, allowed: readonly T[]): T | '' {
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : '';
}

/** Is `text` a pure HS code (2-8 digits after removing dots / spaces)? */
export function isCodeQuery(text: string | null | undefined): boolean {
  return Boolean(text) && /^\d{2,8}$/.test(normalizeCode(String(text)));
}

export function parseExploreState(params: URLSearchParams): ExploreState {
  const q = (params.get('q') ?? '').trim();
  const sortRaw = pick(params.get('sort'), SEARCH_SORTS);
  // Relevance only means something for a text / code query.
  const sort: SearchSort = sortRaw && !(sortRaw === 'relevance' && !q) ? sortRaw : q ? 'relevance' : 'exports';
  const orderRaw = params.get('order');
  const order: SortOrder = orderRaw === 'asc' || orderRaw === 'desc' ? orderRaw : sort === 'code' ? 'asc' : 'desc';
  const page = Math.max(1, Math.floor(num(params.get('page')) ?? 1));
  const sizeRaw = Math.floor(num(params.get('page_size')) ?? 25);
  const page_size = (PAGE_SIZES as readonly number[]).includes(sizeRaw) ? sizeRaw : 25;
  const codeParam = (params.get('code') ?? '').trim();
  // Deep links such as /explore?q=4011 select the matching tree node too.
  const code = codeParam || (isCodeQuery(q) ? normalizeCode(q) : '');
  return {
    q,
    ministry_id: params.get('ministry_id') ?? '',
    sector_id: params.get('sector_id') ?? '',
    chapter: (params.get('chapter') ?? '').replace(/\D/g, '').slice(0, 2),
    mapping_status: pick(params.get('mapping_status'), MAPPING_STATUSES),
    mapping_source: pick(params.get('mapping_source'), MAPPING_SOURCES),
    min_exports: num(params.get('min_exports')),
    min_imports: num(params.get('min_imports')),
    rca_min: num(params.get('rca_min')),
    rca_max: num(params.get('rca_max')),
    sort,
    order,
    page,
    page_size,
    code,
  };
}

/** Is the selected scope a section (roman numeral) rather than an HS code? */
export function isSectionScope(code: string): boolean {
  return Boolean(code) && !/^\d+$/.test(code);
}

/** True when the scope was set by typing its code into the search box (q = the scope code). */
export function scopeFromTypedCode(s: Pick<ExploreState, 'q' | 'code'>): boolean {
  return Boolean(s.code) && isCodeQuery(s.q) && normalizeCode(s.q) === s.code;
}

/** Report filters (no paging) for GET /api/reports/search. */
export type ExploreReportParams = Omit<ExploreSearchParams, 'page' | 'page_size'>;

/**
 * Filters in the shape of GET /api/hsn/search (and /api/reports/search) - empty values dropped.
 * `sectionChapters` are the chapters of the selected section (from /api/meta/sections), used when the
 * scope is a section and no single chapter is chosen.
 */
export function toReportParams(s: ExploreState, sectionChapters?: readonly string[] | null): ExploreReportParams {
  const numericScope = /^\d{2,8}$/.test(s.code) ? s.code : undefined;
  const chapter = s.chapter || (isSectionScope(s.code) && sectionChapters?.length ? sectionChapters.join(',') : undefined);
  return {
    q: s.q || undefined,
    ministry_id: s.ministry_id || undefined,
    sector_id: s.sector_id || undefined,
    chapter,
    // A selected chapter is already the chapter facet; deeper codes go to the prefix filter.
    prefix: numericScope && numericScope !== s.chapter ? numericScope : undefined,
    mapping_status: s.mapping_status || undefined,
    mapping_source: s.mapping_source || undefined,
    min_exports: s.min_exports ?? undefined,
    min_imports: s.min_imports ?? undefined,
    rca_min: s.rca_min ?? undefined,
    rca_max: s.rca_max ?? undefined,
    sort: s.sort,
    order: s.order,
  };
}

export function toSearchParams(s: ExploreState, sectionChapters?: readonly string[] | null): ExploreSearchParams {
  return { ...toReportParams(s, sectionChapters), page: s.page, page_size: s.page_size };
}

/** Number of active narrowing filters. */
export function activeFilterCount(s: ExploreState): number {
  return FILTER_KEYS.filter((k) => {
    const v = s[k];
    return v !== '' && v !== null && v !== undefined;
  }).length;
}

export function useExploreState(): [ExploreState, (patch: ExplorePatch) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseExploreState(params), [params]);

  const update = useCallback(
    (patch: ExplorePatch) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === '') next.delete(k);
            else next.set(k, String(v));
          }
          // Any change other than paging returns to the first page.
          if (!('page' in patch)) next.delete('page');
          if (next.get('page') === '1') next.delete('page');
          if (next.get('page_size') === '25') next.delete('page_size');
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
        const next = new URLSearchParams();
        const size = prev.get('page_size');
        if (size) next.set('page_size', size);
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  return [state, update, reset];
}
