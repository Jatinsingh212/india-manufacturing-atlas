/**
 * Sources & connectors: the registry of every data source (status, last refresh, records, licence,
 * schedule), an admin "Refresh now" per connector that starts a background job and polls
 * GET /api/datahub/jobs until it finishes, and the refresh history (government roles).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleDashed, Database, ExternalLink, KeyRound, LoaderCircle, Plug, RefreshCw, Scale, Timer } from 'lucide-react';
import type { DataSource, RefreshJob } from '@/api/types';
import { useAuth, RequireRole } from '@/auth';
import { Badge, Button, Card, DataTable, ErrorState, KpiTile, QueryState, StatGrid, Tooltip, useToast, type Column } from '@/components';
import { fmtAgo, fmtDate, fmtNum, truncate } from '@/lib/format';
import { datahubKeys, useDataSources, useJobs, useRefreshSource } from '../api';
import { describeCron, JobStatusBadge, SourceStatusBadge, sourceKind, type JobRow, type SourceRow } from '../utils';

interface Watch {
  sourceId: string;
  since: number;
}

/** Give up waiting for a job that never shows up in the jobs list after this long. */
const WATCH_TIMEOUT_MS = 5 * 60 * 1000;

export function SourcesTab() {
  const { isAdmin, isGov } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const sources = useDataSources();
  const [watching, setWatching] = useState<Record<number, Watch>>({});
  const jobs = useJobs(isGov, Object.keys(watching).length > 0);
  const nameOf = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s.name])), [sources.data]);
  // Latest values for callbacks that outlive the render that created them (mutation callbacks, the
  // polling effect); refreshed after every commit rather than during render.
  const nameRef = useRef(nameOf);
  useLayoutEffect(() => {
    nameRef.current = nameOf;
  }, [nameOf]);

  const notify = (job: RefreshJob) => {
    const name = nameRef.current.get(job.source_id) ?? job.source_id;
    const detail = job.message ?? (typeof job.records === 'number' ? `${fmtNum(job.records)} records` : undefined);
    if (job.status === 'success') toast.success(`${name} refreshed`, detail);
    else if (job.status === 'not_configured') toast.info(`${name} is not configured`, detail ?? 'The connector needs credentials before it can run.');
    else toast.error(`${name} refresh ${job.status}`, detail);
    void qc.invalidateQueries({ queryKey: datahubKeys.all });
    void qc.invalidateQueries({ queryKey: ['meta'] });
  };
  const notifyRef = useRef(notify);
  useLayoutEffect(() => {
    notifyRef.current = notify;
  });

  const refresh = useRefreshSource((job) => {
    if (job.status === 'running') {
      setWatching((w) => ({ ...w, [job.id]: { sourceId: job.source_id, since: Date.now() } }));
      toast.info(`Refresh started: ${nameRef.current.get(job.source_id) ?? job.source_id}`, `Job #${job.id} runs in the background; this page updates when it finishes.`);
    } else {
      notify(job);
    }
  });

  // Resolve watched jobs as the polled list reports them finished.
  useEffect(() => {
    const ids = Object.keys(watching).map(Number);
    if (!ids.length) return;
    const list = jobs.data ?? [];
    const finished: number[] = [];
    for (const id of ids) {
      const job = list.find((j) => j.id === id);
      if (job && job.status !== 'running') {
        notifyRef.current(job);
        finished.push(id);
      } else if (!job && Date.now() - watching[id].since > WATCH_TIMEOUT_MS) {
        finished.push(id);
      }
    }
    if (finished.length) {
      setWatching((w) => {
        const next = { ...w };
        for (const id of finished) delete next[id];
        return next;
      });
    }
    // dataUpdatedAt changes on every poll, so the timeout is re-evaluated even when the list is unchanged.
  }, [jobs.data, jobs.dataUpdatedAt, watching]);

  const running = useMemo(() => {
    const set = new Set<string>(Object.values(watching).map((w) => w.sourceId));
    for (const j of jobs.data ?? []) if (j.status === 'running') set.add(j.source_id);
    return set;
  }, [jobs.data, watching]);

  return (
    <div className="space-y-6">
      <QueryState query={sources} loadingLabel="Loading the source registry…" isEmpty={(d) => d.length === 0} emptyTitle="No data sources registered" emptyIcon={Database}>
        {(list) => (
          <>
            <SourceKpis sources={list} />
            <div className="mt-6 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {byStatus(list).map((s) => (
                <SourceCard
                  key={s.id}
                  source={s as SourceRow}
                  canRefresh={isAdmin}
                  running={running.has(s.id)}
                  starting={refresh.isPending && refresh.variables === s.id}
                  onRefresh={() => refresh.mutate(s.id)}
                />
              ))}
            </div>
          </>
        )}
      </QueryState>

      <RequireRole roles="gov" title="Refresh history" description="Every connector run with its status, duration and record count." compact>
        <JobsCard jobs={jobs.data} loading={jobs.isPending} error={jobs.error} onRetry={() => void jobs.refetch()} nameOf={nameOf} polling={running.size > 0} />
      </RequireRole>
    </div>
  );
}

const STATUS_ORDER: Record<string, number> = { connected: 0, error: 1, not_refreshed: 2, not_configured: 3 };

/**
 * Live sources first, then failing ones, then connectors that have never run, then connectors awaiting
 * credentials (registry order within each).
 */
function byStatus(list: DataSource[]): DataSource[] {
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (STATUS_ORDER[a.s.status] ?? 4) - (STATUS_ORDER[b.s.status] ?? 4) || a.i - b.i)
    .map((x) => x.s);
}

/** "A, B and C" */
function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Short registry name ("UN Comtrade (public preview API)" -> "UN Comtrade"; "CBIC Customs Tariff / ICEGATE" -> "CBIC"). */
function shortName(s: DataSource): string {
  const base = s.name.replace(/\s*\(.*\)\s*$/, '');
  const first = base.split(/\s+/)[0] ?? base;
  return /^[A-Z]{3,}$/.test(first) ? first : base;
}

function SourceKpis({ sources }: { sources: DataSource[] }) {
  const connected = sources.filter((s) => s.status === 'connected').length;
  const pendingList = sources.filter((s) => s.status === 'not_configured');
  const pending = pendingList.length;
  const errors = sources.filter((s) => s.status === 'error').length;
  const neverRun = sources.filter((s) => s.status === 'not_refreshed');
  const latest = sources.map((s) => s.last_refreshed).filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;
  const connectedSub = [
    errors ? `${fmtNum(errors)} reporting an error` : null,
    neverRun.length ? `${listNames(neverRun.map(shortName))} not yet refreshed` : null,
  ].filter(Boolean);
  return (
    <StatGrid cols={4}>
      <KpiTile label="Registered sources" icon={Database} value={fmtNum(sources.length)} accent="ink" sub="APIs, files and curated inputs" />
      <KpiTile label="Connected" icon={Plug} accent="ok" value={fmtNum(connected)} sub={connectedSub.length ? connectedSub.join(' · ') : 'Loaded into the Atlas'} />
      <KpiTile label="Awaiting credentials" icon={KeyRound} value={fmtNum(pending)} sub={pending ? `${listNames(pendingList.map(shortName))} connectors` : 'No connector is waiting for credentials'} />
      <KpiTile label="Most recent refresh" icon={CalendarClock} accent="brand" value={latest ? fmtAgo(latest) : null} sub={latest ? fmtDate(latest, { withTime: true }) : 'No refresh recorded'} />
    </StatGrid>
  );
}

function SourceCard({
  source: s,
  canRefresh,
  running,
  starting,
  onRefresh,
}: {
  source: SourceRow;
  canRefresh: boolean;
  running: boolean;
  starting: boolean;
  onRefresh: () => void;
}) {
  const kind = sourceKind(s.kind);
  // The router says which sources have a connector (`connector.refreshable`); else API sources do.
  const isConnector = typeof s.connector?.refreshable === 'boolean' ? s.connector.refreshable : s.kind === 'api';
  const needs = s.status === 'not_configured' ? (s.connector?.required_env ?? []) : [];
  return (
    <Card padding="md" className="h-full">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink" aria-hidden>
          <kind.icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14.5px] leading-snug font-semibold text-ink">{s.name}</h3>
          {s.owner ? <div className="mt-0.5 text-xs text-muted">{s.owner}</div> : null}
        </div>
        {running ? (
          <Badge tone="info" icon={LoaderCircle}>
            Refreshing
          </Badge>
        ) : (
          <SourceStatusBadge status={s.status} />
        )}
      </div>
      {s.description ? <p className="mt-3 line-clamp-4 text-[13px] leading-relaxed text-ink-2" title={s.description}>{s.description}</p> : null}
      {s.status === 'not_refreshed' ? (
        <div className="mt-3 rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-xs text-ink-2" role="note">
          <div className="flex items-center gap-1.5 font-medium text-ink">
            <CircleDashed className="size-3.5" aria-hidden /> Not fetched yet
          </div>
          <p className="mt-1">
            No data from this source is loaded until its first successful refresh
            {s.connector?.message ? ` (${s.connector.message})` : ''}.{' '}
            {canRefresh && isConnector ? 'Run it with “Run first refresh” below.' : 'An administrator runs it from this tab.'}
          </p>
        </div>
      ) : null}
      {needs.length ? (
        <div className="mt-3 rounded-lg border border-na/30 bg-na-soft px-3 py-2 text-xs text-ink-2">
          <div className="flex items-center gap-1.5 font-medium text-na-ink">
            <KeyRound className="size-3.5" aria-hidden /> Needs server credentials
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {needs.map((e) => (
              <code key={e} className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
                {e}
              </code>
            ))}
          </div>
        </div>
      ) : null}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-xs">
        <div>
          <dt className="text-muted">Last refreshed</dt>
          <dd className="font-medium text-ink" title={s.last_refreshed ? fmtDate(s.last_refreshed, { withTime: true }) : undefined}>
            {s.last_refreshed ? `${fmtDate(s.last_refreshed)} · ${fmtAgo(s.last_refreshed)}` : s.status === 'not_refreshed' ? 'Never' : 'Not available'}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Records loaded</dt>
          <dd className="font-medium text-ink atlas-num">{fmtNum(s.records)}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-muted">
            <Scale className="size-3" aria-hidden /> Licence
          </dt>
          <dd className="text-ink-2">{s.licence ?? 'Not stated'}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-muted">
            <Timer className="size-3" aria-hidden /> {s.refresh_cron ? 'Planned schedule' : 'Schedule'}
          </dt>
          <dd
            className="text-ink-2"
            title={s.refresh_cron ? `${s.refresh_cron} - intended cadence; scheduled runs are not enabled yet, an administrator starts each refresh.` : undefined}
          >
            {describeCron(s.refresh_cron)}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone="outline" size="xs" icon={kind.icon}>
          {kind.label}
        </Badge>
        {s.url ? (
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs atlas-link">
            Visit source <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
        {canRefresh && isConnector ? (
          <Tooltip
            className="ml-auto"
            content={
              s.status === 'not_configured'
                ? 'The connector reports what it needs; no data is changed.'
                : s.status === 'not_refreshed'
                  ? 'Fetch from the source for the first time and load the results.'
                  : 'Re-fetch from the source and recompute dependent tables.'
            }
          >
            <Button
              size="xs"
              variant={s.status === 'connected' || s.status === 'not_refreshed' ? 'primary' : 'secondary'}
              icon={RefreshCw}
              loading={starting}
              disabled={running}
              onClick={onRefresh}
            >
              {s.status === 'not_configured' ? 'Test connector' : s.status === 'not_refreshed' ? 'Run first refresh' : 'Refresh now'}
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </Card>
  );
}

/** Epoch ms of a backend timestamp (UTC; the zone suffix is sometimes omitted). */
function toMs(ts: string): number {
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(ts) ? `${ts.replace(' ', 'T')}Z` : ts;
  return new Date(iso).getTime();
}

function duration(job: JobRow): string {
  if (typeof job.duration_s === 'number' && job.finished_at) {
    const sec = job.duration_s;
    if (sec < 1) return '<1 s';
    return sec < 60 ? `${Math.round(sec)} s` : `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  }
  if (!job.finished_at) return job.status === 'running' ? 'Running…' : '—';
  const ms = toMs(job.finished_at) - toMs(job.started_at);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1 s';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function JobsCard({
  jobs,
  loading,
  error,
  onRetry,
  nameOf,
  polling,
}: {
  jobs: JobRow[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  nameOf: Map<string, string>;
  polling: boolean;
}) {
  const columns: Column<JobRow>[] = [
    { key: 'id', header: 'Job', align: 'right', value: (j) => j.id, render: (j) => <span className="text-muted atlas-num">#{j.id}</span>, width: 72 },
    { key: 'source', header: 'Source', value: (j) => nameOf.get(j.source_id) ?? j.source_name ?? j.source_id },
    { key: 'status', header: 'Status', value: (j) => j.status, render: (j) => <JobStatusBadge status={j.status} /> },
    { key: 'started_at', header: 'Started', value: (j) => j.started_at, render: (j) => <span title={fmtDate(j.started_at, { withTime: true })}>{fmtAgo(j.started_at)}</span> },
    { key: 'duration', header: 'Duration', value: (j) => duration(j), sortable: false, hideBelow: 'sm' },
    { key: 'records', header: 'Records', align: 'right', value: (j) => j.records },
    {
      key: 'message',
      header: 'Message',
      value: (j) => j.message,
      render: (j) => (j.message ? <span title={j.message} className="text-ink-2">{truncate(j.message, 90)}</span> : <span className="text-muted">—</span>),
      hideBelow: 'md',
    },
    {
      key: 'triggered_by',
      header: 'Triggered by',
      value: (j) => j.triggered_by_name ?? (j.triggered_by ? `User #${j.triggered_by}` : 'Schedule / system'),
      hideBelow: 'lg',
    },
  ];
  return (
    <Card
      title="Refresh history"
      subtitle={polling ? 'A job is running - this list updates every 2 seconds.' : 'Most recent connector runs'}
      icon={RefreshCw}
      actions={polling ? <Badge tone="info" icon={LoaderCircle}>Live</Badge> : undefined}
    >
      {error && !jobs ? (
        <ErrorState error={error} onRetry={onRetry} compact />
      ) : (
        <DataTable
          columns={columns}
          rows={jobs}
          rowKey={(j) => j.id}
          loading={loading}
          defaultSort={{ key: 'started_at', order: 'desc' }}
          pagination={{ mode: 'client', pageSize: 10, pageSizeOptions: [10, 25, 50] }}
          maxHeight={null}
          dense
          csvFilename="datahub-refresh-jobs"
          emptyTitle="No refresh jobs yet"
          emptyMessage="Connector runs started by an administrator appear here."
        />
      )}
    </Card>
  );
}
