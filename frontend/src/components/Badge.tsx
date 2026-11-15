/**
 * Badge - small rounded label. Tones map to the semantic tokens; status tones always carry text
 * (colour is never the only signal).
 *
 *   <Badge tone="brand">PLI</Badge>  <Badge tone="danger" icon={ShieldAlert}>High</Badge>
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'danger' | 'warning' | 'orange' | 'info' | 'magenta' | 'navy' | 'outline';

export interface BadgeProps {
  tone?: BadgeTone;
  icon?: LucideIcon;
  /** A coloured dot before the text (e.g. an entity colour). */
  dot?: string;
  size?: 'xs' | 'sm' | 'md';
  title?: string;
  className?: string;
  children: ReactNode;
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-3 text-ink-2',
  brand: 'bg-brand-soft text-brand-ink',
  success: 'bg-ok-soft text-ok-ink',
  danger: 'bg-bad-soft text-bad-ink',
  warning: 'bg-warn-soft text-warn-ink',
  orange: 'bg-na-soft text-na-ink',
  info: 'bg-info-soft text-info-ink',
  magenta: 'bg-kpi-soft text-kpi',
  navy: 'bg-navy text-on-navy',
  outline: 'border border-line-strong text-ink-2',
};

const SIZES = {
  xs: 'h-[18px] px-1.5 text-[10.5px] gap-1',
  sm: 'h-5 px-2 text-[11px] gap-1',
  md: 'h-6 px-2.5 text-xs gap-1.5',
} as const;

export function Badge({ tone = 'neutral', icon: Icon, dot, size = 'sm', title, className, children }: BadgeProps) {
  return (
    <span
      title={title}
      className={clsx('inline-flex max-w-full items-center rounded-full font-semibold whitespace-nowrap ring-1 ring-inset ring-black/[0.03]', TONES[tone], SIZES[size], className)}
    >
      {dot ? <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} aria-hidden /> : null}
      {Icon ? <Icon className={size === 'md' ? 'size-3.5' : 'size-3'} aria-hidden /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
