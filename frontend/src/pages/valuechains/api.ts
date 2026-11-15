/**
 * Page-local React Query hooks for the value-chain pages (SPEC 6.5). The chain list itself uses the
 * shared `useValueChains()` hook from src/api/hooks.ts.
 *
 *   const detail = useValueChainDetail(id);   // GET /api/valuechains/{id}
 *   const mapping = useValueChainMapping(id); // GET /api/valuechains/{id}/mapping (all stages; tabs filter locally)
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

/** GET /api/valuechains/{id} - the sector deep-dive. */
export function useValueChainDetail(id: string) {
  return useQuery({
    queryKey: ['valuechains', 'detail', id],
    queryFn: ({ signal }) => api.valueChain(id, { signal }),
    enabled: Boolean(id),
  });
}

/**
 * GET /api/valuechains/{id}/mapping - the ministry-wise mapping table. All stages are fetched once so the
 * stage tabs (from `?stage=`) can switch without a round trip and always know every stage.
 */
export function useValueChainMapping(id: string) {
  return useQuery({
    queryKey: ['valuechains', 'mapping', id],
    queryFn: ({ signal }) => api.valueChainMapping(id, null, { signal }),
    enabled: Boolean(id),
  });
}

/**
 * GET /api/valuechains/{id}/tiers - the chain's supplier tiers (how deep the supply chain runs).
 * Fetched only when the chain actually has tiers, so chains without them make no extra request.
 */
export function useValueChainTiers(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['valuechains', 'tiers', id],
    queryFn: ({ signal }) => api.valueChainTiers(id, { signal }),
    enabled: Boolean(id) && enabled,
    staleTime: 10 * 60_000,
  });
}
