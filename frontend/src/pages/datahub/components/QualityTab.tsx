/**
 * Data-quality dashboard (GET /api/datahub/quality, government roles):
 * - coverage KPIs (trade, tariff, production) and residual share;
 * - mapping provenance (DPIIT Guidebook / official upload / manual review = Verified; rule / unlisted = Not verified);
 * - distribution of product data-quality scores (SPEC section 4 formula);
 * - quality by ministry;
 * - BACI vs UN Comtrade cross-check (scatter on log axes + table). While no cross-checks exist the card
 *   turns `cross_check_summary.action` into a call to action: admins get a button that starts the named
 *   connector (POST /api/datahub/sources/{id}/refresh) and follows the job; other roles are told who
 *   can run it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EChartsOption } from 'echarts';
import { ArrowUpRight, ChartColumn, CircleCheck, Database, Factory, GitCompare, KeyRound, Landmark, Layers, LoaderCircle, Package, Receipt, RefreshCw, ShieldCheck, UserCog } from 'lucide-react';
import { useMinistryLookup } from '@/api/hooks';
import type { DataQualityResponse, RefreshJob } from '@/api/types';
import { ROLE_LABELS, useAuth } from '@/auth';
import { Badge, Button, Card, CodeLink, DataTable, EChart, KpiTile, MinistryPill, ModelEstimateTag, ProvenanceBadge, QueryState, ScoreBar, StatGrid, tradeSourceLabel, useToast, type BadgeTone, type Column } from '@/components';
import { fmtDate, fmtNum, fmtPct, fmtUSD, NA_SHORT } from '@/lib/format';
import { routes } from '@/lib/routes';
import { BASE_GRID, CATEGORICAL, OTHER_GREY } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { datahubKeys, useDataSources, useJobs, useQuality, useRefreshSource } from '../api';
import { sharesAsFractions, SourceStatusBadge, type CrossCheckAction, type QualityData, type SourceRow } from '../utils';

export function QualityTab() {
  const q = useQuality(true);
  return (
    <QueryState query={q} loadingLabel="Computing data-quality indicators…">
      {(d) => <QualityBody data={d} />}
    </QueryState>
  );
}

/** Stop following a cross-check job that never shows up in the jobs list after this long. */
const WATCH_TIMEOUT_MS = 5 * 60 * 1000;

/** Registry name without its parenthesised detail ("UN Comtrade (public preview API)" -> "UN Comtrade"). */
function plainName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, '') || name;
}

/**
 * Empty cross-check table: what to run, and who can run it. Admins start the connector here and the
 * card follows the job (polling GET /api/datahub/jobs) until the comparison arrives.
 */
function CrossCheckCta({ action }: { action: CrossCheckAction }) {
  const { isAdmin, role } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const sources = useDataSources();
  const source = (sources.data ?? []).find((s) => s.id === action.source_id) as SourceRow | undefined;
  const name = plainName(source?.name ?? action.source_id);
  const status = action.status ?? source?.status ?? null;
  const refreshable = action.refreshable ?? source?.connector?.refreshable ?? false;
  const configured = action.configured ?? source?.connector?.configured ?? true;
  const [watch, setWatch] = useState<{ id: number; since: number } | null>(null);
  const jobs = useJobs(isAdmin, watch !== null);

  const finish = (job: RefreshJob) => {
    const detail = job.message ?? (typeof job.records === 'number' ? `${fmtNum(job.records)} records` : undefined);
    if (job.status === 'success') toast.success(`${name} cross-check finished`, detail);
    else if (job.status === 'not_configured') toast.info(`${name} is not configured`, detail ?? 'The connector needs server credentials before it can run.');
    else toast.error(`${name} cross-check ${job.status}`, detail);
    void qc.invalidateQueries({ queryKey: datahubKeys.all });
  };
  const finishRef = useRef(finish);
  useLayoutEffect(() => {
    finishRef.current = finish;
  });

  const refresh = useRefreshSource((job) => {
    if (job.status === 'running') {
      setWatch({ id: job.id, since: Date.now() });
      toast.info(`${name} cross-check started`, `Job #${job.id} runs in the background; this card updates when it finishes.`);
    } else {
      finishRef.current(job);
    }
  });

  useEffect(() => {
    if (!watch) return;
    const job = (jobs.data ?? []).find((j) => j.id === watch.id);
    if (job && job.status !== 'running') {
      finishRef.current(job);
      setWatch(null);
    } else if (!job && Date.now() - watch.since > WATCH_TIMEOUT_MS) {
      setWatch(null);
    }
  }, [jobs.data, jobs.dataUpdatedAt, watch]);

  const running = watch !== null || (jobs.data ?? []).some((j) => j.source_id === action.source_id && j.status === 'running');
  const headline =
    status === 'error'
      ? `The last ${name} run failed, so there is nothing to compare yet`
      : status === 'not_refreshed'
        ? `No cross-checks yet: ${name} has not been refreshed`
        : status === 'not_configured'
          ? `No cross-checks yet: ${name} needs server credentials`
          : 'No cross-checks yet';

  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 py-6 text-center" role="status">
      <span className="inline-flex size-10 items-center justify-center rounded-full bg-brand-soft text-brand-ink" aria-hidden>
        <GitCompare className="size-5" />
      </span>
      <div className="text-[15px] font-semibold text-ink">{headline}</div>
      <p className="text-[13px] leading-relaxed text-ink-2">
        The {name} connector fetches India&rsquo;s own reported trade for the HS6 codes of the curated value chains and compares it here with CEPII
        BACI&rsquo;s reconciled values. It runs on demand, as a background refresh job.
      </p>
      {isAdmin ? (
        refreshable ? (
          <div className="flex flex-col items-center gap-2">
            <Button variant="primary" icon={running ? LoaderCircle : RefreshCw} loading={refresh.isPending} disabled={running} onClick={() => refresh.mutate(action.source_id)}>
              {running ? `${name} cross-check running…` : configured ? `Run the ${name} cross-check` : `Test the ${name} connector`}
            </Button>
            <span className="text-xs text-muted">
              {running
                ? 'The comparison appears here when the job finishes.'
                : configured
                  ? 'Public API, no key required. The job is listed in the refresh history on the Sources tab.'
                  : 'The connector reports the credentials it needs; no data is changed.'}
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted">{action.message ?? 'This source has no connector that can be run from the Data Hub.'}</p>
        )
      ) : (
        <div className="flex flex-col items-center gap-2">
          <p className="inline-flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-[13px] text-ink-2">
            <UserCog className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden />
            <span>
              <span className="font-medium text-ink">Who can run it:</span> an administrator (DPIIT programme office), from Data Hub › Sources &amp;
              connectors. You are signed in as {ROLE_LABELS[role] ?? role}; the comparison appears here once the connector has run.
            </span>
          </p>
          {!configured ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <KeyRound className="size-3.5" aria-hidden /> The connector first needs server credentials.
            </span>
          ) : null}
          <Button size="sm" to={routes.dataHub()} iconRight={ArrowUpRight}>
            See the {name} source
          </Button>
        </div>
      )}
    </div>
  );
}

type Check = DataQualityResponse['cross_checks'][number] & { diff: number | null };
type MinistryQuality = DataQualityResponse['by_ministry'][number] & { trade: number | null; verified: number | null };

function share(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

function agreement(diff: number | null): { tone: BadgeTone; label: string } {
  if (diff === null) return { tone: 'orange', label: 'Not available' };
  const a = Math.abs(diff);
  if (a <= 0.05) return { tone: 'success', label: 'Consistent (±5%)' };
  if (a <= 0.2) return { tone: 'warning', label: 'Minor gap (≤20%)' };
  return { tone: 'danger', label: 'Large gap (>20%)' };
}

function QualityBody({ data }: { data: DataQualityResponse }) {
  const { mode } = useTheme();
  const ministries = useMinistryLookup();
  const c = data.coverage;
  const summary = (data as QualityData).cross_check_summary ?? null;
  const action = summary?.action ?? null;
  const products = c.products || 0;

  const mappingRows = [
    { key: 'guidebook', label: 'DPIIT Guidebook (official, 16.12.2025)', n: c.mapping_guidebook, status: 'verified' as const },
    { key: 'official', label: 'Official mapping uploaded through the Data Hub', n: c.mapping_official, status: 'verified' as const },
    { key: 'manual', label: 'Manual review (approved claims)', n: c.mapping_manual, status: 'verified' as const },
    { key: 'guidebook_residual', label: 'Guidebook residual (no ministry accepted)', n: c.mapping_guidebook_residual, status: 'not_verified' as const },
    { key: 'unmapped', label: 'Not listed in the Guidebook', n: c.mapping_unmapped, status: 'not_verified' as const },
  ];
  const verifiedMapped = c.mapping_guidebook + c.mapping_official + c.mapping_manual;

  const checks: Check[] = useMemo(
    () =>
      data.cross_checks.map((x) => ({
        ...x,
        // SPEC's diff_pct, as the connector defines it: (Comtrade - BACI) / BACI. Recomputed only if absent.
        diff:
          typeof x.diff_pct === 'number' && Number.isFinite(x.diff_pct)
            ? x.diff_pct
            : typeof x.baci_value === 'number' && typeof x.comtrade_value === 'number' && x.baci_value !== 0
              ? (x.comtrade_value - x.baci_value) / x.baci_value
              : null,
      })),
    [data.cross_checks],
  );
  const withDiff = checks.filter((x) => x.diff !== null);
  const consistent = withDiff.filter((x) => Math.abs(x.diff as number) <= 0.05).length;
  const medianAbs = useMemo(() => {
    const v = withDiff.map((x) => Math.abs(x.diff as number)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }, [withDiff]);

  // *_pct may be fractions or percentages (SPEC does not pin the scale); resolve it against the
  // coverage totals so that shares below 1 % are not mistaken for fractions.
  const ministryRows: MinistryQuality[] = useMemo(() => {
    const codes = data.by_ministry.map((r) => r.codes);
    const trade = sharesAsFractions(data.by_ministry.map((r) => r.with_trade_pct), codes, data.coverage.with_trade);
    const verified = sharesAsFractions(data.by_ministry.map((r) => r.verified_pct), codes, verifiedMapped);
    return data.by_ministry.map((r, i) => ({ ...r, trade: trade[i], verified: verified[i] }));
  }, [data.by_ministry, data.coverage.with_trade, verifiedMapped]);

  const histogram = useMemo<EChartsOption>(
    () => ({
      grid: { ...BASE_GRID, top: 28, bottom: 24 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => `${fmtNum(Number(v))} products` },
      xAxis: { type: 'category', data: data.quality_histogram.map((b) => b.bucket), name: 'Data-quality score (0–100)', nameLocation: 'middle', nameGap: 28 },
      yAxis: { type: 'value', name: 'Products', minInterval: 1, axisLabel: { formatter: (v: number) => fmtNum(v, { compact: true }) } },
      series: [
        {
          type: 'bar',
          name: 'Products',
          data: data.quality_histogram.map((b) => b.count),
          itemStyle: { color: CATEGORICAL[mode][0], borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 36,
          label: { show: data.quality_histogram.length <= 12, position: 'top', fontSize: 11, formatter: (p) => fmtNum(Number(p.value), { compact: true }) },
        },
      ],
    }),
    [data.quality_histogram, mode],
  );

  const scatter = useMemo<EChartsOption | null>(() => {
    const pts = checks.filter((x) => (x.baci_value ?? 0) > 0 && (x.comtrade_value ?? 0) > 0);
    if (!pts.length) return null;
    const all = pts.flatMap((x) => [x.baci_value as number, x.comtrade_value as number]);
    // Whole decades keep the log ticks on round values ($1 mn, $10 mn, ...).
    const lo = 10 ** Math.floor(Math.log10(Math.min(...all)));
    const hi = 10 ** Math.ceil(Math.log10(Math.max(...all)));
    return {
      grid: { ...BASE_GRID, top: 44, bottom: 28, left: 12 },
      legend: { top: 0, right: 0, data: ['Product and flow', 'Equal values'] },
      tooltip: {
        trigger: 'item',
        formatter: (p: unknown) => {
          const item = p as { seriesIndex: number; dataIndex: number };
          if (item.seriesIndex !== 0) return 'BACI = Comtrade';
          const x = pts[item.dataIndex];
          return `<b>HS ${x.hs6}</b> · ${x.flow === 'X' ? 'India exports' : 'India imports'} ${x.year}<br/>UN Comtrade: ${fmtUSD(x.comtrade_value)}<br/>CEPII BACI: ${fmtUSD(x.baci_value)}<br/>Comtrade vs BACI: ${fmtPct(x.diff, { signed: true })}`;
        },
      },
      xAxis: {
        type: 'log',
        name: 'UN Comtrade reported (US$)',
        nameLocation: 'middle',
        nameGap: 26,
        min: lo,
        max: hi,
        axisLabel: { formatter: (v: number) => fmtUSD(v, { sig: 2 }), hideOverlap: true },
      },
      yAxis: {
        type: 'log',
        name: 'CEPII BACI (US$)',
        nameTextStyle: { align: 'left' },
        min: lo,
        max: hi,
        axisLabel: { formatter: (v: number) => fmtUSD(v, { sig: 2 }), hideOverlap: true },
      },
      series: [
        {
          type: 'scatter',
          name: 'Product and flow',
          symbolSize: 10,
          itemStyle: { color: CATEGORICAL[mode][0] },
          data: pts.map((x) => [x.comtrade_value as number, x.baci_value as number]),
        },
        {
          type: 'line',
          name: 'Equal values',
          data: [
            [lo, lo],
            [hi, hi],
          ],
          symbol: 'none',
          itemStyle: { color: OTHER_GREY[mode] },
          lineStyle: { color: OTHER_GREY[mode], width: 1.5, type: 'dashed' },
          tooltip: { show: false },
          z: 1,
        },
      ],
    };
  }, [checks, mode]);

  const ministryCols: Column<MinistryQuality>[] = [
    {
      key: 'ministry',
      header: 'Ministry',
      value: (r) => r.short_name,
      render: (r) => <MinistryPill ministry={{ id: r.ministry_id, short_name: r.short_name, name: ministries.get(r.ministry_id)?.name, color: ministries.get(r.ministry_id)?.color }} />,
    },
    { key: 'codes', header: 'Lines', align: 'right', value: (r) => r.codes },
    { key: 'trade', header: 'With trade data', align: 'right', value: (r) => r.trade, render: (r) => fmtPct(r.trade, { na: NA_SHORT }) },
    {
      key: 'verified',
      header: 'Verified mapping',
      align: 'right',
      value: (r) => r.verified,
      render: (r) => fmtPct(r.verified, { na: NA_SHORT }),
      hint: 'Share of lines whose ministry mapping is verified by the DPIIT Guidebook, an official upload or a manual review.',
    },
    {
      key: 'avg_quality',
      header: 'Avg quality score',
      value: (r) => r.avg_quality,
      render: (r) => <ScoreBar value={r.avg_quality} className="min-w-36" />,
      firstSort: 'desc',
    },
  ];

  const checkYears = [...new Set(checks.map((x) => x.year))].sort();
  const checkCols: Column<Check>[] = [
    { key: 'hs6', header: 'HS6', value: (x) => x.hs6, render: (x) => <CodeLink code={x.hs6} /> },
    ...(checkYears.length > 1 ? [{ key: 'year', header: 'Year', align: 'right', value: (x) => x.year, render: (x) => String(x.year) } satisfies Column<Check>] : []),
    { key: 'flow', header: 'Flow', value: (x) => (x.flow === 'X' ? 'Exports' : 'Imports') },
    { key: 'comtrade', header: 'UN Comtrade', align: 'right', value: (x) => x.comtrade_value, render: (x) => fmtUSD(x.comtrade_value, { na: NA_SHORT }) },
    { key: 'baci', header: 'CEPII BACI', align: 'right', value: (x) => x.baci_value, render: (x) => fmtUSD(x.baci_value, { na: NA_SHORT }) },
    {
      key: 'diff',
      header: 'Difference',
      align: 'right',
      value: (x) => (x.diff === null ? null : Math.abs(x.diff)),
      render: (x) => fmtPct(x.diff, { signed: true, na: NA_SHORT }),
      hint: '(Comtrade − BACI) ÷ BACI. BACI reconciles exporter and importer reports and values imports FOB (Comtrade imports are CIF), so small gaps are expected.',
    },
    { key: 'agreement', header: 'Agreement', value: (x) => agreement(x.diff).label, render: (x) => <Badge tone={agreement(x.diff).tone}>{agreement(x.diff).label}</Badge> },
  ];

  return (
    <div className="space-y-6">
      <StatGrid cols={5}>
        <KpiTile label="Product lines" icon={Package} value={fmtNum(products)} accent="ink" sub="8-digit lines in the Atlas" />
        <KpiTile
          label="With trade data"
          icon={ChartColumn}
          value={fmtPct(share(c.with_trade, products))}
          sub={`${fmtNum(c.with_trade)} lines · DGCIS TRADESTAT`}
          provenance={{ source: 'tradestat', status: 'verified', label: tradeSourceLabel(2024), year: 2024 }}
        />
        <KpiTile
          label="With an MFN tariff"
          icon={Receipt}
          value={fmtPct(share(c.with_tariff, products))}
          sub={`${fmtNum(c.with_tariff)} lines · WITS / TRAINS`}
          provenance={{ source: 'wits', status: 'verified', label: 'WITS / UNCTAD TRAINS', year: 2022 }}
        />
        <KpiTile
          label="With production data"
          icon={Factory}
          value={fmtPct(share(c.with_production, products))}
          sub={`${fmtNum(c.with_production)} lines · awaiting ministry uploads`}
          status={c.with_production > 0 ? 'not_verified' : 'not_available'}
        />
        <KpiTile label="Residual lines" icon={Layers} accent="ink" value={fmtNum(c.residual)} sub={`${fmtPct(share(c.residual, products))} of lines without an owner`} />
      </StatGrid>

      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="xl:col-span-5" title="Where the ministry mapping comes from" subtitle={`${fmtPct(share(verifiedMapped, products))} of lines carry a verified mapping`} icon={ShieldCheck}>
          <ul className="space-y-3.5">
            {mappingRows.map((r) => {
              const s = share(r.n, products);
              return (
                <li key={r.key}>
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="min-w-0 flex-1 font-medium text-ink">{r.label}</span>
                    <ProvenanceBadge status={r.status} size="xs" />
                    <span className="w-28 text-right text-ink-2 atlas-num">
                      {fmtNum(r.n)} · {fmtPct(s)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${r.label}: ${fmtPct(s)}`}>
                    <div className="h-full rounded-full" style={{ width: `${Math.max((s ?? 0) * 100, r.n > 0 ? 0.8 : 0)}%`, backgroundColor: CATEGORICAL[mode][0] }} />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-xs text-muted">
            Ownership comes from the official DPIIT Guidebook on HSN Code Mapping (16.12.2025 revision).
            Lines it lists as residual, or does not list, keep no accepted owner; the Atlas does not apply a
            rule-based fallback. Parent-level coverage at 2/4/6 digits is derived from accepted 8-digit lines.
          </p>
        </Card>
        <Card
          className="xl:col-span-7"
          title="Distribution of product data-quality scores"
          subtitle="Number of product lines per score band (0–100: mapping, trade, tariff and production evidence)"
          icon={Database}
          actions={<ModelEstimateTag method="Data-quality score = 30 verified mapping (DPIIT Guidebook / upload / approved claim), 0 residual + 30 trade + 20 tariff + 20 production, capped at 100" />}
        >
          {data.quality_histogram.length ? (
            <EChart option={histogram} height={280} ariaLabel="Histogram of product data-quality scores" />
          ) : (
            <p className="py-12 text-center text-sm text-muted">No quality scores are available.</p>
          )}
        </Card>
      </div>

      <Card title="Data quality by ministry" subtitle="Coverage and mapping status of the lines each ministry owns" icon={Landmark}>
        <DataTable
          columns={ministryCols}
          rows={ministryRows}
          rowKey={(r) => r.ministry_id}
          defaultSort={{ key: 'codes', order: 'desc' }}
          pagination={{ mode: 'client', pageSize: 10, pageSizeOptions: [10, 25, 50] }}
          maxHeight={null}
          dense
          csvFilename="data-quality-by-ministry"
          emptyTitle="No ministry statistics"
        />
      </Card>

      <Card
        title="Cross-check: CEPII BACI against UN Comtrade"
        subtitle={`India's reported trade (UN Comtrade) compared with BACI's reconciled values for the value-chain products${checkYears.length === 1 ? `, ${checkYears[0]}` : ''}`}
        icon={GitCompare}
        actions={
          checks.length === 0 && action?.status ? (
            <SourceStatusBadge status={action.status} />
          ) : (
            <Badge tone={withDiff.length ? 'success' : 'orange'} icon={CircleCheck}>
              {withDiff.length ? `${fmtNum(consistent)} of ${fmtNum(withDiff.length)} within ±5%` : 'No comparable pairs'}
            </Badge>
          )
        }
        footer={
          checks.length && summary?.last_checked ? (
            <span className="text-xs text-muted">
              Last checked {fmtDate(summary.last_checked, { withTime: true })}
              {typeof summary.within_10pct === 'number' ? ` · ${fmtNum(summary.within_10pct)} of ${fmtNum(summary.n ?? checks.length)} pairs within ±10%` : ''}
            </span>
          ) : undefined
        }
      >
        {checks.length === 0 ? (
          action ? (
            <CrossCheckCta action={action} />
          ) : (
            <p className="py-8 text-center text-sm text-muted">
              No cross-checks yet. An administrator runs the UN Comtrade connector from the Sources tab to compare BACI with Comtrade.
            </p>
          )
        ) : (
          <div className="grid gap-6 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-5">
              <StatGrid cols={2}>
                <KpiTile label="Pairs compared" value={fmtNum(checks.length)} accent="ink" size="md" />
                <KpiTile label="Median absolute gap" value={medianAbs === null ? null : fmtPct(medianAbs)} accent="brand" />
              </StatGrid>
              {scatter ? <EChart option={scatter} height={300} className="mt-4" ariaLabel="Scatter of BACI against UN Comtrade values on logarithmic axes" /> : null}
              <p className="mt-2 text-xs text-muted">Points on the dashed line agree exactly; both axes are logarithmic.</p>
            </div>
            <div className="min-w-0 xl:col-span-7">
              <DataTable
                columns={checkCols}
                rows={checks}
                rowKey={(x) => `${x.hs6}-${x.year}-${x.flow}`}
                defaultSort={{ key: 'diff', order: 'desc' }}
                pagination={{ mode: 'client', pageSize: 10, pageSizeOptions: [10, 25, 50] }}
                maxHeight={null}
                dense
                csvFilename="baci-vs-comtrade"
              />
            </div>
          </div>
        )}
      </Card>
      <p className="text-xs text-muted">
        Coverage and quality figures are recomputed on every database build.
      </p>
    </div>
  );
}
