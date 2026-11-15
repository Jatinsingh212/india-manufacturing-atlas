/**
 * React Query hooks for Supply-chain Risk & Early Warning (SPEC section 6.8, GOV_ROLES).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { AnalyticsFilters } from '@/api/types';

/** GET /api/risk/overview (KPIs, top vulnerable, by sector / source country, latest alerts). */
export function useRiskOverview(f: AnalyticsFilters) {
  return useQuery({
    queryKey: ['risk', 'overview', f],
    queryFn: ({ signal }) => api.riskOverview(f, { signal }),
    placeholderData: keepPreviousData,
  });
}

/** Upper bound of GET /api/risk/alerts?limit= (the API caps it at 2000; a full build has ~850 alerts). */
const ALERT_FEED_LIMIT = 2000;

/** GET /api/risk/alerts - the full feed (filtered client-side so the chips can show counts). */
export function useRiskAlerts() {
  return useQuery({
    queryKey: ['risk', 'alerts', 'all'],
    queryFn: ({ signal }) => api.riskAlerts({ limit: ALERT_FEED_LIMIT }, { signal }),
  });
}
