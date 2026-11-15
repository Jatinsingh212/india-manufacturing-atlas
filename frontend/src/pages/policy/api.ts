/**
 * React Query hooks for the Policy Workbench (SPEC section 6.7).
 * Public: use cases, schemes, agreements, skilling. GOV_ROLES: negotiation, tariff simulation.
 */
import { keepPreviousData, useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { api, normalizeCode } from '@/api/client';
import { queryKeys } from '@/api/hooks';
import type { LookupResponse, NegotiationParams, SimulateTariffRequest, SimulateTariffResponse, SimulationResultRow, SkillingParams } from '@/api/types';

/** GET /api/policy/use-cases */
export function useUseCases() {
  return useQuery({ queryKey: ['policy', 'use-cases'], queryFn: ({ signal }) => api.useCases({ signal }), staleTime: 60 * 60 * 1000 });
}

/** GET /api/policy/schemes?kind= (shared key with api/hooks queryKeys.schemes). */
export function useSchemes(kind: 'PLI' | 'QCO') {
  return useQuery({ queryKey: queryKeys.schemes(kind), queryFn: ({ signal }) => api.schemes(kind, { signal }), staleTime: 60 * 60 * 1000 });
}

/** GET /api/policy/schemes/{id} */
export function useScheme(id: string | null) {
  return useQuery({
    queryKey: ['policy', 'scheme', id],
    queryFn: ({ signal }) => api.scheme(id as string, { signal }),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

/** GET /api/policy/negotiation?partner=|agreement= (GOV). */
export function useNegotiation(params: NegotiationParams) {
  return useQuery({
    queryKey: ['policy', 'negotiation', params],
    queryFn: ({ signal }) => api.negotiation(params, { signal }),
    enabled: Boolean(params.partner || params.agreement),
    placeholderData: keepPreviousData,
  });
}

/** GET /api/policy/skilling?chain_id=|sector_id= */
export function useSkilling(params: SkillingParams) {
  return useQuery({
    queryKey: ['policy', 'skilling', params],
    queryFn: ({ signal }) => api.skilling(params, { signal }),
    placeholderData: keepPreviousData,
  });
}

/**
 * Request body of the simulator: SPEC fields plus the optional `base_tariff_pct` the API accepts to
 * simulate codes whose current tariff is not ad valorem (or to test "what if today's rate were ...").
 */
export type SimulateRequest = SimulateTariffRequest & { base_tariff_pct?: number };

/** Result row as sent by the API (SPEC shape plus the tariff basis and an explanatory note). */
export type SimRow = SimulationResultRow & { tariff_source?: 'wits' | 'request' | string; note?: string | null; import_share_of_hs6?: number | null };

/**
 * Downstream row as sent by the API: SPEC shape plus the hop count, the simulated code it starts from
 * and the full `path` ("850760 -> 85171300"; `via` is only the simulated code).
 */
export type SimDownstream = SimulateTariffResponse['downstream'][number] & { hops?: number | null; from_code?: string | null; path?: string | null };

/** Simulator response with the API's optional extras. */
export type SimResponse = Omit<SimulateTariffResponse, 'results' | 'downstream'> & {
  results: SimRow[];
  downstream: SimDownstream[];
  unknown_codes?: string[];
  assumptions: SimulateTariffResponse['assumptions'] & { tariff_basis?: string; import_basis?: string; base_tariff_pct?: number | null };
};

/** POST /api/policy/simulate-tariff (GOV). */
export function useSimulateTariff() {
  return useMutation({ mutationFn: (body: SimulateRequest) => api.simulateTariff(body) as Promise<SimResponse> });
}

/** Current tariff and label of one picked code, read from the HSN lookup. */
export interface CodeInfo {
  code: string;
  description: string | null;
  /** MFN applied rate, percent: the line's HS6 simple average, or the mean over a heading's subheadings. */
  mfn: number | null;
  /** Lowest and highest MFN rate across the subheadings of a 4/6-digit code (null for a single rate). */
  mfnRange: [number, number] | null;
  /** Display BCD (WITS MFN average, e.g. "20%"). */
  bcd: string | null;
  /** 'line' for an 8-digit tariff line, else the HS level of the node. */
  level: 'line' | 'subheading' | 'heading' | 'chapter';
}

function codeInfo(code: string, r: LookupResponse): CodeInfo {
  if (r.type === 'product') {
    const p = r.product;
    return { code, description: p.description, mfn: p.tariff?.mfn_avg ?? p.mfn_tariff, mfnRange: null, bcd: p.tariff?.bcd_display ?? p.bcd_display, level: 'line' };
  }
  // A node lists up to 50 of its lines; tariffs are HS6-level, so take one rate per subheading.
  const perHs6 = new Map<string, number>();
  for (const p of r.products) if (typeof p.mfn_tariff === 'number' && !perHs6.has(p.hs6)) perHs6.set(p.hs6, p.mfn_tariff);
  const rates = [...perHs6.values()];
  const mfn = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  const lo = rates.length ? Math.min(...rates) : null;
  const hi = rates.length ? Math.max(...rates) : null;
  const level = code.length === 6 ? 'subheading' : code.length === 4 ? 'heading' : 'chapter';
  return { code, description: r.node.description, mfn, mfnRange: lo !== null && hi !== null && hi > lo ? [lo, hi] : null, bcd: null, level };
}

/** Lookups for every picked code (GET /api/hsn/lookup/{code}), in the order given. */
export function useCodeInfos(codes: readonly string[]) {
  return useQueries({
    queries: codes.map((c) => ({
      queryKey: ['hsn', 'lookup', normalizeCode(c)],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.lookup(c, { signal }),
      staleTime: 10 * 60 * 1000,
      select: (r: LookupResponse) => codeInfo(normalizeCode(c), r),
    })),
  });
}
