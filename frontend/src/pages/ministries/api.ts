/**
 * Page-local React Query hooks for the ministry and sector dashboards (SPEC 6.2 / 6.4).
 *
 *   const q = useMinistryDashboard(id);                 // GET /api/ministries/{id}
 *   const p = useEntityProducts('ministry', id, params) // GET /api/ministries/{id}/products (server-paginated)
 *   const prov = useAtlasProvenance();                  // trade / mapping provenance from /api/meta/overview
 *
 * Query keys follow the app convention ['<area>', '<endpoint>', ...params].
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/api/client';
import { queryKeys, useCountries } from '@/api/hooks';
import type { EntityProductsParams, Provenance } from '@/api/types';
import { countryFallback, mappingProvenance, tradeProvenance } from './utils';

export type EntityKind = 'ministry' | 'sector';

/**
 * Optional fields the dashboard endpoint (app/routers/ministries.py) returns beyond SPEC 6.4. They are
 * read defensively: every page works without them.
 * - `ranking`: "model" when hotspots / opportunities are ranked by the model scores, "fallback" when the
 *   scores are not available and the API used its transparent ranking (imports x dependency ratio x
 *   top-source share; world market x min(RCA, 3) among RCA >= 1).
 * (`provenance` and `production` are typed on EntityDashboardBase in src/api/types.ts.)
 */
export interface DashboardExtras {
  ranking?: 'model' | 'fallback' | string;
}

/** Extra KPI counters (verified mapping count, ministries covered by a sector, distinct HS6). */
export interface KpiExtras {
  verified_codes?: number | null;
  ministries_covered?: number | null;
  hs6_codes?: number | null;
}

/** Extra hotspot fields: India's import dependence M / (M + X) and the top source's display name. */
export interface HotspotExtras {
  dependency_ratio?: number | null;
  top_import_source_name?: string | null;
}

/** Extra opportunity fields: India's share of world exports and world demand growth. */
export interface OpportunityExtras {
  india_world_share?: number | null;
  world_cagr?: number | null;
}

/** Extra value-chain field: the ministry leads the chain. */
export interface ChainExtras {
  is_lead?: boolean;
}

/** GET /api/ministries/{id} */
export function useMinistryDashboard(id: string) {
  return useQuery({
    queryKey: ['ministries', id],
    queryFn: ({ signal }) => api.ministry(id, { signal }),
    enabled: Boolean(id),
  });
}

/** GET /api/sectors/{id} */
export function useSectorDashboard(id: string) {
  return useQuery({
    queryKey: ['sectors', id],
    queryFn: ({ signal }) => api.sector(id, { signal }),
    enabled: Boolean(id),
  });
}

/** GET /api/{ministries|sectors}/{id}/products - the "Ministry Wise HS Code" table (server-paginated). */
export function useEntityProducts(kind: EntityKind, id: string, params: EntityProductsParams) {
  return useQuery({
    queryKey: [kind === 'ministry' ? 'ministries' : 'sectors', id, 'products', params],
    queryFn: ({ signal }) => (kind === 'ministry' ? api.ministryProducts(id, params, { signal }) : api.sectorProducts(id, params, { signal })),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

/** GET /api/meta/overview (shared cache entry with the Overview page; failures are silent here). */
export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: ({ signal }) => api.overview({ signal }), staleTime: 10 * 60 * 1000, retry: false });
}

/**
 * Provenance of trade values and of the ministry mapping, read from /api/meta/overview (shared cache
 * entry with the Overview page). Falls back to the SPEC defaults while loading or if the call fails,
 * so badges are always shown.
 */
export function useAtlasProvenance(): { trade: Provenance; mapping: Provenance; latestYear: number | null } {
  const q = useOverview();
  const trade = q.data?.provenance?.trade ?? null;
  const mapping = q.data?.provenance?.mapping ?? null;
  const latestYear = q.data?.kpis?.latest_year ?? trade?.year ?? null;
  return useMemo(
    () => ({ trade: tradeProvenance(latestYear ?? undefined, trade), mapping: mappingProvenance(mapping), latestYear }),
    [trade, mapping, latestYear],
  );
}

/** Country-id ('aschn') -> display name, falling back to the ISO3 tail while countries load. */
export function useCountryName(): (id: string | null | undefined) => string | null {
  const { data } = useCountries();
  const map = useMemo(() => new Map((data ?? []).map((c) => [c.id, c.name])), [data]);
  return (id) => (id ? (map.get(id) ?? countryFallback(id)) : null);
}
