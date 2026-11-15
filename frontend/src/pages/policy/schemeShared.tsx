/**
 * Pieces shared by the two scheme tabs of the Policy Workbench - "PLI targeting" (SchemesTab.tsx)
 * and "Quality control" (QualityControlTab.tsx) - both built on GET /api/policy/schemes?kind= and
 * GET /api/policy/schemes/{id}.
 *
 * - shortSchemeName / fmtCrore / sourceStatus   display helpers for seeded scheme facts
 * - distinctHs6(products)                       one row per HS6 (trade values are HS6-level and repeat
 *                                               for every 8-digit line of a subheading, SPEC section 4)
 * - <SchemeHeader scheme />                     title card with ministry, launch year, description,
 *                                               official link and the provenance of the scheme facts
 * - <SchemeList schemes selected onSelect />    selectable list of schemes
 * - <CoveredTradeChart products />              top covered HS6 products, imports vs exports
 *
 * Scheme facts (outlay, launch year) are compiled from public GoI sources by the policy seed and flagged
 * "verify before official use"; HS coverage is an indicative prefix list, not the legal product
 * schedule. Both are shown with a Not-verified badge.
 */
import { useMemo } from 'react';
import clsx from 'clsx';
import { ExternalLink } from 'lucide-react';
import type { DependencyHotspot, ProductSummary, SchemeListItem } from '@/api/types';
import { Badge, Button, Card, EChart, EmptyState, MinistryPill, ProvenanceBadge } from '@/components';
import { fmtCode, fmtNum } from '@/lib/format';
import { CATEGORICAL } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { groupedHBarOption } from '../analytics/shared/chart';

/** Short display name: drops the "PLI Scheme for" prefix and the "(Quality Control) Order, 2020" suffix. */
export function shortSchemeName(name: string): string {
  const s = name
    .replace(/^PLI Scheme( \d\.\d)? for (the )?/i, '')
    .replace(/^(National Programme on|promoting domestic manufacturing of|critical) /i, '')
    .replace(/\s*\(Quality Control\) Order(, \d{4})?$/i, '')
    .replace(/\s*\(Quality Control Order.*\)$/i, '')
    .replace(/\s+Quality Control Orders?\b.*$/i, '')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name;
}

/** "₹40,951 crore" (Indian digit grouping); null when not available. */
export function fmtCrore(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return `₹${Math.round(v).toLocaleString('en-IN')} crore`;
}

/** Source text of seeded policy facts; anything asking for verification is shown as Not verified. */
export function sourceStatus(source: string | null | undefined): 'verified' | 'not_verified' {
  if (!source) return 'not_verified';
  return /verify|indicative|approx|compiled/i.test(source) ? 'not_verified' : 'verified';
}

/**
 * Readable main import source of a dependency row. SPEC types `top_import_source` as a string; the API
 * sends the country id there ("aschn") and the display name in `top_import_source_name`.
 */
export function importSourceName(r: Pick<DependencyHotspot, 'top_import_source'> & { top_import_source_name?: string | null }): string | null {
  return r.top_import_source_name ?? r.top_import_source ?? null;
}

/** One product per HS6 (the first line of each subheading), so HS6-level trade is never double counted. */
export function distinctHs6<T extends Pick<ProductSummary, 'hs6'>>(products: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const p of products) if (!seen.has(p.hs6)) seen.set(p.hs6, p);
  return [...seen.values()];
}

/** Title card of a scheme: kind, ministry, launch year, description, official page and data status. */
export function SchemeHeader({ scheme: s }: { scheme: SchemeListItem }) {
  const status = sourceStatus(s.source);
  return (
    <Card padding="lg">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={s.kind === 'PLI' ? 'brand' : 'info'}>{s.kind === 'PLI' ? 'Production Linked Incentive' : 'Quality Control Order'}</Badge>
            {s.ministry ? <MinistryPill ministry={s.ministry} /> : null}
            {s.launched ? <span className="text-xs text-muted">{s.kind === 'QCO' ? 'Notified' : 'Launched'} {s.launched}</span> : null}
          </div>
          <h3 className="mt-2 text-[17px] leading-snug font-bold text-ink">{s.name}</h3>
          {s.description ? <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-ink-2">{s.description}</p> : null}
        </div>
        {s.url ? (
          <Button href={s.url} size="sm" icon={ExternalLink}>
            Official page
          </Button>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <ProvenanceBadge status={status} size="xs" />
        <span>{s.source ?? 'Source not recorded'}</span>
        <span aria-hidden>·</span>
        <span>HS coverage is an indicative prefix list, not the legal product schedule.</span>
      </div>
    </Card>
  );
}

/** Selectable list of schemes (listbox semantics, keyboard reachable buttons). */
export function SchemeList({
  schemes,
  selected,
  onSelect,
  meta,
}: {
  schemes: SchemeListItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Extra line content per scheme (e.g. outlay or imports covered). */
  meta?: (s: SchemeListItem) => string | null;
}) {
  return (
    <div className="flex flex-col gap-2" role="listbox" aria-label="Schemes">
      {schemes.map((s) => {
        const on = s.id === selected;
        const extra = meta?.(s);
        return (
          <button
            key={s.id}
            type="button"
            role="option"
            aria-selected={on}
            onClick={() => onSelect(s.id)}
            className={clsx(
              'rounded-lg border px-3 py-2.5 text-left transition-colors',
              on ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2',
            )}
          >
            <div className="text-[13px] leading-snug font-semibold text-ink">{shortSchemeName(s.name)}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
              {s.ministry ? <MinistryPill ministry={s.ministry} size="xs" link={false} /> : null}
              {extra ? <span className="atlas-num">{extra}</span> : null}
              {s.launched ? <span>since {s.launched}</span> : null}
              <span className="atlas-num">{fmtNum(s.n_products)} lines</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Top covered HS6 products by India's trade: imports against exports on one US$ axis (or imports
 * only, for the QCO view where the import side is the subject).
 */
export function CoveredTradeChart({
  products,
  title,
  subtitle,
  importsOnly = false,
  limit = 10,
}: {
  products: readonly ProductSummary[];
  title: string;
  subtitle: string;
  importsOnly?: boolean;
  limit?: number;
}) {
  const { mode } = useTheme();
  const top = useMemo(() => {
    const rows = distinctHs6(products).filter((p) => (importsOnly ? (p.imports ?? 0) > 0 : (p.imports ?? 0) + (p.exports ?? 0) > 0));
    const key = (p: ProductSummary) => (importsOnly ? (p.imports ?? 0) : (p.imports ?? 0) + (p.exports ?? 0));
    return rows.sort((a, b) => key(b) - key(a)).slice(0, limit);
  }, [products, importsOnly, limit]);
  const option = useMemo(
    () =>
      groupedHBarOption({
        categories: top.map((p) => `${fmtCode(p.hs6)} ${p.description}`),
        fullLabels: top.map((p) => `HS ${fmtCode(p.hs6)} · ${p.description}`),
        series: importsOnly
          ? [{ name: 'India imports', values: top.map((p) => p.imports), color: CATEGORICAL[mode][1] }]
          : [
              { name: 'India imports', values: top.map((p) => p.imports), color: CATEGORICAL[mode][1] },
              { name: 'India exports', values: top.map((p) => p.exports), color: CATEGORICAL[mode][0] },
            ],
        labelMax: 30,
      }),
    [top, importsOnly, mode],
  );
  return (
    <Card title={title} subtitle={subtitle}>
      {top.length ? (
        <EChart option={option} height={Math.max(220, top.length * (importsOnly ? 30 : 40) + 40)} ariaLabel={title} />
      ) : (
        <EmptyState compact title="No trade recorded for the covered products" />
      )}
    </Card>
  );
}
