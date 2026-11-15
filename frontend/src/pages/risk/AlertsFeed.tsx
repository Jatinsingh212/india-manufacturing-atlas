/**
 * AlertsFeed - the early-warning feed of the risk page (GET /api/risk/alerts).
 *
 * Severity chips (All / High / Medium / Low, with counts) and a kind filter narrow the list
 * client-side. Severity always carries an icon and a label next to its reserved status colour, so it
 * is never conveyed by colour alone. Each alert links to the product (its sample 8-digit line when the
 * API sends `hsn8_sample`, else the Explorer for the HS6) and to the value-chain trace in the Network
 * page.
 *
 * `value` is the metric that triggered the rule (SPEC section 4 thresholds): the year-on-year change
 * (fraction) for import surges and export drops, the HHI for concentration, and China's import share
 * for China dependence.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { AlertTriangle, BellRing, CircleAlert, Info, Network as NetworkIcon, type LucideIcon } from 'lucide-react';
import type { Alert, AlertKind, Severity } from '@/api/types';
import { Card, CodeLink, EmptyState, ErrorState, LoadingBlock, ModelEstimateTag, Select } from '@/components';
import { fmtAgo, fmtDate, fmtNum, fmtPct, humanize } from '@/lib/format';
import { routes } from '@/lib/routes';
import { SEVERITY_COLORS } from '@/lib/theme';
import { useRiskAlerts } from './api';

const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

const SEVERITY_META: Record<Severity, { label: string; icon: LucideIcon }> = {
  high: { label: 'High', icon: CircleAlert },
  medium: { label: 'Medium', icon: AlertTriangle },
  low: { label: 'Low', icon: Info },
};

/** Plain-language names and what each alert rule means (SPEC section 4, alerts). */
export const ALERT_KINDS: Record<string, { label: string; rule: string }> = {
  import_surge: { label: 'Import surge', rule: 'Imports up 50% or more year on year (≥ $20 mn)' },
  export_drop: { label: 'Export drop', rule: 'Exports down 30% or more year on year (from ≥ $20 mn)' },
  concentration: { label: 'Source concentration', rule: 'Import sources highly concentrated (HHI ≥ 0.6, ≥ $50 mn)' },
  china_dependence: { label: 'China dependence', rule: 'China supplies 60% or more of imports (≥ $50 mn)' },
};

function kindLabel(kind: AlertKind): string {
  return ALERT_KINDS[kind]?.label ?? humanize(kind);
}

/**
 * Display the alert's triggering metric. Year-on-year changes above +900% read better as a multiple
 * ("x12 YoY") than as a percentage.
 */
function alertValue(a: Alert): string | null {
  const v = a.value;
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  switch (a.kind) {
    case 'import_surge':
    case 'export_drop':
      return v >= 9 ? `×${fmtNum(1 + v, { digits: 0 })} YoY` : `${fmtPct(v, { signed: true, digits: 0 })} YoY`;
    case 'china_dependence':
      return `${fmtPct(v, { digits: 0 })} from China`;
    case 'concentration':
      return `HHI ${fmtNum(v, { digits: 2 })}`;
    default:
      return fmtNum(v, { digits: 2 });
  }
}

/** Alert row as sent by the API (SPEC shape plus the owning ministry and a sample 8-digit line). */
type AlertRowData = Alert & { hsn8_sample?: string | null; ministry_short?: string | null };

export function SeverityChip({ severity, className }: { severity: Severity; className?: string }) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.low;
  const Icon = meta.icon;
  const color = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.low;
  return (
    <span
      className={clsx('inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-[11.5px] font-semibold', className)}
      style={{ borderColor: color, color: 'var(--atlas-ink)' }}
    >
      <Icon className="size-3.5" style={{ color }} aria-hidden />
      {meta.label}
    </span>
  );
}

function AlertRow({ a }: { a: AlertRowData }) {
  const value = alertValue(a);
  return (
    <li className="flex gap-3 border-t border-line px-1 py-3 first:border-t-0">
      <span className="mt-1 h-auto w-1 shrink-0 rounded-full" style={{ backgroundColor: SEVERITY_COLORS[a.severity] ?? SEVERITY_COLORS.low }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityChip severity={a.severity} />
          <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">{kindLabel(a.kind)}</span>
          {value ? <span className="text-[12px] font-semibold text-ink atlas-num">{value}</span> : null}
          <span className="ml-auto text-[11.5px] text-muted" title={fmtDate(a.created_at, { withTime: true })}>
            {fmtAgo(a.created_at)}
          </span>
        </div>
        <div className="mt-1 text-[13.5px] font-semibold text-ink">{a.title}</div>
        {a.detail ? <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{a.detail}</p> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
          <CodeLink code={a.hs6} label={a.description} to={a.hsn8_sample ? routes.product(a.hsn8_sample) : undefined} className="max-w-full" />
          {a.ministry_short ? <span className="text-[11.5px] text-muted">{a.ministry_short}</span> : null}
          <Link to={routes.network({ center: a.hs6, depth: 2 })} className="inline-flex items-center gap-1 text-brand-ink hover:underline">
            <NetworkIcon className="size-3.5" aria-hidden />
            Trace in network
          </Link>
        </div>
      </div>
    </li>
  );
}

export function AlertsFeed({ className, fallback }: { className?: string; fallback?: ReadonlyArray<Alert> }) {
  const q = useRiskAlerts();
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [kind, setKind] = useState<string>('');
  // If the full feed cannot be loaded, fall back to the latest alerts embedded in the risk overview.
  const usingFallback = q.isError && Boolean(fallback?.length);
  const all = useMemo<Alert[]>(() => q.data ?? (usingFallback ? [...(fallback ?? [])] : []), [q.data, usingFallback, fallback]);

  const kinds = useMemo(() => [...new Set(all.map((a) => a.kind))], [all]);
  const byKind = useMemo(() => (kind ? all.filter((a) => a.kind === kind) : all), [all, kind]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: byKind.length };
    for (const s of SEVERITIES) c[s] = byKind.filter((a) => a.severity === s).length;
    return c;
  }, [byKind]);
  const shown = useMemo(
    () =>
      (severity === 'all' ? byKind : byKind.filter((a) => a.severity === severity)).slice().sort((a, b) => {
        const rank = (s: Severity) => SEVERITIES.indexOf(s);
        return rank(a.severity) - rank(b.severity) || String(b.created_at).localeCompare(String(a.created_at));
      }),
    [byKind, severity],
  );
  const [limit, setLimit] = useState(6);

  return (
    <Card
      title="Early-warning alerts"
      subtitle="Generated automatically from the latest trade data each time the database is rebuilt or refreshed"
      icon={BellRing}
      className={className}
      actions={<ModelEstimateTag method="Rule-based alert thresholds (SPEC section 4)" />}
      footer={
        <div className="space-y-0.5">
          {Object.entries(ALERT_KINDS).map(([k, v]) => (
            <div key={k}>
              <span className="font-medium text-ink-2">{v.label}:</span> {v.rule}
            </div>
          ))}
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Severity">
          {(['all', ...SEVERITIES] as const).map((s) => {
            const on = severity === s;
            // The alert rules only emit high / medium today: hide a severity with no alerts unless selected.
            if (s !== 'all' && !on && !(counts[s] ?? 0)) return null;
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setSeverity(s);
                  setLimit(6);
                }}
                className={clsx(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors',
                  on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink',
                )}
              >
                {s !== 'all' ? <span className="size-2 rounded-full" style={{ backgroundColor: SEVERITY_COLORS[s] }} aria-hidden /> : null}
                {s === 'all' ? 'All' : SEVERITY_META[s].label}
                <span className="text-muted atlas-num">{fmtNum(counts[s] ?? 0)}</span>
              </button>
            );
          })}
        </div>
        <Select
          size="sm"
          className="ml-auto w-52"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setLimit(6);
          }}
          options={kinds.map((k) => ({ value: k, label: kindLabel(k) }))}
          placeholder="All alert types"
          aria-label="Alert type"
        />
      </div>

      {usingFallback ? <div className="mb-1 text-[12px] text-muted">Showing the latest {fmtNum(all.length)} alerts from the risk overview; the full feed is unavailable.</div> : null}
      {q.isPending ? (
        <LoadingBlock label="Loading alerts…" />
      ) : q.isError && !usingFallback ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : !shown.length ? (
        <EmptyState compact icon={BellRing} title="No alerts match" message={all.length ? 'Try another severity or alert type.' : 'No alert thresholds are breached in the latest data.'} />
      ) : (
        <>
          <ul className="max-h-[640px] overflow-y-auto pr-1 xl:max-h-[940px]">
            {shown.slice(0, limit).map((a) => (
              <AlertRow key={a.id} a={a} />
            ))}
          </ul>
          {shown.length > limit ? (
            <div className="pt-2 text-center">
              <button type="button" className="text-[13px] font-medium text-brand-ink hover:underline" onClick={() => setLimit((l) => l + 25)}>
                Show more ({fmtNum(shown.length - limit)} remaining)
              </button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
