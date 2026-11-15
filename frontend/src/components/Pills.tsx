/**
 * Entity pills and code links.
 *
 * - <MinistryPill ministry={{ id, short_name, name, color }} />   coloured dot + short name, links to /ministry/:id
 * - <SectorPill sector={{ id, name, color }} />                    links to /sector/:id
 * - <CodeLink code="40111010" />                                  mono code, links to the right page
 * - <ArchetypeBadge archetype="Champion" />
 *
 * Entity colours follow data/curated (ministries.json / sectors.json) so they are stable everywhere.
 */
import { Link } from 'react-router';
import clsx from 'clsx';
import type { Archetype } from '@/api/types';
import { fmtCode } from '@/lib/format';
import { routeForCode, routes } from '@/lib/routes';
import { archetypeColor, ministryColor, sectorColor } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { Tooltip } from './Tooltip';

export interface MinistryLike {
  id: string;
  short_name?: string | null;
  name?: string | null;
  color?: string | null;
}

export interface MinistryPillProps {
  ministry: MinistryLike | null | undefined;
  /** Link to the ministry dashboard (default true). */
  link?: boolean;
  /** Show the full name instead of the short name. */
  full?: boolean;
  /** Extra label after the name, e.g. "secondary". */
  role?: string | null;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

const PILL_SIZE = {
  xs: 'h-[18px] px-1.5 text-[10.5px] gap-1',
  sm: 'h-[22px] px-2 text-[11.5px] gap-1.5',
  md: 'h-7 px-2.5 text-[13px] gap-1.5',
} as const;

export function MinistryPill({ ministry, link = true, full, role, size = 'sm', className }: MinistryPillProps) {
  if (!ministry) return <span className="text-xs text-muted">Not available</span>;
  const label = full ? (ministry.name ?? ministry.short_name ?? ministry.id) : (ministry.short_name ?? ministry.name ?? ministry.id);
  const residual = ministry.id === 'residual';
  const cls = clsx(
    'inline-flex max-w-full items-center rounded-full border font-medium whitespace-nowrap',
    residual ? 'border-dashed border-line-strong bg-surface-2 text-ink-2' : 'border-line bg-surface text-ink',
    link && 'transition-colors hover:border-brand/50 hover:bg-brand-soft',
    PILL_SIZE[size],
    className,
  );
  const inner = (
    <>
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: ministryColor(ministry.id, ministry.color) }} aria-hidden />
      <span className="truncate">{label}</span>
      {role && role !== 'primary' ? <span className="font-normal text-muted">· {role}</span> : null}
    </>
  );
  const tip = !full && ministry.name && ministry.name !== label ? ministry.name : null;
  const node = link ? (
    <Link to={routes.ministry(ministry.id)} className={cls}>
      {inner}
    </Link>
  ) : (
    <span className={cls}>{inner}</span>
  );
  return tip ? <Tooltip content={tip}>{node}</Tooltip> : node;
}

export interface SectorLike {
  id: string;
  name?: string | null;
  color?: string | null;
}

export function SectorPill({
  sector,
  link = true,
  size = 'sm',
  className,
}: {
  sector: SectorLike | null | undefined;
  link?: boolean;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  if (!sector || !sector.id) return <span className="text-xs text-muted">Not available</span>;
  const cls = clsx(
    'inline-flex max-w-full items-center rounded-md border border-line bg-surface-2 font-medium whitespace-nowrap text-ink-2',
    link && 'transition-colors hover:border-brand/50 hover:text-ink',
    PILL_SIZE[size],
    className,
  );
  const inner = (
    <>
      <span className="size-2 shrink-0 rounded-[3px]" style={{ backgroundColor: sectorColor(sector.id, sector.color) }} aria-hidden />
      <span className="truncate">{sector.name ?? sector.id}</span>
    </>
  );
  return link ? (
    <Link to={routes.sector(sector.id)} className={cls}>
      {inner}
    </Link>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

export interface CodeLinkProps {
  code: string | null | undefined;
  /** Optional description shown after the code. */
  label?: string | null;
  /** 'dotted' (default, 4011.10.10) or 'plain'. */
  style?: 'dotted' | 'plain';
  /** Override the destination. */
  to?: string;
  /** Render as text without a link. */
  noLink?: boolean;
  className?: string;
}

/** HS code in monospace; 8-digit lines link to the product page, shorter codes to the Explorer. */
export function CodeLink({ code, label, style = 'dotted', to, noLink, className }: CodeLinkProps) {
  if (!code) return <span className="text-xs text-muted">Not available</span>;
  const text = fmtCode(code, style);
  const dest = to ?? routeForCode(code);
  const codeEl = <span className="font-mono text-[12.5px] tracking-tight atlas-num">{text}</span>;
  if (noLink || !dest) {
    return (
      <span className={clsx('inline-flex items-baseline gap-2', className)}>
        {codeEl}
        {label ? <span className="text-ink-2">{label}</span> : null}
      </span>
    );
  }
  return (
    <Link to={dest} className={clsx('group inline-flex max-w-full items-baseline gap-2 text-brand-ink', className)} title={label ?? undefined}>
      <span className="group-hover:underline">{codeEl}</span>
      {label ? <span className="truncate text-ink group-hover:underline">{label}</span> : null}
    </Link>
  );
}

const ARCHETYPE_HINT: Record<Archetype, string> = {
  Champion: 'RCA >= 1 and exports growing at least as fast as world trade',
  Established: 'RCA >= 1 (revealed comparative advantage)',
  Emerging: '0.3 <= RCA < 1 with exports outgrowing world trade',
  Dependent: 'Imports at least twice exports and >= $50 mn',
  Marginal: 'None of the above',
};

/** Product archetype (rule-based, SPEC section 4) with its rule in the tooltip. */
export function ArchetypeBadge({ archetype, className }: { archetype: Archetype | string | null | undefined; className?: string }) {
  const { mode } = useTheme();
  if (!archetype) return <span className="text-xs text-muted">Not available</span>;
  const color = archetypeColor(archetype, mode);
  const hint = ARCHETYPE_HINT[archetype as Archetype];
  return (
    <Tooltip content={hint ? `${archetype}: ${hint} (model estimate)` : archetype}>
      <span className={clsx('inline-flex h-[22px] items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-[11.5px] font-medium whitespace-nowrap text-ink', className)}>
        <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        {archetype}
      </span>
    </Tooltip>
  );
}
