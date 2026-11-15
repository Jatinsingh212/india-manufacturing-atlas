/**
 * React Query hooks for the HSN Explorer.
 *
 * - useHsTree(code)            GET /api/hsn/tree?code=   (no code = the 21 sections), cached for an hour
 * - useProductSearch(p)        GET /api/hsn/search       (server-paginated; keeps the previous page while refetching)
 * - useCompare(codes)          GET /api/hsn/compare      (<= 5 hsn8)
 *
 * The search envelope and parameters go slightly beyond the SPEC 6.3 types, as implemented by the API owner:
 * - `prefix` restricts the result to one code prefix (the HS tree selection), independent of `q`, so a
 *   free-text query can be scoped to a heading ("cotton" within 6109);
 * - `chapter` accepts a comma-separated list (a selected HS section = all of its chapters);
 * - the response carries `match`, the search stage that produced the rows (`code`, `text`,
 *   `text_all_columns`, `text_any`, `none`, or `all` without a query);
 * - the compare response lists the codes it could not find in `not_found`.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, apiGet } from '@/api/client';
import type { CompareResponse, Paginated, ProductSearchParams, ProductSummary } from '@/api/types';

const HOUR = 60 * 60 * 1000;

/** Search stage reported by GET /api/hsn/search. */
export type SearchMatch = 'code' | 'text' | 'text_all_columns' | 'text_any' | 'none' | 'all';

/** GET /api/hsn/search parameters, including the code-prefix scope. */
export interface ExploreSearchParams extends ProductSearchParams {
  /** Code prefix (2-8 digits) the rows must start with. */
  prefix?: string;
  /** One chapter ('61') or a comma-separated list ('50,51,52'). */
  chapter?: string;
}

export interface ExploreSearchResponse extends Paginated<ProductSummary> {
  match?: SearchMatch | string;
}

export interface CompareResult extends CompareResponse {
  not_found?: string[];
}

export function useHsTree(code: string | null, enabled = true) {
  return useQuery({
    queryKey: ['hsn', 'tree', code ?? 'root'],
    queryFn: ({ signal }) => api.tree(code, { signal }),
    staleTime: HOUR,
    enabled,
  });
}

export function useProductSearch(params: ExploreSearchParams, enabled = true) {
  return useQuery({
    queryKey: ['hsn', 'search', params],
    queryFn: ({ signal }) => apiGet<ExploreSearchResponse>('/api/hsn/search', params, { signal }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useCompare(codes: string[], enabled: boolean) {
  const sorted = [...codes].sort();
  return useQuery({
    queryKey: ['hsn', 'compare', sorted],
    queryFn: ({ signal }) => api.compare(sorted, { signal }) as Promise<CompareResult>,
    enabled: enabled && sorted.length > 0,
    placeholderData: keepPreviousData,
  });
}
