/**
 * React Query hooks for the Product page.
 *
 * - useProduct(hsn8)       GET /api/hsn/product/{hsn8}  (shared key queryKeys.product)
 * - useWatchlist(enabled)  GET /api/watchlist           (signed-in users only)
 * - useWatchToggle(hsn8)   POST / DELETE /api/watchlist/{hsn8}, then refreshes the watchlist
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/api/client';
import { queryKeys } from '@/api/hooks';
import { useToast } from '@/components';
import { fmtCode } from '@/lib/format';

export function useProduct(hsn8: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.product(hsn8),
    queryFn: ({ signal }) => api.product(hsn8, { signal }),
    enabled,
  });
}

export function useWatchlist(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.watchlist,
    queryFn: ({ signal }) => api.watchlist({ signal }),
    enabled,
    staleTime: 60 * 1000,
  });
}

export function useWatchToggle(hsn8: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (watching: boolean) => (watching ? api.removeFromWatchlist(hsn8) : api.addToWatchlist(hsn8)),
    onSuccess: (_data, watching) => {
      toast.success(watching ? 'Removed from your watchlist' : 'Added to your watchlist', `HSN ${fmtCode(hsn8)}`);
      void qc.invalidateQueries({ queryKey: queryKeys.watchlist });
    },
    onError: (err) => toast.error('Watchlist update failed', errorMessage(err)),
  });
}
