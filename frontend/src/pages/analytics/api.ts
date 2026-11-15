/**
 * React Query hooks for the Opportunity Lab (SPEC section 6.6, GOV_ROLES only).
 * Query keys follow ['analytics', '<endpoint>', ...params]; `keepPreviousData` holds the previous
 * frame while filters change (dataviz rule: no skeleton flash on refetch).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, apiGet } from '@/api/client';
import type { AnalyticsFilters, DemandSupplyParams, ImportSubstitutionResponse } from '@/api/types';

/**
 * Primary goods left out of the import-substitution ranking (SPEC 6.6, METHODOLOGY 4.5): ores, fuels,
 * unworked stones, precious and unwrought metals. Declared here because src/api/types.ts belongs to
 * the foundation; every field is optional so an older API simply renders no note.
 */
export interface SubstitutionExclusion {
  /** Primary goods in the current selection left out (0 when `included`). */
  n_products?: number | null;
  /** Their import bill, US$ (0 when `included`). */
  imports?: number | null;
  /** The rule in words, with the excluded HS prefixes in parentheses. */
  rule?: string | null;
  /** True when the request asked for `include_primary=true`. */
  included?: boolean | null;
}

export type ImportSubstitutionData = ImportSubstitutionResponse & { excluded?: SubstitutionExclusion | null };

/** GET /api/analytics/opportunities */
export function useOpportunities(f: AnalyticsFilters) {
  return useQuery({
    queryKey: ['analytics', 'opportunities', f],
    queryFn: ({ signal }) => api.opportunities(f, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** GET /api/analytics/import-dependency */
export function useImportDependency(f: AnalyticsFilters) {
  return useQuery({
    queryKey: ['analytics', 'import-dependency', f],
    queryFn: ({ signal }) => api.importDependency(f, { signal }),
    placeholderData: keepPreviousData,
  });
}

/**
 * GET /api/analytics/import-substitution. Primary goods are excluded unless `includePrimary`
 * (`include_primary=true`); the response's `excluded` block says how many were left out.
 */
export function useImportSubstitution(f: AnalyticsFilters, includePrimary = false) {
  return useQuery({
    queryKey: ['analytics', 'import-substitution', f, { include_primary: includePrimary }],
    queryFn: ({ signal }) =>
      apiGet<ImportSubstitutionData>('/api/analytics/import-substitution', { ...f, include_primary: includePrimary ? true : undefined }, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** GET /api/analytics/competitiveness */
export function useCompetitiveness(f: AnalyticsFilters) {
  return useQuery({
    queryKey: ['analytics', 'competitiveness', f],
    queryFn: ({ signal }) => api.competitiveness(f, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** GET /api/analytics/demand-supply (chain_id or sector_id). Disabled until one is chosen. */
export function useDemandSupply(p: DemandSupplyParams) {
  return useQuery({
    queryKey: ['analytics', 'demand-supply', p],
    queryFn: ({ signal }) => api.demandSupply(p, { signal }),
    enabled: Boolean(p.chain_id || p.sector_id),
    placeholderData: keepPreviousData,
  });
}

/** GET /api/analytics/archetypes */
export function useArchetypes(f: AnalyticsFilters) {
  return useQuery({
    queryKey: ['analytics', 'archetypes', f],
    queryFn: ({ signal }) => api.archetypes(f, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** GET /api/analytics/forecast/{code} (hs6 or hsn8). */
export function useForecast(code: string) {
  return useQuery({
    queryKey: ['analytics', 'forecast', code],
    queryFn: ({ signal }) => api.forecast(code, { signal }),
    enabled: code.length >= 6,
  });
}
