/**
 * The Atlas brand mark (royal blue tile, rising bars, magenta node) and wordmark.
 */
import clsx from 'clsx';

export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={clsx('shrink-0', className)} aria-hidden>
      <rect width="64" height="64" rx="14" fill="#0b3aa1" />
      <g fill="none" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 46V32" />
        <path d="M28 46V22" />
        <path d="M39 46V35" />
      </g>
      <path d="M39 35l8-13" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
      <circle cx="47" cy="21" r="6.5" fill="#d60071" />
    </svg>
  );
}

export function BrandWordmark({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <span className={clsx('flex min-w-0 items-center gap-2.5', className)}>
      <BrandMark size={32} />
      {!collapsed ? (
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[14px] font-bold tracking-tight text-white">India Manufacturing Atlas</span>
          <span className="block truncate text-[11px] text-on-navy-muted">HSN intelligence platform</span>
        </span>
      ) : null}
    </span>
  );
}
