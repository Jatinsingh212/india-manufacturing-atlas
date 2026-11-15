/**
 * MinistriesPage - `/ministries`, the index of the 31 ministries / departments that own HSN codes plus
 * the residual bucket (GET /api/meta/ministries, SPEC 6.2).
 *
 * - KPI row: ministries assigned, codes mapped, accepted, residual - live counts.
 * - "HS codes by ministry" ranked bars (codes / exports / imports).
 * - A searchable, sortable table (or card grid) with codes, accepted, exports, imports and share bars.
 *   Rows and cards open /ministry/:id.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import clsx from 'clsx';
import { ArrowRight, Building2, ChartColumn, CircleCheck, ExternalLink, Hash, Landmark, LayoutGrid, Rows3, SearchX, Users } from 'lucide-react';
import { useMinistries } from '@/api/hooks';
import type { MinistryListItem, Provenance } from '@/api/types';
import { Badge, Card, DataTable, EChart, EmptyState, ErrorState, KpiTile, LoadingBlock, MinistryPill, PageHeader, SearchInput, SegmentedControl, StatGrid, Tooltip, type Column } from '@/components';
import { fmtNum, fmtUSD, humanize, NA_SHORT } from '@/lib/format';
import { useLocalStorage } from '@/lib/hooks';
import { routes } from '@/lib/routes';
import { ministryColor } from '@/lib/theme';
import { useTheme } from '@/theme/ThemeContext';
import { useAtlasProvenance } from './api';
import { barChartHeight, rankedBarOption, type BarRow } from './charts';
import { LabelledProvenance } from './components/LabelledProvenance';
import { ShareBar } from './components/ShareBar';
import { fmtShare, matchesQuery, maxOf, sumOf } from './utils';

type Metric = 'codes' | 'exports' | 'imports';
type View = 'table' | 'cards';

export default function MinistriesPage() {
  const query = useMinistries();
  const { trade, mapping } = useAtlasProvenance();

  return (
    <>
      <PageHeader
        eyebrow="Atlas"
        title="Ministries & departments"
        icon={Landmark}
        subtitle="The 31 ministries and departments of the Government of India that own HSN codes,, plus the residual bucket of unassigned codes."
        meta={<LabelledProvenance label="Ministry mapping" provenance={mapping} />}
      />
      {query.isPending ? (
        <LoadingBlock label="Loading ministries…" height={320} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data?.length ? (
        <EmptyState icon={Landmark} title="No ministries loaded" message="The ministry register is empty; rebuild the Atlas database." />
      ) : (
        <MinistriesBody rows={query.data} trade={trade} mapping={mapping} />
      )}
    </>
  );
}

function MinistriesBody({ rows, trade, mapping }: { rows: MinistryListItem[]; trade: Provenance; mapping: Provenance }) {
  const navigate = useNavigate();
  const { mode } = useTheme();
  const [metric, setMetric] = useState<Metric>('codes');
  const [scope, setScope] = useState<'top' | 'all'>('top');
  const [q, setQ] = useState('');
  const [view, setView] = useLocalStorage<View>('atlas.ministries.view', 'table');

  const owners = useMemo(() => rows.filter((r) => r.id !== 'residual'), [rows]);
  const residual = rows.find((r) => r.id === 'residual') ?? null;
  const totalCodes = sumOf(rows, (r) => r.codes) ?? 0;
  const accepted = sumOf(owners, (r) => r.accepted) ?? 0;
  const assigned = owners.filter((r) => r.codes > 0).length;
  const totals = { codes: totalCodes, exports: sumOf(rows, (r) => r.exports), imports: sumOf(rows, (r) => r.imports) };

  // ---- chart
  const bars = useMemo<BarRow[]>(() => {
    const val = (r: MinistryListItem) => (metric === 'codes' ? r.codes : r[metric]);
    const sorted = [...rows].sort((a, b) => (val(b) ?? 0) - (val(a) ?? 0));
    const shown = scope === 'top' ? sorted.slice(0, 12) : sorted;
    return shown.map((r) => ({
      id: r.id,
      label: r.id === 'residual' ? 'Residual' : r.short_name,
      value: val(r),
      muted: r.id === 'residual',
    }));
  }, [rows, metric, scope]);
  const option = useMemo(() => {
    const format = metric === 'codes' ? (v: number) => fmtNum(v) : (v: number) => fmtUSD(v, { sig: 2 });
    return rankedBarOption({
      rows: bars,
      mode,
      format,
      seriesName: metric === 'codes' ? 'HS codes (Atlas)' : metric === 'exports' ? 'India exports' : 'India imports',
      labelWidth: 90,
    });
  }, [bars, mode, metric]);

  // ---- table / cards
  const filtered = useMemo(() => rows.filter((r) => matchesQuery(q, r.short_name, r.name, r.parent_ministry, r.id)), [rows, q]);
  const max = { codes: maxOf(owners, (r) => r.codes), exports: maxOf(owners, (r) => r.exports), imports: maxOf(owners, (r) => r.imports) };

  const columns = useMemo<Column<MinistryListItem>[]>(
    () => [
      {
        key: 'name',
        header: 'Ministry / department',
        sticky: true,
        value: (r) => r.name,
        render: (r) => (
          <div className="flex w-[18rem] max-w-[70vw] items-start gap-2.5 whitespace-normal">
            <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: ministryColor(r.id, r.color) }} aria-hidden />
            <div className="min-w-0">
              <div className="font-semibold text-ink">
                {r.name}
                <span className="ml-1.5 text-xs font-normal text-muted">{r.id === 'residual' ? '' : r.short_name}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                {r.id === 'residual' ? (
                  <Badge tone="warning" size="xs">
                    Unassigned codes
                  </Badge>
                ) : (
                  <span className="shrink-0">{humanize(r.kind)}</span>
                )}
                {r.parent_ministry && r.parent_ministry !== r.name ? <span className="truncate">· {r.parent_ministry}</span> : null}
              </div>
            </div>
          </div>
        ),
      },
      {
        key: 'codes',
        header: 'HS codes',
        align: 'right',
        hint: 'Number of 8-digit lines assigned (primary owner) and share of all lines',
        value: (r) => r.codes,
        render: (r) => <ShareBar value={r.codes} max={max.codes} total={totals.codes} format={(v) => fmtNum(v)} muted={r.id === 'residual'} />,
      },
      { key: 'accepted', header: 'Accepted', align: 'right', hideBelow: 'md', value: (r) => r.accepted, render: (r) => fmtNum(r.accepted) },
      {
        key: 'exports',
        header: 'Exports',
        align: 'right',
        hint: "India's exports of the owned lines, latest year (US$) and share of the total",
        value: (r) => r.exports,
        render: (r) => <ShareBar value={r.exports} max={max.exports} total={totals.exports} format={(v) => fmtUSD(v, { sig: 3 })} muted={r.id === 'residual'} />,
      },
      {
        key: 'imports',
        header: 'Imports',
        align: 'right',
        hint: "India's imports of the owned lines, latest year (US$) and share of the total",
        value: (r) => r.imports,
        render: (r) => <ShareBar value={r.imports} max={max.imports} total={totals.imports} format={(v) => fmtUSD(v, { sig: 3 })} muted={r.id === 'residual'} />,
      },
      {
        key: 'website',
        header: 'Site',
        align: 'center',
        width: 52,
        hideBelow: 'lg',
        csvHeader: 'Website',
        csv: (r) => r.website,
        render: (r) =>
          r.website ? (
            <Tooltip content={r.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}>
              <a
                href={r.website}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex size-7 items-center justify-center rounded-md text-brand-ink hover:bg-brand-soft"
                aria-label={`${r.name} website (opens in a new tab)`}
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </Tooltip>
          ) : (
            <span className="text-muted">{NA_SHORT}</span>
          ),
      },
    ],
    [max.codes, max.exports, max.imports, totals.codes, totals.exports, totals.imports],
  );

  return (
    <div className="space-y-6">
      <StatGrid cols={4}>
        <KpiTile
          label="Ministries assigned"
          value={fmtNum(assigned)}
          icon={Building2}
          sub="Ministries and departments with codes"
          provenance={mapping}
        />
        <KpiTile
          label="Total HS codes mapped"
          value={fmtNum(totalCodes)}
          icon={Hash}
          sub="8-digit national tariff lines"
          provenance={mapping}
        />
        <KpiTile
          label="Accepted HS codes"
          value={fmtNum(accepted)}
          icon={CircleCheck}
          sub="Assigned to one owning ministry"
          provenance={mapping}
        />
        <KpiTile
          label="Residual HSN codes"
          value={residual ? fmtNum(residual.codes) : null}
          icon={Users}
          sub="No owning ministry yet"
          provenance={mapping}
          to={routes.ministry('residual')}
        />
      </StatGrid>
      <Card
        icon={ChartColumn}
        title="HS code distribution by ministry"
        subtitle={metric === 'codes' ? 'Number of 8-digit lines owned (primary owner)' : `India's ${metric} of the owned lines, US$, latest year`}
        actions={
          <>
            <SegmentedControl
              ariaLabel="Measure"
              size="xs"
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'codes', label: 'Codes' },
                { value: 'exports', label: 'Exports' },
                { value: 'imports', label: 'Imports' },
              ]}
            />
            <SegmentedControl
              ariaLabel="Rows shown"
              size="xs"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'top', label: 'Top 12' },
                { value: 'all', label: `All ${rows.length}` },
              ]}
            />
          </>
        }
        footer={
          <span className="flex flex-wrap items-center gap-2">
            {metric === 'codes' ? <LabelledProvenance label="Atlas counts" provenance={mapping} /> : <LabelledProvenance label="Trade" provenance={trade} />}
            <span>Click a bar to open the ministry.</span>
          </span>
        }
      >
        <EChart
          option={option}
          height={barChartHeight(bars.length, 24)}
          ariaLabel={`Bar chart: ${metric} by ministry`}
          onEvents={{
            click: (p: { dataIndex?: number }) => {
              const bar = typeof p.dataIndex === 'number' ? bars[p.dataIndex] : undefined;
              if (bar) navigate(routes.ministry(bar.id));
            },
          }}
        />
      </Card>

      <Card
        padding="sm"
        icon={Landmark}
        title="All ministries and departments"
        subtitle={`${fmtNum(owners.length)} owners and the residual bucket · click a row to open its dashboard`}
        actions={
          <SegmentedControl
            ariaLabel="View"
            size="xs"
            value={view}
            onChange={setView}
            options={[
              { value: 'table', label: <span className="inline-flex items-center gap-1"><Rows3 className="size-3.5" aria-hidden />Table</span>, title: 'Table view' },
              { value: 'cards', label: <span className="inline-flex items-center gap-1"><LayoutGrid className="size-3.5" aria-hidden />Cards</span>, title: 'Card view' },
            ]}
          />
        }
        footer={
          <span className="flex flex-wrap items-center gap-2">
            <LabelledProvenance label="Ministry mapping" provenance={mapping} />
            <LabelledProvenance label="Trade" provenance={trade} />
            <span>Trade values apportion each subheading's trade across its 8-digit lines, so ministry totals add up without double counting.</span>
          </span>
        }
      >
        <div className="mb-3">
          <SearchInput value={q} onChange={setQ} size="sm" placeholder="Search ministry, department or parent ministry…" className="w-full max-w-md" aria-label="Search ministries" />
        </div>
        {view === 'table' ? (
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(routes.ministry(r.id))}
            defaultSort={{ key: 'codes', order: 'desc' }}
            pagination={false}
            maxHeight="72vh"
            dense
            csvFilename="atlas-ministries"
            emptyIcon={SearchX}
            emptyTitle="No ministry matches this search"
            caption="Ministries and departments with HS codes, exports and imports"
          />
        ) : filtered.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {[...filtered]
              .sort((a, b) => b.codes - a.codes)
              .map((r) => (
                <MinistryCard key={r.id} m={r} maxCodes={max.codes} totalCodes={totals.codes} />
              ))}
          </div>
        ) : (
          <EmptyState compact icon={SearchX} title="No ministry matches this search" />
        )}
      </Card>
    </div>
  );
}

function MinistryCard({ m, maxCodes, totalCodes }: { m: MinistryListItem; maxCodes: number; totalCodes: number }) {
  const residual = m.id === 'residual';
  const color = ministryColor(m.id, m.color);
  return (
    <Link
      to={routes.ministry(m.id)}
      className={clsx(
        'group flex min-w-0 flex-col rounded-lg border border-line bg-surface p-3.5 transition-colors hover:border-brand/40 hover:bg-surface-2',
        residual && 'border-dashed',
      )}
      style={{ borderLeft: `4px solid ${color}` }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <MinistryPill ministry={m} link={false} size="xs" />
          <div className="mt-1.5 line-clamp-2 text-[13.5px] leading-snug font-semibold text-ink">{m.name}</div>
          {m.parent_ministry && m.parent_ministry !== m.name ? <div className="truncate text-xs text-muted">{m.parent_ministry}</div> : null}
        </div>
        <ArrowRight className="mt-1 size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand-ink" aria-hidden />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted">HS codes</dt>
          <dd className="text-[15px] font-bold text-kpi">{fmtNum(m.codes)}</dd>
        </div>
        <div>
          <dt className="text-muted">Exports</dt>
          <dd className="text-[13px] font-semibold text-ink">{fmtUSD(m.exports, { na: NA_SHORT })}</dd>
        </div>
        <div>
          <dt className="text-muted">Imports</dt>
          <dd className="text-[13px] font-semibold text-ink">{fmtUSD(m.imports, { na: NA_SHORT })}</dd>
        </div>
      </dl>
      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
          <span
            className="block h-full rounded-r-[4px]"
            style={{ width: `${maxCodes > 0 ? Math.max(1.5, (m.codes / maxCodes) * 100) : 0}%`, backgroundColor: residual ? 'var(--atlas-line-strong)' : 'var(--atlas-series-1)' }}
          />
        </span>
        <span className="shrink-0 atlas-num">{totalCodes > 0 ? `${fmtShare(m.codes / totalCodes)} of all codes` : NA_SHORT}</span>
      </div>
    </Link>
  );
}
