/**
 * PageHeader - title block at the top of every page: optional breadcrumbs, eyebrow, icon, title,
 * subtitle, meta row (badges / provenance) and right-aligned actions. Also sets document.title.
 *
 *   <PageHeader eyebrow="Ministry dashboard" title="Ministry of Textiles" icon={Landmark}
 *     breadcrumbs={[{ label: 'Ministries', to: '/ministries' }, { label: 'MoT' }]}
 *     actions={<DownloadMenu kind="ministry" id="mot" />} />
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { useDocumentTitle } from '@/lib/hooks';

export interface Crumb {
  label: ReactNode;
  to?: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  /** Plain-text title for the browser tab (defaults to `title` when it is a string). */
  documentTitle?: string;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  icon?: LucideIcon;
  /** Accent colour for the icon tile (e.g. a ministry colour). */
  iconColor?: string | null;
  breadcrumbs?: Crumb[];
  /** Row under the subtitle: badges, provenance, pills. */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, documentTitle, subtitle, eyebrow, icon: Icon, iconColor, breadcrumbs, meta, actions, className }: PageHeaderProps) {
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : null));
  return (
    <header className={clsx('mb-5 sm:mb-7', className)}>
      {breadcrumbs?.length ? (
        <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-[11.5px] text-muted sm:mb-2.5 sm:text-xs">
          {breadcrumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {i > 0 ? <ChevronRight className="size-3 opacity-60" aria-hidden /> : null}
              {c.to ? (
                <Link to={c.to} className="hover:text-ink hover:underline">
                  {c.label}
                </Link>
              ) : (
                <span className="text-ink-2" aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}>
                  {c.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-3 sm:gap-x-4">
        {Icon ? (
          <span
            className={clsx(
              'hidden size-11 shrink-0 items-center justify-center rounded-2xl text-white shadow-[0_10px_24px_-14px_rgba(11,58,161,0.7)] ring-1 ring-black/5 sm:inline-flex sm:size-12',
              !iconColor && 'bg-gradient-to-br from-brand to-[#1c50c7]',
            )}
            style={iconColor ? { backgroundColor: iconColor } : undefined}
            aria-hidden
          >
            <Icon className="size-5 sm:size-[22px]" />
          </span>
        ) : null}
        {/*
          The title block has a real flex basis (22rem) instead of flex-1's zero basis: a zero basis never
          wraps the row, so the browser used to shrink the title to a few characters per line beside a
          long actions row. Now the actions wrap under the title when both do not fit; the title still
          grows to fill its row (and may shrink below 22rem on phones thanks to min-w-0).
        */}
        <div className="min-w-0 flex-[1_1_22rem]">
          {eyebrow ? (
            <div className="mb-1.5 flex items-center gap-2 text-[10.5px] font-bold tracking-[0.15em] text-brand-ink uppercase sm:text-[11px]">
              <span className="h-px w-5 shrink-0 bg-gradient-to-r from-brand to-kpi" aria-hidden />
              <span>{eyebrow}</span>
            </div>
          ) : null}
          <h1 className="text-[23px] leading-[1.12] font-extrabold tracking-[-0.035em] text-ink sm:text-[30px]">{title}</h1>
          {subtitle ? <div className="mt-2 max-w-3xl text-[13px] leading-[1.65] text-ink-2 sm:text-[14.5px]">{subtitle}</div> : null}
          {meta ? <div className="mt-3 flex flex-wrap items-center gap-1.5 sm:gap-2">{meta}</div> : null}
        </div>
        {/* ml-auto keeps a wrapped actions row at the right edge, where it sits when it shares the title's row. */}
        {actions ? <div className="ml-auto flex max-w-full flex-wrap items-center gap-2 max-sm:ml-0 max-sm:w-full">{actions}</div> : null}
      </div>
    </header>
  );
}
