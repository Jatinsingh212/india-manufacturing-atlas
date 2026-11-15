/**
 * Shared React Query hooks for reference data used by many pages, so they share one cache entry.
 * Page-specific queries should be written in the page (or pages/<area>/api.ts) with `useQuery`
 * and the `api.*` functions.
 *
 *   const { data: ministries } = useMinistries();       // GET /api/meta/ministries
 *   const ministryById = useMinistryLookup();           // id -> MinistryListItem
 *   const { data: me } = useMe();
 *
 * Query-key convention: ['<area>', '<endpoint>', ...params] e.g. ['hsn', 'product', hsn8],
 * ['ministries', id], ['analytics', 'opportunities', filters]. Keys listed in `queryKeys` are shared.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { MinistryListItem, SectorListItem } from './types';

const HOUR = 60 * 60 * 1000;
/** Shared query keys (use them when you invalidate or prefetch). */
export const queryKeys = {
  health: ['meta', 'health'] as const,
  overview: ['meta', 'overview'] as const,
  ministries: ['meta', 'ministries'] as const,
  sectors: ['meta', 'sectors'] as const,
  sections: ['meta', 'sections'] as const,
  countries: ['meta', 'countries'] as const,
  info: ['meta', 'info'] as const,
  valueChains: ['valuechains', 'list'] as const,
  agreements: ['policy', 'agreements'] as const,
  schemes: (kind?: string | null) => ['policy', 'schemes', kind ?? 'all'] as const,
  dataSources: ['datahub', 'sources'] as const,
  assistantStatus: ['assistant', 'status'] as const,
  watchlist: ['watchlist'] as const,
  product: (hsn8: string) => ['hsn', 'product', hsn8] as const,
};

/** GET /api/health */
export function useHealth() {
  return useQuery({ queryKey: queryKeys.health, queryFn: ({ signal }) => api.health({ signal }), staleTime: 5 * 60 * 1000, retry: false });
}

/** GET /api/meta/ministries - all 31 ministries + residual, with code counts. */
export function useMinistries() {
  return useQuery({ queryKey: queryKeys.ministries, queryFn: ({ signal }) => api.ministries({ signal }), staleTime: HOUR });
}

/** GET /api/meta/sectors */
export function useSectors() {
  return useQuery({ queryKey: queryKeys.sectors, queryFn: ({ signal }) => api.sectors({ signal }), staleTime: HOUR });
}

/** GET /api/meta/sections - the 21 HS sections with chapters. */
export function useSections() {
  return useQuery({ queryKey: queryKeys.sections, queryFn: ({ signal }) => api.sections({ signal }), staleTime: HOUR });
}

/** GET /api/meta/countries */
export function useCountries() {
  return useQuery({ queryKey: queryKeys.countries, queryFn: ({ signal }) => api.countries({ signal }), staleTime: HOUR });
}

/** GET /api/valuechains */
export function useValueChains() {
  return useQuery({ queryKey: queryKeys.valueChains, queryFn: ({ signal }) => api.valueChains({ signal }), staleTime: HOUR });
}

/** GET /api/policy/agreements */
export function useAgreements() {
  return useQuery({ queryKey: queryKeys.agreements, queryFn: ({ signal }) => api.agreements({ signal }), staleTime: HOUR });
}

/** GET /api/assistant/status */
export function useAssistantStatus() {
  return useQuery({ queryKey: queryKeys.assistantStatus, queryFn: ({ signal }) => api.assistantStatus({ signal }), staleTime: 10 * 60 * 1000, retry: false });
}

/** id -> ministry map (empty until loaded). */
export function useMinistryLookup(): Map<string, MinistryListItem> {
  const { data } = useMinistries();
  return useMemo(() => new Map((data ?? []).map((m) => [m.id, m])), [data]);
}

/** id -> sector map (empty until loaded). */
export function useSectorLookup(): Map<string, SectorListItem> {
  const { data } = useSectors();
  return useMemo(() => new Map((data ?? []).map((s) => [s.id, s])), [data]);
}

/** Select options for ministries (residual last), e.g. for filters. */
export function useMinistryOptions(includeResidual = true): Array<{ value: string; label: string }> {
  const { data } = useMinistries();
  return useMemo(
    () =>
      (data ?? [])
        .filter((m) => includeResidual || m.id !== 'residual')
        .map((m) => ({ value: m.id, label: m.id === 'residual' ? m.name : `${m.short_name} - ${m.name}` })),
    [data, includeResidual],
  );
}

/** Select options for sectors. */
export function useSectorOptions(): Array<{ value: string; label: string }> {
  const { data } = useSectors();
  return useMemo(() => (data ?? []).map((s) => ({ value: s.id, label: s.name })), [data]);
}


