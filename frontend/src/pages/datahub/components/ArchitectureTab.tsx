/**
 * Real-time update architecture. Explains the pipeline from sources to dashboards, what each
 * government connector would bring and what it needs before it can be switched on (live status from
 * GET /api/datahub/sources), and the lifecycle of one refresh job.
 */
import type { ReactNode } from 'react';
import { ArrowDown, ArrowRight, Building, Database, FileUp, Globe, KeyRound, Landmark, Plug, RefreshCw, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import type { DataSource } from '@/api/types';
import { Badge, Card, SectionLabel, Skeleton } from '@/components';
import { fmtAgo } from '@/lib/format';
import { useDataSources } from '../api';
import { describeCron, SourceStatusBadge, type SourceRow } from '../utils';

interface GovConnector {
  id: string;
  name: string;
  owner: string;
  brings: string;
  improves: string;
  needs: string[];
  env: string[];
  lands: string;
}

const GOV_CONNECTORS: GovConnector[] = [
  {
    id: 'cbic',
    name: 'CBIC Customs Tariff / ICEGATE',
    owner: 'Central Board of Indirect Taxes and Customs',
    brings: 'Basic Customs Duty, AIDC / SWS and duty notifications for every 8-digit tariff line.',
    improves: 'Gives every BCD column the line-level legal rate instead of the HS6 MFN average (WITS).',
    needs: ['An API access arrangement with CBIC / ICEGATE', 'Service credentials for the Atlas server'],
    env: ['ATLAS_CBIC_API_KEY', 'ATLAS_CBIC_API_URL'],
    lands: 'Tariff table (8-digit), product pages, tariff simulator baseline',
  },
  {
    id: 'gstn',
    name: 'GSTN HSN-wise supply data',
    owner: 'Goods and Services Tax Network',
    brings: 'Aggregated HSN-wise domestic outward supplies reported in GST returns.',
    improves: 'Gives a domestic production / consumption signal, so demand-supply gaps and self-sufficiency stop being “Not available”.',
    needs: ['A data-sharing arrangement limited to aggregated, non-taxpayer-identifiable data', 'API credentials from GSTN'],
    env: ['ATLAS_GSTN_API_KEY', 'ATLAS_GSTN_API_URL'],
    lands: 'Production table (HSN scope), demand-supply analysis, ministry dashboards',
  },
  {
    id: 'dgft',
    name: 'DGFT ITC-HS and trade data',
    owner: 'Directorate General of Foreign Trade',
    brings: 'ITC-HS import / export policy conditions (Schedules I and II) and official trade at 8-digit level.',
    improves: 'Adds policy conditions to each product and India’s own 8-digit trade next to the HS6 BACI figures.',
    needs: ['DGFT API onboarding for the Atlas', 'Service credentials'],
    env: ['ATLAS_DGFT_API_KEY', 'ATLAS_DGFT_API_URL'],
    lands: 'Product pages, trade series (8-digit), policy workbench',
  },
];

const LIVE_IDS = ['oec_baci', 'un_comtrade', 'wits_trains'];

export function ArchitectureTab() {
  const sources = useDataSources();
  const byId = new Map((sources.data ?? []).map((s) => [s.id, s]));

  return (
    <div className="space-y-6">
      <Card title="From source systems to decisions" subtitle="How data moves through the Atlas; every stage is HSN-keyed and keeps the provenance of each value" icon={Workflow}>
        <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch">
          <Stage step={1} title="Sources" icon={Globe}>
            <StageItem label="Trade databases" detail="DGCIS TRADESTAT (India, 8-digit), CEPII BACI via OEC (world) and WITS / TRAINS; UN Comtrade for the cross-check, on demand" tone="success" status="Live" />
            <StageItem label="Government systems" detail="CBIC, GSTN, DGFT" tone="orange" status="Credentials needed" />
            <StageItem label="Ministry files" detail="Official mapping, production, value-chain links" tone="info" status="Uploads" />
          </Stage>
          <Arrow />
          <Stage step={2} title="Connectors and validation" icon={Plug}>
            <StageItem label="Connector jobs" detail="Each run is a tracked job: started, finished, records, message" />
            <StageItem label="Row-level validation" detail="Uploads are checked row by row before an admin applies them" />
            <StageItem label="Audit log" detail="Who triggered or applied what, and when" />
          </Stage>
          <Arrow />
          <Stage step={3} title="HSN data lake" icon={Database}>
            <StageItem label="One key" detail="8-digit HSN line and its HS6, with leading zeros" />
            <StageItem label="Provenance" detail="Verified / Not verified / Not available on every figure" />
            <StageItem label="Cross-checks" detail="BACI compared with UN Comtrade reported values" />
          </Stage>
          <Arrow />
          <Stage step={4} title="Intelligence and delivery" icon={Sparkles}>
            <StageItem label="Recompute" detail="RCA, shares, scores, forecasts and alerts" />
            <StageItem label="Serve" detail="Dashboards, reports and the assistant" />
            <StageItem label="Controlled access" detail="Public module plus role-based government views" />
          </Stage>
        </div>
      </Card>

      <div>
        <SectionLabel className="mb-3">Government connectors to switch on</SectionLabel>
        <div className="grid gap-4 xl:grid-cols-3">
          {GOV_CONNECTORS.map((c) => (
            <GovConnectorCard key={c.id} connector={c} source={byId.get(c.id)} loading={sources.isPending} />
          ))}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="xl:col-span-7" title="Connectors running today" subtitle="Admin-triggered refresh jobs; scheduled runs are not enabled yet, so “Planned” shows the intended cadence" icon={RefreshCw}>
          {sources.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {LIVE_IDS.map((id) => byId.get(id)).filter((s): s is DataSource => Boolean(s)).map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-ink">{s.name}</div>
                    <div className="text-xs text-muted">
                      {s.refresh_cron ? `Planned: ${describeCron(s.refresh_cron)}` : describeCron(s.refresh_cron)} ·{' '}
                      {s.last_refreshed ? `last refreshed ${fmtAgo(s.last_refreshed)}` : s.status === 'not_refreshed' ? 'never refreshed yet' : 'last refresh not recorded'}
                    </div>
                  </div>
                  <SourceStatusBadge status={s.status} />
                </li>
              ))}
              {!LIVE_IDS.some((id) => byId.has(id)) ? <li className="py-6 text-center text-sm text-muted">The source registry is unavailable right now.</li> : null}
            </ul>
          )}
        </Card>
        <Card className="xl:col-span-5" title="Lifecycle of a refresh" icon={ShieldCheck} tone="subtle">
          <ol className="space-y-2.5 text-[13px] leading-relaxed text-ink-2">
            <li>
              <span className="font-semibold text-ink">Trigger.</span> An administrator presses “Refresh now” (a scheduler can call the same endpoint).
            </li>
            <li>
              <span className="font-semibold text-ink">Job.</span> A refresh job is recorded as running and executes in the background.
            </li>
            <li>
              <span className="font-semibold text-ink">Fetch and write.</span> The connector downloads the latest data and rewrites only its own tables.
            </li>
            <li>
              <span className="font-semibold text-ink">Recompute.</span> Dependent metrics (shares, RCA, CAGR) are recomputed for the affected products.
            </li>
            <li>
              <span className="font-semibold text-ink">Close.</span> The job ends as succeeded, failed or not configured, with a record count and message; the
              source’s “last refreshed” date updates.
            </li>
          </ol>
        </Card>
      </div>
    </div>
  );
}

function Stage({ step, title, icon: Icon, children }: { step: number; title: string; icon: typeof Globe; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-line bg-surface-2 p-3.5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-navy text-white" aria-hidden>
          <Icon className="size-4" />
        </span>
        <div>
          <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">Stage {step}</div>
          <div className="text-[13.5px] font-semibold text-ink">{title}</div>
        </div>
      </div>
      <ul className="flex flex-1 flex-col gap-2">{children}</ul>
    </div>
  );
}

function StageItem({ label, detail, tone, status }: { label: string; detail: string; tone?: 'success' | 'orange' | 'info'; status?: string }) {
  return (
    <li className="rounded-lg border border-line bg-surface px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-medium text-ink">
        {label}
        {status ? (
          <Badge tone={tone} size="xs">
            {status}
          </Badge>
        ) : null}
      </div>
      <div className="mt-0.5 text-xs leading-snug text-ink-2">{detail}</div>
    </li>
  );
}

function Arrow() {
  return (
    <div className="flex items-center justify-center text-muted" aria-hidden>
      <ArrowRight className="hidden size-5 lg:block" />
      <ArrowDown className="size-5 lg:hidden" />
    </div>
  );
}

/** Env vars the connector needs: live from the registry when the router reports them, else the documented names. */
function envOf(c: GovConnector, source: DataSource | undefined): string[] {
  const live = (source as SourceRow | undefined)?.connector?.required_env;
  return live?.length ? live : c.env;
}

function GovConnectorCard({ connector: c, source, loading }: { connector: GovConnector; source: DataSource | undefined; loading: boolean }) {
  const Icon = c.id === 'gstn' ? Building : c.id === 'dgft' ? FileUp : Landmark;
  return (
    <Card padding="md" className="h-full">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink" aria-hidden>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14.5px] leading-snug font-semibold text-ink">{c.name}</h3>
          <div className="text-xs text-muted">{c.owner}</div>
        </div>
        {loading ? <Skeleton className="h-5 w-24" /> : source ? <SourceStatusBadge status={source.status} /> : <Badge tone="outline">Not registered</Badge>}
      </div>
      <dl className="mt-3 space-y-2.5 text-[13px]">
        <div>
          <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">Brings</dt>
          <dd className="text-ink-2">{c.brings}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">Improves</dt>
          <dd className="text-ink-2">{c.improves}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">Needs</dt>
          <dd>
            <ul className="list-disc space-y-0.5 pl-4 text-ink-2">
              {c.needs.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <KeyRound className="size-3.5 text-muted" aria-hidden />
              {envOf(c, source).map((e) => (
                <code key={e} className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
                  {e}
                </code>
              ))}
            </div>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">Lands in</dt>
          <dd className="text-ink-2">{c.lands}</dd>
        </div>
      </dl>
    </Card>
  );
}
