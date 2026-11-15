/**
 * EmptyState - friendly "nothing here" panel with optional action.
 *
 *   <EmptyState icon={SearchX} title="No products match" message="Try a shorter code or clear filters."
 *               action={<Button onClick={reset}>Clear filters</Button>} />
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Inbox, type LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
  /** Smaller padding for use inside table bodies / small cards. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon: Icon = Inbox, title, message, action, compact, className }: EmptyStateProps) {
  return (
    <div className={clsx('flex flex-col items-center justify-center text-center', compact ? 'gap-1.5 px-4 py-6' : 'gap-2 px-6 py-12', className)}>
      <span className={clsx('inline-flex items-center justify-center rounded-full bg-surface-3 text-muted', compact ? 'size-9' : 'size-12')} aria-hidden>
        <Icon className={compact ? 'size-4' : 'size-5'} />
      </span>
      <div className={clsx('font-semibold text-ink', compact ? 'text-sm' : 'text-[15px]')}>{title}</div>
      {message ? <div className="max-w-md text-sm text-muted">{message}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
