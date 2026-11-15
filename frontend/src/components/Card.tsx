/**
 * Card - the white content card of the Atlas (dark surface in dark mode).
 *
 *   <Card title="HS code distribution by ministry" subtitle="Live mapping, 2024" icon={ChartColumn}
 *         actions={<Toggle ... />} footer={<ProvenanceBadge ... />}>
 *     ...
 *   </Card>
 *
 * `padding="none"` for edge-to-edge tables; `tone="navy"` for the dark panels.
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  /** Right-aligned header content (buttons, toggles, DownloadMenu). */
  actions?: ReactNode;
  /** Extra classes for the actions wrapper (e.g. stack controls under the title on phones). */
  actionsClassName?: string;
  footer?: ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  tone?: 'default' | 'navy' | 'subtle';
  /** Anchor id (deep links). */
  id?: string;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

const PAD = { none: '', sm: 'p-3', md: 'p-4 sm:p-5', lg: 'p-5 sm:p-6' } as const;
const HEAD_PAD = { none: 'px-4 pt-4 sm:px-5', sm: 'px-3 pt-3', md: 'px-4 pt-4 sm:px-5 sm:pt-5', lg: 'px-5 pt-5 sm:px-6 sm:pt-6' } as const;

export function Card({ title, subtitle, icon: Icon, actions, actionsClassName, footer, padding = 'md', tone = 'default', id, className, bodyClassName, children }: CardProps) {
  const hasHeader = Boolean(title || subtitle || actions || Icon);
  const navy = tone === 'navy';
  return (
    <section
      id={id}
      className={clsx(
        'flex min-w-0 flex-col rounded-2xl border',
        tone === 'default' && 'border-line/90 bg-surface shadow-card',
        tone === 'subtle' && 'border-line bg-surface-2',
        navy && 'border-white/10 bg-navy text-on-navy shadow-card',
        className,
      )}
    >
      {hasHeader ? (
        <header className={clsx('flex flex-wrap items-start gap-x-3 gap-y-2', HEAD_PAD[padding], padding === 'none' && 'pb-3')}>
          {Icon ? (
            <span
              className={clsx(
                'mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-xl ring-1',
                navy
                  ? 'bg-white/10 text-on-navy ring-white/10'
                  : 'bg-gradient-to-br from-brand-soft to-surface text-brand-ink ring-brand/10',
              )}
              aria-hidden
            >
              <Icon className="size-[18px]" />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            {title ? (
              <h2 className={clsx('text-[15.5px] leading-[1.45] font-semibold tracking-[-0.015em]', navy ? 'text-white' : 'text-ink')}>{title}</h2>
            ) : null}
            {subtitle ? <div className={clsx('mt-0.5 text-[12.5px] leading-[1.55]', navy ? 'text-on-navy-muted' : 'text-muted')}>{subtitle}</div> : null}
          </div>
          {actions ? (
            <div className={clsx('flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2', actionsClassName)}>{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div className={clsx('min-w-0 flex-1', PAD[padding], hasHeader && padding !== 'none' && 'pt-3.5', bodyClassName)}>{children}</div>
      {footer ? (
        <footer className={clsx('border-t px-4 py-2.5 text-xs sm:px-5', navy ? 'border-white/10 text-on-navy-muted' : 'border-line text-muted')}>
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/** Small uppercase section label used inside cards and side panels. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-center gap-2 text-[10.5px] font-bold tracking-[0.14em] text-muted uppercase', className)}>
      <span className="h-px w-5 shrink-0 bg-gradient-to-r from-brand to-kpi" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
