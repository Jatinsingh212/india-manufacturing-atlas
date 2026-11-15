/**
 * React Query hooks for the Overview page.
 *
 * - useOverview()            GET /api/meta/overview      (shared cache key queryKeys.overview)
 * - useInfoCards()           GET /api/meta/info          (shared cache key queryKeys.info)
 * - useHsnLookup(code)       GET /api/hsn/lookup/{code}  (enabled only for a valid 2/4/6/8-digit code)
 * - useMinistryProducts(...) GET /api/ministries/{id}/products (server-paginated "Ministry-wise HS code" table)
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, apiGet, normalizeCode } from '@/api/client';
import { queryKeys } from '@/api/hooks';
import type { Provenance, SearchSort, SortOrder } from '@/api/types';

const HOUR = 60 * 60 * 1000;

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: ({ signal }) => api.overview({ signal }), staleTime: 10 * 60 * 1000 });
}

export function useInfoCards() {
  return useQuery({ queryKey: queryKeys.info, queryFn: ({ signal }) => api.info({ signal }), staleTime: HOUR });
}

/** True for a code the lookup endpoint accepts: 2, 4, 6 or 8 digits after removing dots / spaces. */
export function isLookupCode(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /^(\d{2}|\d{4}|\d{6}|\d{8})$/.test(normalizeCode(raw));
}

export function useHsnLookup(code: string) {
  const c = normalizeCode(code);
  return useQuery({
    queryKey: ['hsn', 'lookup', c],
    queryFn: ({ signal }) => api.lookup(c, { signal }),
    enabled: isLookupCode(c),
    placeholderData: keepPreviousData,
  });
}

export interface MinistryProductsQuery {
  ministryId: string;
  q: string;
  page: number;
  pageSize: number;
  sort: SearchSort;
  order: SortOrder;
}

export function useMinistryProducts({ ministryId, q, page, pageSize, sort, order }: MinistryProductsQuery) {
  return useQuery({
    queryKey: ['ministries', ministryId, 'products', { q, page, pageSize, sort, order }],
    queryFn: ({ signal }) =>
      api.ministryProducts(ministryId, { q: q || undefined, page, page_size: pageSize, sort, order }, { signal }),
    enabled: Boolean(ministryId),
    placeholderData: keepPreviousData,
  });
}

/** One node of the ownership flow (sector, ministry or mapping status). */
export interface FlowNode {
  id: string;
  name: string;
  short_name?: string;
  color?: string | null;
  codes: number;
  exports: number;
}

export interface FlowLink {
  source: string;
  target: string;
  codes: number;
  exports: number;
}

/** One exact sector x ministry x status combination behind the tree. */
export interface FlowTriple {
  sector: string;
  ministry: string;
  status: string;
  codes: number;
  exports: number;
}

/** GET /api/meta/flow - sector -> register -> owning ministry -> mapping status. */
export interface OwnershipFlow {
  total_codes: number;
  total_exports: number;
  latest_year: number;
  sectors: FlowNode[];
  ministries: FlowNode[];
  statuses: FlowNode[];
  sector_ministry: FlowLink[];
  ministry_status: FlowLink[];
  sector_ministry_status: FlowTriple[];
  provenance: { mapping: Provenance; trade: Provenance };
}

export function useOwnershipFlow() {
  return useQuery({
    queryKey: ['meta', 'flow'],
    queryFn: ({ signal }) => apiGet<OwnershipFlow>('/api/meta/flow', undefined, { signal }),
    staleTime: 10 * 60 * 1000,
  });
}

/** A node in one breakdown of a flow selection (only the fields that breakdown returns). */
export interface FlowDetailBreakdown {
  id: string;
  codes: number;
  exports: number;
  name?: string;
  short_name?: string;
  color?: string | null;
}

/** One 8-digit line inside a flow selection. */
export interface FlowDetailLine {
  hsn8: string;
  description: string;
  hs6: string;
  sector_id: string;
  sector_name: string;
  ministry_id: string;
  ministry_short: string;
  ministry_name: string;
  status: string;
  exports: number;
  imports: number;
}

/** GET /api/meta/flow/detail - the exact intersection of a tree selection. */
export interface FlowDetail {
  filters: { sector_id: string | null; ministry_id: string | null; status: string | null };
  labels: { sector: string | null; ministry: string | null; status: string | null };
  total_codes: number;
  total_codes_all: number;
  share: number;
  exports: number;
  imports: number;
  breakdown: {
    sectors: FlowDetailBreakdown[];
    ministries: FlowDetailBreakdown[];
    statuses: FlowDetailBreakdown[];
  };
  top_lines: FlowDetailLine[];
  provenance: { mapping: Provenance; trade: Provenance };
}

export interface FlowSelection {
  sector_id?: string | null;
  ministry_id?: string | null;
  status?: string | null;
}

/** Exact lines, breakdown and top products for one sector x ministry x status selection. */
export function useFlowDetail(selection: FlowSelection | null) {
  return useQuery({
    queryKey: ['meta', 'flow', 'detail', selection?.sector_id ?? null, selection?.ministry_id ?? null, selection?.status ?? null],
    queryFn: ({ signal }) =>
      apiGet<FlowDetail>('/api/meta/flow/detail', {
        sector_id: selection?.sector_id ?? undefined,
        ministry_id: selection?.ministry_id ?? undefined,
        status: selection?.status ?? undefined,
      }, { signal }),
    enabled: Boolean(selection),
    staleTime: 10 * 60 * 1000,
  });
}