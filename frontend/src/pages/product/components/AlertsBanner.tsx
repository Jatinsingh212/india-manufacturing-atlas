/**
 * AlertsBanner - automated risk alerts for the product's HS6 subheading (import surge, export drop,
 * supplier concentration, China dependence), when the API attaches them. Severity always carries a
 * text label and an icon, never colour alone. Government users can follow through to Supply-chain Risk.
 */
import { ArrowUpRight, Siren } from 'lucide-react';
import type { Alert } from '@/api/types';
import { useAuth } from '@/auth';
import { Badge, Button, ModelEstimateTag } from '@/components';
import { fmtDate, humanize } from '@/lib/format';
import { routes } from '@/lib/routes';

const TONE = { high: 'danger', medium: 'orange', low: 'warning' } as const;

/**
 * Alert titles read "China dependence (93%): <product description>"; on the product's own page the
 * description is redundant, so only the part before the colon is shown (the full title is the tooltip).
 */
function headline(title: string): string {
  const i = title.indexOf(': ');
  return i > 0 ? title.slice(0, i) : title;
}

export function AlertsBanner({ alerts }: { alerts: Alert[] }) {
  const { isGov } = useAuth();
  if (!alerts.length) return null;
  return (
    <section aria-label="Risk alerts" className="rounded-xl border border-bad/30 bg-bad-soft p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Siren className="size-4 text-bad" aria-hidden />
        <h2 className="text-[14px] font-semibold text-ink">
          {alerts.length === 1 ? '1 risk alert' : `${alerts.length} risk alerts`} for this subheading
        </h2>
        <ModelEstimateTag method="Rule-based alerts on 2024 trade: import surge, export drop, concentration, China dependence" />
        {isGov ? (
          <Button to={routes.risk()} size="xs" variant="link" iconRight={ArrowUpRight} className="ml-auto">
            Supply-chain risk
          </Button>
        ) : null}
      </div>
      <ul className="mt-2.5 divide-y divide-bad/15">
        {alerts.map((a) => (
          <li key={a.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 py-1.5 text-[13px] sm:grid-cols-[4.5rem_minmax(0,1fr)_auto]">
            <Badge tone={TONE[a.severity] ?? 'warning'} size="xs" className="mt-0.5 justify-self-start">
              {humanize(a.severity)}
            </Badge>
            <span className="min-w-0">
              <span className="font-semibold text-ink" title={a.title}>
                {headline(a.title)}
              </span>
              {a.detail ? <span className="block leading-snug text-ink-2">{a.detail}</span> : null}
            </span>
            <span className="col-start-2 text-[11px] whitespace-nowrap text-muted sm:col-start-auto sm:text-right">
              {humanize(a.kind)} · {fmtDate(a.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
