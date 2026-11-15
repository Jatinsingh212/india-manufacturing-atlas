/**
 * MinistryPage - `/ministry/:id`, the ministry-specific dashboard: HSN codes, trade performance,
 * domestic production and value-chain linkages.
 *
 * Data: GET /api/ministries/{id} (SPEC 6.4) for the dashboard, GET /api/ministries/{id}/products for the
 * full product table, /api/meta/overview for provenance (shared cache), /api/meta/ministries for the
 * ministry switcher. Header: name, parent ministry, website, kind, mapping caveat, Ask Atlas and
 * Download report (PDF / XLSX / CSV via /api/reports/ministry/{id}).
 */
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ExternalLink, Landmark, MessageCircleQuestion, TriangleAlert } from 'lucide-react';
import { isApiError } from '@/api/client';
import { useMinistries } from '@/api/hooks';
import { Badge, Button, DownloadMenu, ErrorState, LoadingBlock, PageHeader, Select, Tooltip, useAssistant } from '@/components';
import { humanize } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useAtlasProvenance, useMinistryDashboard } from './api';
import { EntityDashboardBody, type MixRow } from './components/EntityDashboard';
import { LabelledProvenance } from './components/LabelledProvenance';

export default function MinistryPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const assistant = useAssistant();
  const query = useMinistryDashboard(id);
  const { trade, mapping } = useAtlasProvenance();
  const { data: ministries } = useMinistries();

  const options = useMemo(
    () => (ministries ?? []).map((m) => ({ value: m.id, label: m.id === 'residual' ? m.name : `${m.short_name} · ${m.name}` })),
    [ministries],
  );

  const d = query.data;
  const sectorRows = useMemo<MixRow[]>(
    () => (d?.sector_mix ?? []).map((s) => ({ id: s.sector_id, label: s.name, codes: s.codes, exports: s.exports, imports: s.imports })),
    [d?.sector_mix],
  );

  if (query.isPending) {
    return (
      <>
        <PageHeader eyebrow="Ministry dashboard" title="Loading ministry…" icon={Landmark} breadcrumbs={[{ label: 'Ministries', to: routes.ministries() }, { label: id }]} />
        <LoadingBlock label="Loading the ministry dashboard…" height={320} />
      </>
    );
  }
  if (query.isError || !d) {
    const notFound = isApiError(query.error) && query.error.isNotFound;
    return (
      <>
        <PageHeader
          eyebrow="Ministry dashboard"
          title={notFound ? 'Ministry not found' : 'Ministry dashboard'}
          icon={Landmark}
          breadcrumbs={[{ label: 'Ministries', to: routes.ministries() }, { label: id }]}
        />
        <ErrorState
          error={query.error}
          title={notFound ? `No ministry with id “${id}”` : undefined}
          onRetry={() => void query.refetch()}
          roles="gov"
        />
        {notFound ? (
          <div className="mt-2 flex justify-center">
            <Button to={routes.ministries()} variant="primary" size="sm">
              Browse all ministries
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  const m = d.ministry;
  const residual = m.id === 'residual' || m.kind === 'residual';
  const subject = residual ? 'residual (unassigned) products' : `products owned by ${m.short_name}`;

  return (
    <>
      <PageHeader
        eyebrow={residual ? 'Residual products' : 'Ministry dashboard'}
        title={m.name}
        icon={Landmark}
        iconColor={m.color}
        breadcrumbs={[{ label: 'Ministries', to: routes.ministries() }, { label: m.short_name }]}
        subtitle={
          residual
            ? 'HSN codes that the DPIIT Guidebook lists as residual or does not list at all.'
            : m.parent_ministry && m.parent_ministry !== m.name
              ? `${m.parent_ministry}`
              : 'Ministry of the Government of India'
        }
        meta={
          <>
            <Badge tone="outline">{humanize(m.kind)}</Badge>
            {m.website ? (
              <a href={m.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink hover:underline">
                {m.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}
            <LabelledProvenance label="Ministry mapping" provenance={mapping} />
          </>
        }
        actions={
          <>
            {options.length ? (
              <Select
                aria-label="Switch ministry"
                size="sm"
                value={m.id}
                onChange={(v) => v && navigate(routes.ministry(v))}
                options={options}
                className="w-56"
              />
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              icon={MessageCircleQuestion}
              onClick={() => assistant.open(`Summarise the HS codes, trade performance and import dependencies of ${m.name}.`)}
            >
              Ask Atlas
            </Button>
            <DownloadMenu kind="ministry" id={m.id} variant="primary" />
          </>
        }
      />

      <EntityDashboardBody
        kind="ministry"
        id={m.id}
        name={m.name}
        subject={subject}
        data={d}
        trade={trade}
        mapping={mapping}
        residual={residual}
        mix={{
          title: 'Sector mix',
          subtitle: `Broad industrial sectors of the ${residual ? 'residual' : 'ministry’s'} products`,
          rows: sectorRows,
          onSelect: (r) => navigate(routes.sector(r.id)),
          emptyText: 'No sector breakdown available',
        }}
      >
        <MappingNote residual={residual} />
      </EntityDashboardBody>
    </>
  );
}

/** Plain-language caveat required by SPEC "Data honesty rules". */
function MappingNote({ residual }: { residual: boolean }) {
  const detail = residual
    ? 'Residual lines are those the DPIIT Guidebook (16.12.2025 revision) lists without an accepted ministry, plus lines absent from both Guidebook tables. They stay residual until an official upload or approved claim assigns an owner.'
    : 'Ownership is the official DPIIT Guidebook on HSN Code Mapping (16.12.2025 revision). Where several ministries accept a code, all owners are recorded and the first-listed owner is primary. No rule-based owner is substituted.';
  return (
    <p className="flex items-center gap-1.5 text-[12.5px] text-warn-ink">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {residual ? 'Lines waiting for an owning ministry.' : 'Official DPIIT Guidebook ownership.'}
      <Tooltip content={detail} maxWidth={340}>
        <span className="cursor-help font-medium underline decoration-dotted underline-offset-2">How it works</span>
      </Tooltip>
    </p>
  );
}
