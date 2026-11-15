/**
 * SectorPage - `/sector/:id`, the broad-sector dashboard. Same pattern as the ministry dashboard
 * (pages/ministries/components/EntityDashboard) with a ministry mix instead of a sector mix, so an
 * official can see which ministries own a sector's HSN codes and how the sector trades.
 *
 * Data: GET /api/sectors/{id} (SPEC 6.4, `sector` + `ministry_mix`), GET /api/sectors/{id}/products,
 * /api/meta/sectors for the sector switcher, /api/meta/overview for provenance. The sector report
 * (/api/reports/sector/{id}) is sign-in only, so the header shows "Sign in to download" to the public.
 */
import { useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Boxes, Download, MessageCircleQuestion } from 'lucide-react';
import { isApiError } from '@/api/client';
import { useSectors } from '@/api/hooks';
import { useAuth } from '@/auth';
import { Badge, Button, DownloadMenu, ErrorState, LoadingBlock, PageHeader, Select, useAssistant } from '@/components';
import { iconByName } from '@/lib/icons';
import { routes } from '@/lib/routes';
import { sectorColor } from '@/lib/theme';
import { useAtlasProvenance, useSectorDashboard, type KpiExtras } from '@/pages/ministries/api';
import { EntityDashboardBody, type MixRow } from '@/pages/ministries/components/EntityDashboard';
import { LabelledProvenance } from '@/pages/ministries/components/LabelledProvenance';

export default function SectorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const assistant = useAssistant();
  // SPEC section 5: sector reports need a signed-in user (product / ministry / value-chain reports are public),
  // so an anonymous visitor gets a sign-in link instead of a download that would fail with 401.
  const { isAuthenticated, loading: authLoading } = useAuth();
  const query = useSectorDashboard(id);
  const { trade, mapping } = useAtlasProvenance();
  const { data: sectors } = useSectors();

  const options = useMemo(() => (sectors ?? []).map((s) => ({ value: s.id, label: s.name })), [sectors]);
  const d = query.data;
  const ministryRows = useMemo<MixRow[]>(
    () =>
      (d?.ministry_mix ?? []).map((m) => ({
        id: m.ministry_id,
        label: m.ministry_id === 'residual' ? 'Residual' : m.short_name,
        codes: m.codes,
        exports: m.exports,
        imports: m.imports,
        muted: m.ministry_id === 'residual',
      })),
    [d?.ministry_mix],
  );
  const crumbs = [{ label: 'Atlas', to: routes.overview() }, { label: 'Sectors' }];

  if (query.isPending) {
    return (
      <>
        <PageHeader eyebrow="Sector dashboard" title="Loading sector…" icon={Boxes} breadcrumbs={[...crumbs, { label: id }]} />
        <LoadingBlock label="Loading the sector dashboard…" height={320} />
      </>
    );
  }
  if (query.isError || !d) {
    const notFound = isApiError(query.error) && query.error.isNotFound;
    return (
      <>
        <PageHeader eyebrow="Sector dashboard" title={notFound ? 'Sector not found' : 'Sector dashboard'} icon={Boxes} breadcrumbs={[...crumbs, { label: id }]} />
        <ErrorState error={query.error} title={notFound ? `No sector with id “${id}”` : undefined} onRetry={() => void query.refetch()} />
        {notFound && options.length ? (
          <div className="mx-auto mt-2 max-w-xs">
            <Select aria-label="Choose a sector" value="" placeholder="Choose a sector…" onChange={(v) => v && navigate(routes.sector(v))} options={options} />
          </div>
        ) : null}
      </>
    );
  }

  const s = d.sector;
  // the API counts the owning ministries (kpis.ministries_covered); the mix rows are the fallback
  const covered = (d.kpis as typeof d.kpis & KpiExtras).ministries_covered;
  const owners = typeof covered === 'number' ? covered : ministryRows.filter((r) => r.id !== 'residual' && r.codes > 0).length;

  return (
    <>
      <PageHeader
        eyebrow="Sector dashboard"
        title={s.name}
        icon={iconByName(s.icon)}
        iconColor={sectorColor(s.id, s.color)}
        breadcrumbs={[...crumbs, { label: s.name }]}
        subtitle={s.description ?? undefined}
        meta={
          <>
            {s.chapters?.length ? (
              <Badge tone="outline" title="HS chapters assigned to this sector (heading-level exceptions apply)">
                HS chapters {s.chapters.join(', ')}
              </Badge>
            ) : null}
            <LabelledProvenance label="Ministry mapping" provenance={mapping} />
          </>
        }
        actions={
          <>
            {options.length ? (
              <Select aria-label="Switch sector" size="sm" value={s.id} onChange={(v) => v && navigate(routes.sector(v))} options={options} className="w-52" />
            ) : null}
            <Button size="sm" variant="secondary" icon={MessageCircleQuestion} onClick={() => assistant.open(`What are the export opportunities and import dependencies in the ${s.name} sector?`)}>
              Ask Atlas
            </Button>
            {isAuthenticated ? (
              <DownloadMenu kind="sector" id={s.id} variant="primary" />
            ) : authLoading ? null : (
              <Button
                size="sm"
                variant="primary"
                icon={Download}
                to={routes.login(`${location.pathname}${location.search}`)}
                title="Sector reports (PDF / XLSX / CSV) need a free sign-in; product, ministry and value-chain reports are public"
              >
                Sign in to download
              </Button>
            )}
          </>
        }
      />

      <EntityDashboardBody
        kind="sector"
        id={s.id}
        name={s.name}
        subject={`${s.name} products`}
        data={d}
        trade={trade}
        mapping={mapping}
        ministriesInvolved={owners}
        mix={{
          title: 'Ministry mix',
          subtitle: 'Ministries and departments that own the sector’s HSN codes',
          rows: ministryRows,
          onSelect: (r) => navigate(routes.ministry(r.id)),
          emptyText: 'No ministry breakdown available',
        }}
      />
    </>
  );
}
