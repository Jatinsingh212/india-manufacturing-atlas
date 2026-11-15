/**
 * OverviewKpis - the headline KPI strip (magenta numerals).
 *
 * Row 1: HSN lines mapped, residual lines, ministries assigned and the trade headline (India exports,
 * India imports, trade balance; DGCIS TRADESTAT, latest financial year).
 *
 * Provenance: code counts come from the GST HSN master (verified); accepted / residual / ministry
 * counts depend on the mapping (provenance.mapping from the API - DPIIT Guidebook mapping is
 * Verified, residual lines are not); trade figures use provenance.trade.
 */
import { CircleHelp, Hash, Landmark, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import type { OverviewResponse, Provenance } from '@/api/types';
import { ErrorState, KpiTile, StatGrid } from '@/components';
import { fmtNum, fmtPct, fmtUSD } from '@/lib/format';
import { routes } from '@/lib/routes';

const NOMENCLATURE_PROVENANCE: Provenance = {
  source: 'gst_master',
  status: 'verified',
  label: 'GST HSN master (8-digit lines whose HS6 exists in HS 2022)',
  year: null,
};

function share(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (typeof part !== 'number' || typeof whole !== 'number' || whole <= 0) return null;
  return part / whole;
}

export interface OverviewKpisProps {
  data: OverviewResponse | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}

export function OverviewKpis({ data, loading, error, onRetry }: OverviewKpisProps) {
  if (!data && !loading && error) {
    return (
      <div className="rounded-xl border border-line bg-surface shadow-card">
        <ErrorState error={error} onRetry={onRetry} compact title="The headline figures could not be loaded" />
      </div>
    );
  }
  const k = data?.kpis;
  const year = k?.latest_year ?? 2024;
  const mappingProv = data?.provenance.mapping ?? null;
  const tradeProv = data?.provenance.trade ?? null;
  const balance = typeof k?.india_exports === 'number' && typeof k?.india_imports === 'number' ? k.india_exports - k.india_imports : null;
  const exportShare = share(k?.india_exports, k?.world_trade);
  const importShare = share(k?.india_imports, k?.world_trade);

  // One row, six numbers, each said once: the register and the trade headline.
  return (
    <StatGrid cols={6}>
      <KpiTile
        label="HSN lines mapped"
        value={k ? fmtNum(k.total_codes) : null}
        icon={Hash}
        loading={loading && !data}
        sub="8-digit national tariff lines"
        provenance={NOMENCLATURE_PROVENANCE}
        hint="Every current 8-digit national tariff line in the Atlas (GST HSN master lines whose HS6 subheading exists in HS 2022)."
        to={routes.explore()}
      />
      <KpiTile
        label="Residual (no owner)"
        value={k ? fmtNum(k.residual_codes) : null}
        icon={CircleHelp}
        accent="bad"
        loading={loading && !data}
        sub="No owning ministry yet"
        provenance={mappingProv}
        hint="Lines without a clear owner."
        to={routes.ministry('residual')}
      />
      <KpiTile
        label="Ministries"
        value={k ? fmtNum(k.ministries_assigned) : null}
        icon={Landmark}
        loading={loading && !data}
        sub="Own at least one HSN line"
        provenance={mappingProv}
        hint="Ministries and departments of the Government of India that own at least one HSN line."
        to={routes.ministries()}
      />
      <KpiTile
        label={`Exports ${year}`}
        value={k ? fmtUSD(k.india_exports) : null}
        icon={TrendingUp}
        accent="brand"
        loading={loading && !data}
        sub={exportShare !== null ? `${fmtPct(exportShare)} of world` : undefined}
        provenance={tradeProv}
        hint="India's merchandise exports, FY2024-25 (April-March), official DGCIS TRADESTAT; the world share uses CEPII BACI world trade."
      />
      <KpiTile
        label={`Imports ${year}`}
        value={k ? fmtUSD(k.india_imports) : null}
        icon={TrendingDown}
        accent="brand"
        loading={loading && !data}
        sub={importShare !== null ? `${fmtPct(importShare)} of world` : undefined}
        provenance={tradeProv}
        hint="India's merchandise imports, FY2024-25 (April-March), official DGCIS TRADESTAT; the world share uses CEPII BACI world trade."
      />
      <KpiTile
        label="Trade balance"
        value={balance !== null ? fmtUSD(balance, { signed: true }) : null}
        icon={Scale}
        accent={balance === null ? 'ink' : balance >= 0 ? 'ok' : 'bad'}
        loading={loading && !data}
        sub={balance !== null ? (balance >= 0 ? 'Surplus' : 'Deficit') : undefined}
        provenance={tradeProv}
        hint="Exports minus imports across all HS6 subheadings."
      />
    </StatGrid>
  );
}