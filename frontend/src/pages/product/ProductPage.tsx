/**
 * ProductPage (`/product/:hsn8`) - everything the Atlas knows about one 8-digit national tariff line
 * (docs/SPEC.md section 6.3 ProductDetail, section 8):
 *
 * - Header: HS hierarchy breadcrumb, description, primary / secondary ministry pills, sector pill,
 *   mapping status with provenance; actions: watchlist (signed-in users), raise a query (helpdesk),
 *   download report (PDF / XLSX / CSV), ask the assistant.
 * - KPI row with provenance: exports, imports, trade balance, world market, India's share, RCA,
 *   India's supplier rank, BCD / MFN tariff.
 * - Trade trend 2018-2024 with the 2025-26 forecast band (model estimate) and the trade structure
 *   (sources, destinations, concentration, growth) beside the model scores and archetype.
 * - World top suppliers (India highlighted, rank) and markets; India's destinations and sources.
 * - Value-chain context (chains, stages, inline flow diagram, upstream / downstream), classification
 *   and ownership (hierarchy, mapping rule and confidence, schemes).
 * - DGFT ITC-HS import / export policy (public portal), with explicit not-listed / not-specified states.
 * - Data-quality score with production, sibling lines.
 *
 * Invalid codes and unknown lines render a proper "not found" state with ways forward.
 */
import { useParams } from 'react-router';
import clsx from 'clsx';
import { SearchX } from 'lucide-react';
import { isApiError, normalizeCode } from '@/api/client';
import type { Provenance } from '@/api/types';
import { Button, Card, EmptyState, ErrorState, HsnSearchBox, LoadingBlock, PageHeader } from '@/components';
import { fmtCode } from '@/lib/format';
import { routes } from '@/lib/routes';
import { tradeProvenance } from '@/pages/explore/shared';
import { useProduct } from './api';
import { AlertsBanner } from './components/AlertsBanner';
import { ClassificationCard } from './components/ClassificationCard';
import { CountryPanels } from './components/CountryPanels';
import { DataQualityCard } from './components/EvidencePanels';
import { ProductHeader } from './components/ProductHeader';
import { ProductInsight } from './components/ProductInsight';
import { ProductKpis } from './components/ProductKpis';
import { ScoresPanel } from './components/ScoresPanel';
import { SiblingsCard } from './components/SiblingsCard';
import { TradePolicyCard } from './components/TradePolicyCard';
import { TradeStructure } from './components/TradeStructure';
import { TrendChart } from './components/TrendChart';
import { ValueChainContext } from './components/ValueChainContext';
import { alertsOf, tradeOf } from './extras';

function ProductNotFound({ code }: { code: string }) {
  const digits = code.replace(/\D/g, '');
  const valid = /^\d{8}$/.test(digits);
  const prefix = digits.slice(0, digits.length >= 6 ? 6 : 4);
  return (
    <>
      <PageHeader
        title={valid ? `HSN ${fmtCode(digits)} is not in the Atlas` : 'Not a valid 8-digit HSN line'}
        documentTitle="Product not found"
        breadcrumbs={[{ label: 'HSN Explorer', to: routes.explore() }, { label: code || 'Product' }]}
      />
      <Card>
        <EmptyState
          icon={SearchX}
          title={valid ? 'No national tariff line with this code' : `"${code}" is not an 8-digit code`}
          message={
            valid
              ? 'The Atlas covers the 8-digit lines of the GST HSN master whose subheading exists in HS 2022. The code may be obsolete or mistyped.'
              : 'Product pages exist for 8-digit national lines such as 6109.10.00. Search for the product or browse its heading instead.'
          }
          action={
            <div className="flex w-full max-w-md flex-col items-center gap-3">
              <HsnSearchBox placeholder="Search another HSN code or product…" autoFocus size="lg" className="w-full" />
              <div className="flex flex-wrap justify-center gap-2">
                {prefix.length >= 4 ? (
                  <Button to={routes.explore({ q: prefix })} size="sm">
                    Browse {fmtCode(prefix)} in the Explorer
                  </Button>
                ) : null}
                <Button to={routes.overview()} size="sm" variant="ghost">
                  Back to the Guidebook dashboard
                </Button>
              </div>
            </div>
          }
        />
      </Card>
    </>
  );
}

export default function ProductPage() {
  const { hsn8: raw = '' } = useParams();
  const hsn8 = normalizeCode(decodeURIComponent(raw));
  const valid = /^\d{8}$/.test(hsn8);
  const q = useProduct(hsn8, valid);

  if (!valid) return <ProductNotFound code={raw} />;
  if (q.isPending) return <LoadingBlock label={`Loading HSN ${fmtCode(hsn8)}…`} height={420} />;
  if (q.isError && !q.data) {
    if (isApiError(q.error) && q.error.isNotFound) return <ProductNotFound code={hsn8} />;
    return (
      <>
        <PageHeader title={`HSN ${fmtCode(hsn8)}`} breadcrumbs={[{ label: 'HSN Explorer', to: routes.explore() }, { label: fmtCode(hsn8) }]} />
        <Card>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} roles={['industry', 'analyst', 'ministry', 'admin']} />
        </Card>
      </>
    );
  }

  const p = q.data;
  const tradeProv: Provenance = p.trade?.provenance ?? tradeProvenance(null);
  // Data quality and sibling lines share the last row.
  const evidenceCards = 1 + (p.siblings.length ? 1 : 0);

  return (
    <div className="space-y-4 sm:space-y-6">
      <ProductHeader p={p} />
      <AlertsBanner alerts={alertsOf(p)} />
      <ProductKpis p={p} />
      <ProductInsight p={p} />

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 sm:space-y-6 xl:col-span-2">
          <TrendChart series={p.series} forecast={p.scores?.forecast} provenance={tradeProv} />
          <TradeStructure trade={tradeOf(p)} series={p.series} sources={p.top_sources} destinations={p.top_destinations} provenance={tradeProv} />
        </div>
        <div className="min-w-0">
          <ScoresPanel scores={p.scores} rca={p.trade?.rca ?? p.rca} />
        </div>
      </div>

      <CountryPanels
        trade={p.trade}
        provenance={tradeProv}
        worldSuppliers={p.world_top_suppliers}
        worldMarkets={p.world_top_markets}
        destinations={p.top_destinations}
        sources={p.top_sources}
      />

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <ValueChainContext hsn8={p.hsn8} description={p.description} chains={p.value_chains} upstream={p.upstream} downstream={p.downstream} />
        </div>
        <div className="min-w-0">
          <ClassificationCard p={p} />
        </div>
      </div>

      <TradePolicyCard policy={p.trade_policy} />

      <div className={clsx('grid gap-4 sm:gap-6 lg:grid-cols-2', evidenceCards === 2 && 'xl:grid-cols-2')}>
        <DataQualityCard p={p} />
        {p.siblings.length ? <SiblingsCard hs6={p.hs6} siblings={p.siblings} currentMinistry={p.ministry_short} /> : null}
      </div>
    </div>
  );
}
