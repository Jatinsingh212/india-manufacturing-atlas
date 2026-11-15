/**
 * Types and hooks for the Product workflow page (`/workflow/:chainId?product=<hs>`), backed by
 * GET /api/workflow (picker) and GET /api/workflow/{chain_id}?product= (the whole story in one response).
 */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/api/client';
import type { CountryValue, Provenance } from '@/api/types';

export type Severity = 'high' | 'medium' | 'low';

export interface WatchOut {
  severity: Severity;
  step: 'product' | 'made_by' | 'inputs' | 'competition' | 'standards' | 'markets';
  title: string;
  detail: string;
  kind?: string;
}

export interface WfMinistry {
  id: string;
  short_name?: string;
  name: string;
  color?: string | null;
}

export interface WfProduct {
  name: string;
  hs_code: string;
  hsn8: string | null;
  hs6: string;
  hs6_description: string | null;
  description: string | null;
  ministries: WfMinistry[];
  trade_level: 'hsn8' | 'hs6';
  exports: number | null;
  imports: number | null;
  balance: number | null;
  trade_year: number | null;
  world_trade: number | null;
  india_world_share: number | null;
  india_rank: number | null;
  n_exporters: number | null;
  rca: number | null;
  export_cagr: number | null;
  world_cagr: number | null;
  top_destination: string | null;
  top_destination_share: number | null;
  top_import_source: string | null;
  top_import_source_share: number | null;
  tax: { import_duty_bcd: number | null; import_duty_year: number | null; gst: number | null; gst_note: string };
  dgft_policy: Record<string, string>;
  year: number;
  provenance: Provenance;
}

export interface WfCluster {
  id: string;
  name: string;
  state: string | null;
  district?: string | null;
  district_source?: string | null;
  products: string | null;
  detail?: string | null;
  profile_url: string | null;
  origin: 'cluster_observatory' | 'value_chain';
  match: 'product' | 'family' | 'chain' | 'industry';
  nearby?: { id: string; name: string; products: string | null; inputs: { item: string; level: string }[] }[];
}

export interface WfLandDistrict {
  state: string;
  district: string;
  clusters: string[];
  parks: number;
  total_ha: number;
  available_ha: number;
  parks_with_land: number;
  top_parks: { name: string; available_ha: number | null; total_ha: number | null; sector: string | null; type: string | null }[];
}

export interface WfInput {
  name: string;
  hs_code: string;
  hs6: string | null;
  description: string | null;
  ministries: WfMinistry[];
  india_exports: number | null;
  india_imports: number | null;
  balance: number | null;
  import_duty_bcd: number | null;
  status: 'imported' | 'exported' | 'both' | 'no_data';
  top_import_source: string | null;
  top_import_source_share: number | null;
  china_import_share: number | null;
  feeds_product: number | null;
  flags: ('import_dependent' | 'china_dependent' | 'high_input_duty')[];
}

export interface WfStandard {
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
}

export interface WfMarket {
  market_id: string;
  market: string;
  agreement: string | null;
  extra_duty_status: string;
  duty_on_india: number | null;
  competitor_mfn: number | null;
  gap_pts: number | null;
  market_imports: number | null;
  india_exports_to_market: number | null;
  score: number | null;
  band: 'ready' | 'emerging' | 'not_ready' | null;
  capped: boolean;
  mandatory_standards: string[];
  flags: (WatchOut & { kind: string })[];
}

export interface Workflow {
  chain: { id: string; name: string; title: string; description: string | null };
  products: { hs_code: string; name: string }[];
  product: WfProduct;
  made_by: { manufacturers: { name: string; url: string | null }[]; clusters: WfCluster[]; land: { status: string; by_district: WfLandDistrict[] } };
  inputs: {
    stages: { stage_id: string; name: string; ministry_text: string | null; items: WfInput[] }[];
    summary: { total: number; imported: number; exported: number; feeding_product: number; china_dependent: number };
  };
  competition: {
    world_exporters: CountryValue[];
    world_importers: CountryValue[];
    india_destinations: CountryValue[];
    india_sources: CountryValue[];
  };
  standards: { india: WfStandard[]; export_markets: WfStandard[]; federation: WfStandard[]; qco_schemes: { id: string; name: string; url: string | null; hs_prefix: string }[] };
  markets: WfMarket[];
  watch_outs: WatchOut[];
  method: { margin: string; tax: string };
}

export interface WorkflowChain {
  id: string;
  name: string;
  title: string;
  products: { hs_code: string; name: string }[];
}

export function useWorkflowChains() {
  return useQuery({
    queryKey: ['workflow', 'chains'],
    queryFn: ({ signal }) => apiGet<WorkflowChain[]>('/api/workflow', undefined, { signal }),
    staleTime: 30 * 60_000,
  });
}

export function useWorkflow(chainId: string, product: string | null) {
  return useQuery({
    queryKey: ['workflow', chainId, product],
    queryFn: ({ signal }) =>
      apiGet<Workflow>(`/api/workflow/${encodeURIComponent(chainId)}`, product ? { product } : undefined, { signal }),
    enabled: Boolean(chainId),
    placeholderData: (prev) => prev,
  });
}
