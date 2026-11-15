/**
 * CountryPanels - the four partner views of the product:
 * world top suppliers (India highlighted, "India ranks Nth of M suppliers"), world top markets,
 * India's top export destinations and India's top import sources. Ranked bars with values and shares
 * printed at the bar end (CountryBars), so nothing depends on hover.
 */
import { Globe, PackageOpen, Ship, Store } from 'lucide-react';
import type { CountryValue, ProductTrade, Provenance } from '@/api/types';
import { Card, CountryBars, ProvenanceBadge, ReconciliationHelpButton } from '@/components';
import { fmtNum, fmtOrdinal, fmtPct } from '@/lib/format';

function Footer({ provenance, text }: { provenance: Provenance; text: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProvenanceBadge provenance={provenance} size="xs" />
      <span>{text}</span>
    </div>
  );
}

export interface CountryPanelsProps {
  trade: ProductTrade | null;
  provenance: Provenance;
  worldSuppliers: CountryValue[];
  worldMarkets: CountryValue[];
  destinations: CountryValue[];
  sources: CountryValue[];
}

export function CountryPanels({ trade, provenance, worldSuppliers, worldMarkets, destinations, sources }: CountryPanelsProps) {
  const year = trade?.year ?? 2024;
  const rank = trade?.india_supplier_rank ?? null;
  const n = trade?.n_suppliers ?? null;
  const rankText =
    rank !== null
      ? `India ranks ${fmtOrdinal(rank)}${n ? ` of ${fmtNum(n)}` : ''} suppliers${trade?.india_world_share != null ? ` with ${fmtPct(trade.india_world_share)} of world exports` : ''}`
      : 'India is not among the exporters of this product';
  const china = trade?.china_import_share;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card
        title="Top global suppliers"
        subtitle={`World exporters, ${year}`}
        icon={Globe}
        footer={<Footer provenance={provenance} text="Share of world exports of the subheading." />}
      >
        <div className="mb-2 rounded-md bg-kpi-soft px-2.5 py-1.5 text-[13px] font-medium text-ink">{rankText}</div>
        <CountryBars items={worldSuppliers} emptyText="No world supplier data for this subheading" />
      </Card>
      <Card
        title="Top global markets"
        subtitle={`World importers, ${year}`}
        icon={Store}
        footer={<Footer provenance={provenance} text="Share of world imports of the subheading." />}
      >
        <CountryBars items={worldMarkets} emptyText="No world market data for this subheading" />
      </Card>
      <Card
        title="India's top export destinations"
        subtitle={`Where India's exports go, ${year}`}
        icon={Ship}
        actions={<ReconciliationHelpButton size="xs" />}
        footer={<Footer provenance={provenance} text="Share of India's exports of the subheading." />}
      >
        <CountryBars items={destinations} highlightIso3={null} emptyText="India recorded no exports of this subheading" />
      </Card>
      <Card
        title="India's top import sources"
        subtitle={`Where India's imports come from, ${year}`}
        icon={PackageOpen}
        actions={<ReconciliationHelpButton size="xs" />}
        footer={
          <Footer
            provenance={provenance}
            text={
              typeof china === 'number' && sources.length
                ? china > 0
                  ? `Share of India's imports. China supplies ${fmtPct(china)} of India's imports of this subheading.`
                  : "Share of India's imports. China supplies none of India's imports of this subheading."
                : "Share of India's imports of the subheading."
            }
          />
        }
      >
        <CountryBars items={sources} highlightIso3={null} emptyText="India recorded no imports of this subheading" />
      </Card>
    </div>
  );
}
