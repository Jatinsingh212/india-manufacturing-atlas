/**
 * TradePolicyCard - the DGFT ITC-HS import / export policy of the 8-digit line.
 *
 * Values come from the public DGFT "Discover" tables (Schedule I import and Schedule II export).
 * Three states are shown explicitly:
 *   - specified       the portal publishes a policy (Free / Restricted / Prohibited / STE ...)
 *   - not_specified   the code is published but has no policy value for this direction
 *   - not_listed      the code is absent from that direction's published table
 * Duplicate portal records are preserved in the database; the latest record in portal order is shown.
 */
import { ExternalLink, FileCheck2 } from 'lucide-react';
import type { ProductTradePolicy, ProductTradePolicyDirection } from '@/api/types';
import { Badge, Card, ProvenanceBadge, SectionLabel, type BadgeTone } from '@/components';
import { fmtDate } from '@/lib/format';

function policyTone(policy: string | null): BadgeTone {
  const value = (policy ?? '').toLowerCase();
  if (value === 'free') return 'success';
  if (value === 'restricted') return 'warning';
  if (value === 'prohibited') return 'danger';
  if (value.includes('state trading')) return 'info';
  return 'brand';
}

function statusLabel(p: ProductTradePolicyDirection): string {
  if (p.status === 'not_listed') return 'Not listed';
  if (p.status === 'not_specified') return 'Not specified';
  return p.policy ?? 'Not specified';
}

function emptyState(p: ProductTradePolicyDirection): string | null {
  if (p.status === 'not_listed') return "This code is not present in DGFT's published table for this direction.";
  if (p.status === 'not_specified') return 'The code is published but DGFT gives no policy value for this direction.';
  return null;
}

function DirectionPanel({ label, p }: { label: string; p: ProductTradePolicyDirection }) {
  const empty = emptyState(p);
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-2 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>{label}</SectionLabel>
        <Badge tone={p.status === 'specified' ? policyTone(p.policy) : 'outline'} size="sm" className="ml-auto">
          {statusLabel(p)}
        </Badge>
        <ProvenanceBadge provenance={p.provenance} size="xs" />
      </div>

      {p.description ? <p className="mt-2 text-[12px] leading-snug text-ink-2">{p.description}</p> : null}

      {p.status === 'specified' ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-muted">Notification</dt>
          <dd className="min-w-0 text-ink-2">
            {p.notification_no ? <span className="font-mono">{p.notification_no}</span> : 'Not linked'}
            {p.notification_date_iso ? <span className="text-muted"> · {fmtDate(p.notification_date_iso)}</span> : null}
          </dd>
          {p.n_records > 1 ? (
            <>
              <dt className="text-muted">Records</dt>
              <dd className="text-ink-2">{p.n_records} published; latest shown</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {p.status === 'specified' ? (
        <div className="mt-2">
          <span className="text-[11px] font-medium text-muted">Condition</span>
          {p.condition ? (
            <p className="mt-0.5 whitespace-pre-line text-[12px] leading-snug text-ink-2">{p.condition}</p>
          ) : (
            <p className="mt-0.5 text-[12px] text-muted">No condition published.</p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[12px] leading-snug text-muted">{empty}</p>
      )}
    </div>
  );
}

export function TradePolicyCard({ policy }: { policy: ProductTradePolicy | null }) {
  if (!policy) return null;
  return (
    <Card
      title="DGFT trade policy"
      subtitle="ITC-HS Schedule I (import) and Schedule II (export) at 8-digit level"
      icon={FileCheck2}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <DirectionPanel label="Import policy" p={policy.import} />
        <DirectionPanel label="Export policy" p={policy.export} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line pt-2.5 text-[11px] text-muted">
        <ProvenanceBadge provenance={policy.provenance} size="xs" />
        <span>Fetched {fmtDate(policy.fetched_at)}</span>
        <a
          href={policy.source_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-brand-ink hover:underline"
        >
          Open the DGFT ITC-HS page <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted">
        Public DGFT Discover feed (no login or CAPTCHA). The Atlas keeps every published record; when the portal
        repeats a code, the latest record in portal order is shown.
      </p>
    </Card>
  );
}
