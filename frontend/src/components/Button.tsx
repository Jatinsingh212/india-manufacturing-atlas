/**
 * Button - the single button style of the Atlas. Renders a <button>, a router <Link> (`to`) or an
 * external <a> (`href`, opens in a new tab).
 *
 *   <Button variant="primary" icon={Download} onClick={...}>Download report</Button>
 *   <Button to={routes.ministry('mot')} variant="secondary">Open ministry</Button>
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { LoaderCircle, type LucideIcon } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'link' | 'navy';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: LucideIcon;
  /** Trailing icon. */
  iconRight?: LucideIcon;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  fullWidth?: boolean;
  /** Internal route: renders a router Link. */
  to?: string;
  /** External URL: renders <a target="_blank" rel="noopener noreferrer">. */
  href?: string;
  children?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[linear-gradient(135deg,#0b3aa1_0%,#1c50c7_100%)] text-white shadow-[0_1px_2px_rgba(7,24,47,0.22),0_8px_18px_-12px_rgba(11,58,161,0.7)] ring-1 ring-white/10 ring-inset hover:brightness-110',
  secondary:
    'border border-line-strong/90 bg-surface text-ink shadow-[0_1px_2px_rgba(10,28,53,0.04)] hover:border-line-strong hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-3/80 hover:text-ink',
  danger: 'bg-bad text-white shadow-sm hover:brightness-105',
  accent:
    'bg-[linear-gradient(135deg,#d60071_0%,#f02b8b_100%)] text-white shadow-[0_1px_2px_rgba(214,0,113,0.28),0_8px_18px_-12px_rgba(214,0,113,0.7)] ring-1 ring-white/10 ring-inset hover:brightness-105',
  link: 'text-brand-ink hover:underline underline-offset-2 px-0! h-auto!',
  navy: 'border border-white/15 bg-white/8 text-on-navy backdrop-blur hover:bg-white/14',
};

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-7 px-2 text-xs gap-1 rounded-lg',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-4 text-sm gap-2 rounded-[10px]',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-xl',
};

const ICON_SIZES: Record<ButtonSize, string> = { xs: 'size-3.5', sm: 'size-4', md: 'size-4', lg: 'size-5' };

/** Class string for button-like elements (exported for custom anchors). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string): string {
  return clsx(
    'inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-[background-color,color,border-color,box-shadow,transform,filter] duration-150 select-none active:translate-y-px',
    'disabled:opacity-50 disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:pointer-events-none',
    SIZES[size],
    VARIANTS[variant],
    extra,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, iconRight: IconRight, loading, fullWidth, to, href, className, children, disabled, type, ...rest },
  ref,
) {
  const cls = buttonClass(variant, size, clsx(fullWidth && 'w-full', className));
  const iconCls = ICON_SIZES[size];
  const content = (
    <>
      {loading ? <LoaderCircle className={clsx(iconCls, 'animate-spin')} aria-hidden /> : Icon ? <Icon className={iconCls} aria-hidden /> : null}
      {children}
      {IconRight && !loading ? <IconRight className={iconCls} aria-hidden /> : null}
    </>
  );
  if (to && !disabled) {
    return (
      <Link to={to} className={cls} title={rest.title} aria-label={rest['aria-label']}>
        {content}
      </Link>
    );
  }
  if (href && !disabled) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls} title={rest.title} aria-label={rest['aria-label']}>
        {content}
      </a>
    );
  }
  return (
    <button ref={ref} type={type ?? 'button'} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {content}
    </button>
  );
});

/** Square icon-only button with an accessible label. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, 'children' | 'iconRight' | 'icon'> & { icon: LucideIcon; label: string }
>(function IconButton({ icon: Icon, label, size = 'md', variant = 'ghost', className, ...rest }, ref) {
  const dims = { xs: 'size-7 px-0!', sm: 'size-8 px-0!', md: 'size-9 px-0!', lg: 'size-11 px-0!' }[size];
  return (
    <Button ref={ref} variant={variant} size={size} className={clsx(dims, className)} aria-label={label} title={label} {...rest}>
      <Icon className={ICON_SIZES[size]} aria-hidden />
    </Button>
  );
});
