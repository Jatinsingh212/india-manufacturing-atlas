/**
 * TradeStructure - the supply-structure facts behind the scores, straight from the trade metrics:
 * top import source and its share (with the number of source countries), China's share, the top export
 * destination, import and world-supplier concentration (HHI, with a plain reading), the import
 * dependency ratio and growth rates, each labelled with its own CAGR window (SPEC section 4: from the
 * earliest year since 2018 with trade to the latest year). All CEPII BACI derived.
 */
import { Network } from 'lucide-react';
import type { CountryValue, Provenance, TradeSeriesPoint } from '@/api/types';
import { Card, EmptyState, KeyValueList, ProvenanceBadge, ReconciliationHelpButton } from '@/components';
import { cagrLabel, fmtNum, fmtPct, fmtRatio, yoyLabel } from '@/lib/format';
import { cagrWindowStart, type TradeExtras } from '../extras';

/** Plain reading of a Herfindahl-Hirschman index (0-1). */
function hhiReading(h: number | null | undefined): string | null {
  if (typeof h !== 'number') return null;
  if (h < 0.15) return 'diversified';
  if (h < 0.25) return 'moderately concentrated';
  return 'highly concentrated';
}

/** Country name for an OEC country id, from the API's name field or the partner lists. */
function countryName(id: string | null | undefined, name: string | null | undefined, lists: CountryValue[][]): string | null {
  if (name) return name;
  if (!id) return null;
  for (const list of lists) {
    const hit = list.find((c) => c.country_id === id || c.iso3 === id);
    if (hit) return hit.country;
  }
  return id;
}

export interface TradeStructureProps {
  trade: TradeExtras | null;
  series: TradeSeriesPoint[];
  sources: CountryValue[];
  destinations: CountryValue[];
  provenance: Provenance;
}

export function TradeStructure({ trade, series, sources, destinations, provenance }: TradeStructureProps) {
  if (!trade) {
    return (
      <Card title="Trade structure" icon={Network}>
        <EmptyState compact title="No trade record" message="CEPII BACI has no 2024 flows for this subheading." />
      </Card>
    );
  }
  const t = trade;
  const src = countryName(t.top_import_source, t.top_import_source_name, [sources]);
  const dest = countryName(t.top_destination, t.top_destination_name, [destinations]);
  const destShare = t.top_destination_share ?? destinations[0]?.share ?? null;
  const dep =
    typeof t.exports === 'number' && typeof t.imports === 'number' && t.exports + t.imports > 0 ? t.imports / (t.exports + t.imports) : null;
  const imp = hhiReading(t.india_import_hhi);
  const wld = hhiReading(t.world_supplier_hhi);
  const to = t.year ?? null;
  const fromX = t.first_year ?? cagrWindowStart(series, 'exports');
  const fromM = cagrWindowStart(series, 'imports');
  const fromW = cagrWindowStart(series, 'world_trade');

  return (
    <Card
      title="Trade structure"
      subtitle={`Concentration, dependence and growth, ${t.year}`}
      icon={Network}
      actions={<ReconciliationHelpButton size="xs" />}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <ProvenanceBadge provenance={provenance} size="xs" />
          <span>HHI = sum of squared country shares (0 = dispersed, 1 = a single country).</span>
        </div>
      }
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <KeyValueList
          variant="plain"
          labelWidth="52%"
          items={[
            {
              label: 'Top import source',
              value: src ? `${src}${typeof t.top_import_source_share === 'number' ? ` · ${fmtPct(t.top_import_source_share)}` : ''}` : 'Not available',
              aside: typeof t.n_import_sources === 'number' && t.n_import_sources > 0 ? `of ${fmtNum(t.n_import_sources)} sources` : undefined,
            },
            { label: "China's share of India's imports", value: fmtPct(t.china_import_share), numeric: true },
            {
              label: 'Top export destination',
              value: dest ? `${dest}${typeof destShare === 'number' ? ` · ${fmtPct(destShare)}` : ''}` : 'Not available',
            },
            { label: 'Import dependency ratio', value: dep !== null ? fmtPct(dep) : 'Not available', numeric: dep !== null, aside: dep !== null ? 'M ÷ (M + X)' : undefined },
            { label: "India's import concentration (HHI)", value: fmtRatio(t.india_import_hhi), numeric: true, aside: imp ?? undefined },
          ]}
        />
        <KeyValueList
          variant="plain"
          labelWidth="52%"
          items={[
            { label: 'World supplier concentration (HHI)', value: fmtRatio(t.world_supplier_hhi), numeric: true, aside: wld ?? undefined },
            { label: "India's export growth", value: cagrLabel(t.export_cagr, fromX, to), aside: t.export_yoy !== null ? yoyLabel(t.export_yoy) : undefined },
            { label: "India's import growth", value: cagrLabel(t.import_cagr, fromM, to), aside: t.import_yoy !== null ? yoyLabel(t.import_yoy) : undefined },
            {
              label: 'World market growth',
              value: cagrLabel(t.world_cagr, fromW, to),
              aside: typeof t.world_yoy === 'number' ? yoyLabel(t.world_yoy) : undefined,
            },
          ]}
        />
      </div>
    </Card>
  );
}
