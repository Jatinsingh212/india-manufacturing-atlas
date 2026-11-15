/**
 * ErrorState - renders any thrown error. ApiError-aware:
 * - 401 / 403  -> sign-in prompt with demo-login buttons (roles from `roles`, default government users)
 * - 404        -> "Not found" with the API detail
 * - 0          -> "API unreachable"
 * - others     -> message + Retry
 *
 *   if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { CircleAlert, RefreshCw, SearchX, WifiOff } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import type { Role } from '@/api/types';
import { SignInPrompt } from '@/auth/RequireRole';
import { Button } from './Button';

export interface ErrorStateProps {
  error: unknown;
  /** Heading override (default depends on the error). */
  title?: ReactNode;
  onRetry?: () => void;
  /** Roles to offer on 401 / 403 (default 'gov'). */
  roles?: readonly Role[] | 'gov';
  compact?: boolean;
  className?: string;
}

export function ErrorState({ error, title, onRetry, roles = 'gov', compact, className }: ErrorStateProps) {
  if (isApiError(error) && error.isAuthError) {
    return <SignInPrompt roles={roles} className={className} />;
  }
  const notFound = isApiError(error) && error.isNotFound;
  const offline = isApiError(error) && error.isUnavailable;
  const Icon = notFound ? SearchX : offline ? WifiOff : CircleAlert;
  const heading = title ?? (notFound ? 'Not found' : offline ? 'The Atlas API is unreachable' : 'Something went wrong');
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-2 text-center', compact ? 'px-4 py-6' : 'px-6 py-12', className)} role="alert">
      <span
        className={clsx('inline-flex items-center justify-center rounded-full', compact ? 'size-9' : 'size-12', notFound ? 'bg-surface-3 text-muted' : 'bg-bad-soft text-bad')}
        aria-hidden
      >
        <Icon className={compact ? 'size-4' : 'size-5'} />
      </span>
      <div className="text-[15px] font-semibold text-ink">{heading}</div>
      <div className="max-w-md text-sm break-words text-muted">{errorMessage(error)}</div>
      {onRetry && !notFound ? (
        <Button size="sm" icon={RefreshCw} onClick={onRetry} className="mt-2">
          Retry
        </Button>
      ) : null}
    </div>
  );
}
