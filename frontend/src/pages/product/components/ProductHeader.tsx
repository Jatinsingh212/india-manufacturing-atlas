/**
 * ProductHeader - title block of the product page: HS hierarchy breadcrumb (section > chapter >
 * heading > subheading > line), the line's description, primary / secondary ministry pills, sector
 * pill, mapping status with its provenance, and the actions (watchlist, raise a query, download report,
 * ask the assistant).
 */
import { useLocation } from 'react-router';
import { Package, Sparkles, Star, StarOff } from 'lucide-react';
import type { HierarchyNode, ProductDetail } from '@/api/types';
import { useAuth } from '@/auth';
import { Badge, Button, DownloadMenu, MinistryPill, PageHeader, ProvenanceBadge, SectorPill, useAssistant, type Crumb } from '@/components';
import { fmtCode } from '@/lib/format';
import { routes } from '@/lib/routes';
import { ministryColor } from '@/lib/theme';
import { mappingProvenance } from '@/pages/explore/shared';
import { useWatchlist, useWatchToggle } from '../api';

function crumbFor(h: HierarchyNode): Crumb {
  const label = h.level === 0 ? `Section ${h.code}` : h.level === 2 ? `Chapter ${h.code}` : fmtCode(h.code);
  const to =
    h.level === 0
      ? `${routes.explore()}?code=${encodeURIComponent(h.code)}`
      : h.level === 2
        ? `${routes.explore()}?chapter=${h.code}&code=${h.code}`
        : routes.explore({ q: h.code });
  return { label: <span title={h.description}>{label}</span>, to };
}

/** Watchlist toggle for signed-in users; a sign-in link otherwise. */
function WatchButton({ hsn8 }: { hsn8: string }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  const wl = useWatchlist(isAuthenticated);
  const toggle = useWatchToggle(hsn8);
  if (loading) return null;
  if (!isAuthenticated) {
    return (
      <Button to={routes.login(`${location.pathname}${location.search}`)} icon={Star} title="Sign in to keep a watchlist of products">
        Watch
      </Button>
    );
  }
  const watching = Boolean(wl.data?.some((p) => p.hsn8 === hsn8));
  return (
    <Button
      icon={watching ? StarOff : Star}
      variant={watching ? 'accent' : 'secondary'}
      loading={toggle.isPending || (wl.isPending && wl.fetchStatus !== 'idle')}
      onClick={() => toggle.mutate(watching)}
      aria-pressed={watching}
      title={watching ? 'Remove from your watchlist' : 'Add to your watchlist'}
    >
      {watching ? 'Watching' : 'Watch'}
    </Button>
  );
}

export function ProductHeader({ p }: { p: ProductDetail }) {
  const assistant = useAssistant();
  const primary = p.ministries.find((m) => m.role === 'primary') ?? {
    id: p.ministry_id,
    short_name: p.ministry_short ?? p.ministry_id,
    name: p.ministry_name ?? p.ministry_id,
    color: null,
    role: 'primary',
  };
  const secondary = p.ministries.filter((m) => m.role !== 'primary');
  const levels = [...p.hierarchy].sort((a, b) => a.level - b.level);
  const status = p.mapping?.status ?? p.mapping_status;
  const mapProv = p.mapping?.provenance ?? mappingProvenance(p.mapping_source, status);
  // The full nomenclature text often just repeats the title after the heading text; show it only when it adds something.
  const full = p.full_description?.trim() ?? '';
  const subtitle = full && !full.toLowerCase().includes(p.description.trim().toLowerCase()) ? full : undefined;

  return (
    <PageHeader
      eyebrow={`Tariff line ${fmtCode(p.hsn8)} · HS 2022`}
      title={p.description}
      documentTitle={`${fmtCode(p.hsn8)} ${p.description}`}
      icon={Package}
      iconColor={ministryColor(primary.id, primary.color)}
      breadcrumbs={[{ label: 'HSN Explorer', to: routes.explore() }, ...levels.map(crumbFor), { label: <span className="font-mono">{fmtCode(p.hsn8)}</span> }]}
      subtitle={subtitle}
      meta={
        <>
          <MinistryPill ministry={primary} full size="md" />
          {secondary.map((m) => (
            <MinistryPill key={m.id} ministry={m} role={m.role} size="sm" />
          ))}
          {p.sector_id ? <SectorPill sector={{ id: p.sector_id, name: p.sector_name }} size="md" /> : null}
          <Badge tone={status === 'residual' ? 'orange' : 'success'} size="md">
            {status === 'residual' ? 'Residual - no clear owner' : 'Accepted mapping'}
          </Badge>
          {p.scores?.product_readiness_index != null ? (
            <Badge
              tone={p.scores.product_readiness_index >= 75 ? 'success' : p.scores.product_readiness_index >= 50 ? 'info' : 'warning'}
              size="md"
            >
              PRI: {p.scores.product_readiness_index.toFixed(1)}/100 · {p.scores.readiness_tier}
            </Badge>
          ) : null}
          <ProvenanceBadge provenance={mapProv} showSource />
        </>
      }
      actions={
        <>
          <WatchButton hsn8={p.hsn8} />
          <DownloadMenu kind="product" id={p.hsn8} />
          <Button
            icon={Sparkles}
            variant="ghost"
            onClick={() => assistant.open(`Summarise HSN ${p.hsn8} (${p.description}): owning ministry, trade, dependency and opportunities.`)}
          >
            Ask Atlas
          </Button>
        </>
      }
    />
  );
}
