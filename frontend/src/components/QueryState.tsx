/**
 * QueryState - one-liner for the loading / error / empty / data states of a React Query result.
 *
 *   const q = useQuery({ queryKey: ['ministry', id], queryFn: ({ signal }) => api.ministry(id, { signal }) });
 *   <QueryState query={q} isEmpty={(d) => d.top_exports.length === 0} emptyTitle="No products yet">
 *     {(data) => <MinistryBody data={data} />}
 *   </QueryState>
 *
 * While a background refetch runs the previous data stays visible (dimmed), so layouts never jump.
 */
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { Role } from '@/api/types';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { LoadingBlock } from './Loading';

export interface QueryStateProps<T> {
  query: Pick<UseQueryResult<T, unknown>, 'data' | 'error' | 'isPending' | 'isError' | 'isFetching' | 'fetchStatus' | 'refetch'>;
  children: (data: T) => ReactNode;
  /** Return true when the data should show the empty state. */
  isEmpty?: (data: T) => boolean;
  emptyTitle?: ReactNode;
  emptyMessage?: ReactNode;
  emptyIcon?: LucideIcon;
  /** Rendered while the query is disabled (`enabled: false`) and has no data (default nothing). */
  idle?: ReactNode;
  /** Custom loading node (default LoadingBlock). */
  loading?: ReactNode;
  loadingLabel?: string;
  /** Minimum height of the loading block. */
  height?: number;
  /** Roles offered by the sign-in prompt on 401 / 403. */
  roles?: readonly Role[] | 'gov';
  compact?: boolean;
  className?: string;
}

export function QueryState<T>({
  query,
  children,
  isEmpty,
  emptyTitle = 'No data available',
  emptyMessage,
  emptyIcon,
  idle = null,
  loading,
  loadingLabel,
  height,
  roles,
  compact,
  className,
}: QueryStateProps<T>) {
  if (query.isPending && query.fetchStatus === 'idle') return <>{idle}</>;
  if (query.isPending) return <>{loading ?? <LoadingBlock label={loadingLabel} height={height} className={className} />}</>;
  if (query.isError && query.data === undefined) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} roles={roles} compact={compact} className={className} />;
  }
  const data = query.data as T;
  if (isEmpty?.(data)) return <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} compact={compact} className={className} />;
  return <div className={clsx('transition-opacity', query.isFetching && 'opacity-60', className)}>{children(data)}</div>;
}
