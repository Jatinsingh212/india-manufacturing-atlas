/**
 * Page-local types and React Query hooks for the product deep-dive (`/deep-dive/:hs4`).
 *
 *   const overview = useDeepDive('9506');                  // GET /api/deep-dive/{hs4}
 *   const ready = useReadiness('9506', 'us', 50);          // GET /api/deep-dive/{hs4}/readiness?market=&extra_duty=
 *   const save = useUpdateMarket();                        // PATCH /api/deep-dive/markets/{id} (admin)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '@/api/client';
import type { Provenance } from '@/api/types';

export interface DdLine {
  hsn8: string;
  hs6: string;
  description: string;
  ministry_id: string;
  ministry: string | null;
  india_exports: number | null;
  india_imports: number | null;
  year: number | null;
  import_policy: string | null;
  export_policy: string | null;
}

export interface DdSubheading {
  hs6: string;
  hs4: string;
  description: string;
  /** Heading (4-digit) description. */
  heading?: string | null;
  /** Basket only: the study's label, its published world exports and HS-version caveats. */
  category?: string | null;
  study_world_exports?: number | null;
  study_year?: number | null;
  note?: string | null;
  india_exports: number | null;
  india_imports: number | null;
  world_trade: number | null;
  trade_balance: number | null;
  rca: number | null;
  india_world_share: number | null;
  india_supplier_rank: number | null;
  top_destination_name: string | null;
  top_destination_share: number | null;
  top_import_source_name: string | null;
  top_import_source_share: number | null;
  china_import_share: number | null;
  export_cagr: number | null;
  import_cagr: number | null;
  india_mfn: number | null;
  lines: DdLine[];
  standards: number[];
  clusters: string[];
}

export interface DdNearbyCluster {
  id: string;
  name: string;
  district: string;
  state: string;
  products: string | null;
  hs_prefixes: string[];
  /** Value-chain input items this cluster's HS mapping covers. */
  inputs: { item: string; hs_code: string; prefix: string; level: 'direct' | 'related' }[];
}

export interface DdCluster {
  id: string;
  name: string;
  cluster_type: string;
  state: string | null;
  district?: string | null;
  /** 'observatory' = the register's district filter, 'name' = inferred from the cluster name, 'curated'. */
  district_source?: 'observatory' | 'name' | 'curated' | null;
  /** Other industrial clusters in the same district, input suppliers first. */
  nearby?: DdNearbyCluster[];
  products: string | null;
  detail?: string | null;
  profile_url: string | null;
  hs_prefixes: string[];
  lat: number | null;
  lon: number | null;
  origin: 'cluster_observatory' | 'value_chain';
  fetched_at?: string;
}

export interface DdStandard {
  id: number;
  hs_prefix: string;
  market_id: string;
  market_name: string;
  scheme: string;
  name: string;
  status: 'mandatory' | 'voluntary' | 'not_applicable' | 'none_found';
  body: string | null;
  url: string | null;
  note: string | null;
  verified: boolean;
  as_of: string | null;
}

export interface DdSource {
  id: string;
  name: string;
  status: string;
  last_refreshed: string | null;
  records: number | null;
}

export interface DdLandSummary {
  parks: number;
  total_ha: number;
  available_ha: number;
  parks_with_land: number;
}

export interface DdLand {
  status: string;
  last_refreshed: string | null;
  cluster_states: string[];
  by_state: (DdLandSummary & { state: string })[];
  by_district: (DdLandSummary & {
    state: string;
    district: string;
    clusters: string[];
    top_parks: {
      name: string;
      sector: string | null;
      type: string | null;
      total_ha: number | null;
      available_ha: number | null;
      plug_and_play: string | null;
      updated: string | null;
    }[];
  })[];
}

export interface DdBasket {
  id: string;
  name: string;
  description: string | null;
  source: string | null;
}

export interface DeepDiveOverview {
  country: { id: string; name: string };
  kind: 'heading' | 'basket';
  basket: DdBasket | null;
  ministries: { id: string; name: string; n_lines: number }[];
  heading: {
    code: string;
    description: string;
    chapter: { code: string; description: string } | null;
    section: { id: string; num: string; name: string } | null;
  };
  sector: { id: string; name: string } | null;
  lead_ministry: { id: string; name: string } | null;
  year: number;
  kpis: {
    india_exports: number | null;
    india_imports: number | null;
    world_trade: number | null;
    trade_balance: number | null;
    india_world_share: number | null;
    n_subheadings: number;
    n_lines: number;
    n_clusters: number;
    n_headings: number;
    study_world_exports: number | null;
    production: { value: number; unit: string; year: number; source: string } | null;
    production_provenance: Provenance;
  };
  subheadings: DdSubheading[];
  clusters: DdCluster[];
  standards: DdStandard[];
  value_chains: { id: string; name: string; title: string }[];
  land: DdLand;
  sources: DdSource[];
  provenance: Record<'trade' | 'lines' | 'clusters' | 'standards', Provenance>;
}

export interface DdMarket {
  id: string;
  name: string;
  wits_code: string;
  country_ids: string[];
  agreement: string | null;
  pref_rate_pct: number | null;
  extra_duty_pct: number;
  extra_duty_basis: string | null;
  extra_duty_status: 'none' | 'verified' | 'user_input';
  source: string | null;
  as_of: string | null;
  note: string | null;
}

export type ReadinessComponent = 'demand' | 'competitiveness' | 'tariff' | 'compliance' | 'capability';
export type ReadinessBand = 'ready' | 'emerging' | 'not_ready';

export interface ReadinessCell {
  hs6: string;
  market_id: string;
  market_imports: number | null;
  india_exports_to_market: number | null;
  rca: number | null;
  mfn_rate: number | null;
  mfn_year: number | null;
  pref_rate: number | null;
  extra_duty: number;
  duty: number | null;
  mandatory_standards: string[];
  voluntary_standards: string[];
  cluster_match: 'product' | 'heading' | null;
  components: Record<ReadinessComponent, number | null>;
  score: number | null;
  uncapped_score: number | null;
  capped: boolean;
  band: ReadinessBand | null;
  missing: ReadinessComponent[];
}

export interface ReadinessResponse {
  hs4: string;
  markets: DdMarket[];
  kind: 'heading' | 'basket';
  subheadings: { hs6: string; description: string; category: string | null; rca: number | null }[];
  cells: ReadinessCell[];
  weights: Record<ReadinessComponent, number>;
  bands: { ready: number; emerging: number };
  extra_duty_override: number | null;
}

export type MarketUpdate = Pick<
  DdMarket,
  'agreement' | 'pref_rate_pct' | 'extra_duty_pct' | 'extra_duty_status' | 'extra_duty_basis' | 'source' | 'as_of' | 'note'
>;

export function useDeepDive(hs4: string) {
  return useQuery({
    queryKey: ['deep-dive', hs4],
    queryFn: ({ signal }) => apiGet<DeepDiveOverview>(`/api/deep-dive/${encodeURIComponent(hs4)}`, undefined, { signal }),
    enabled: hs4.length >= 4,
  });
}

export function useReadiness(hs4: string, market: string | null, extraDuty: number | null) {
  return useQuery({
    queryKey: ['deep-dive', hs4, 'readiness', market, extraDuty],
    queryFn: ({ signal }) =>
      apiGet<ReadinessResponse>(
        `/api/deep-dive/${encodeURIComponent(hs4)}/readiness`,
        { market: market ?? undefined, extra_duty: extraDuty ?? undefined },
        { signal },
      ),
    enabled: hs4.length >= 4,
    placeholderData: (prev) => prev,
  });
}

export interface SyncStatus {
  enabled: boolean;
  applied: Record<string, string | null>;
  manifest?: {
    updated_at?: string;
    seconds?: number;
    sources: Record<string, { status: 'success' | 'failed'; fetched_at?: string; records?: number; message?: string; error?: string }>;
  };
  error?: string;
}

/** GET /api/sync/status - the daily cloud sync (Vercel Cron) and its last run per source. */
export function useSyncStatus() {
  return useQuery({
    queryKey: ['sync-status'],
    queryFn: ({ signal }) => apiGet<SyncStatus>('/api/sync/status', undefined, { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useUpdateMarket() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: MarketUpdate }) =>
      apiPatch<{ market: DdMarket }>(`/api/deep-dive/markets/${encodeURIComponent(id)}`, body),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['deep-dive'] }),
  });
}
