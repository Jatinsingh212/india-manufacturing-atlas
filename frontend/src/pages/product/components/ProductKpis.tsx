/**
 * ProductKpis - the product's headline figures with provenance: India's exports and imports (with
 * 2018-2024 sparklines and year-on-year change), trade balance, world market, India's share of world
 * exports, RCA, India's supplier rank and the BCD / MFN tariff. India's exports and imports are the line's own
 * DGCIS TRADESTAT figures; world market, share, RCA and rank are HS6 context (CEPII BACI has no 8-digit lines;
 * petroleum 2710 is reported only as the heading aggregate 271000), which the note under the tiles says plainly.
 */
import { ArrowLeftRight, Award, Globe, Landmark, Percent, Scale, TrendingDown, TrendingUp } from 'lucide-react';
import type { ProductDetail, Provenance } from '@/api/types';
import { KpiTile, ReconciliationHelpButton, StatGrid } from '@/components';
import { cagrLabel, fmtCode, fmtNum, fmtOrdinal, fmtPct, fmtRate, fmtRatio, fmtUSD, plural } from '@/lib/format';
import { LATEST_YEAR, tradeProvenance } from '@/pages/explore/shared';
import { bcdProvenance, cagrWindowStart, tariffOf, tradeOf } from '../extras';

export function ProductKpis({ p }: { p: ProductDetail }) {
  const t = tradeOf(p);
  const year = t?.year ?? LATEST_YEAR;
  const prov: Provenance = t?.provenance ?? tradeProvenance(null, year);
  const series = [...p.series].sort((a, b) => a.year - b.year);
  const exportsV = t?.exports ?? p.exports;
  const importsV = t?.imports ?? p.imports;
  const balance = t?.trade_balance ?? (typeof exportsV === 'number' && typeof importsV === 'number' ? exportsV - importsV : null);
  const tariff = tariffOf(p);
  const tariffText = p.bcd_display ?? tariff?.bcd_display ?? (typeof tariff?.mfn_avg === 'number' ? fmtRate(tariff.mfn_avg) : typeof p.mfn_tariff === 'number' ? fmtRate(p.mfn_tariff) : null);
  const tariffProv: Provenance = bcdProvenance(p) ?? { source: 'wits', status: tariffText ? 'verified' : 'not_available', label: 'WITS / UNCTAD TRAINS MFN applied', year: 2022 };
  const mfnText =
    typeof tariff?.mfn_min === 'number' && typeof tariff?.mfn_max === 'number' && tariff.mfn_min !== tariff.mfn_max
      ? `MFN range ${fmtRate(tariff.mfn_min)}–${fmtRate(tariff.mfn_max)}`
      : typeof tariff?.mfn_avg === 'number'
        ? `MFN applied average ${fmtRate(tariff.mfn_avg)}`
        : tariff?.non_ad_valorem
          ? 'MFN duty is non-ad-valorem (WITS)'
          : 'MFN rate not reported';
  const rank = t?.india_supplier_rank ?? null;
  const worldFrom = cagrWindowStart(series, 'world_trade');
  const exportFrom = t?.first_year ?? cagrWindowStart(series, 'exports');
  const aggregate = t?.trade_level === 'hs4_aggregate';
  const tradeCode = t?.metric_hs6 ?? p.hs6;
  const ownLine = t?.trade_level === 'hs8';
  const fy = `FY${year}-${String(year + 1).slice(-2)}`;
  const contextUnit = tradeCode.endsWith('00') && tradeCode !== p.hs6 ? 'heading aggregate' : 'HS6 subheading';
  const tradeUnit = contextUnit === 'heading aggregate' ? 'this heading' : 'this HS6 subheading';
  // A line DGCIS does not publish separately has no figure of its own: say so instead of 'Verified'.
  const lineProv = (v: number | null | undefined): Provenance =>
    typeof v === 'number' ? prov : { ...prov, status: 'not_available', label: `Not published separately by DGCIS TRADESTAT for ${fy}` };
  // Change of the line's own series; the API's export_yoy / import_yoy belong to the HS6 or heading context row.
  const lineYoy = (key: 'exports' | 'imports') => {
    const cur = series.find((s) => s.year === year)?.[key];
    const prev = series.find((s) => s.year === year - 1)?.[key];
    return typeof cur === 'number' && typeof prev === 'number' && prev > 0 ? cur / prev - 1 : null;
  };

  return (
    <div className="space-y-2">
      <StatGrid cols={4}>
        <KpiTile
          label={`India's exports ${year}`}
          value={fmtUSD(exportsV)}
          icon={TrendingUp}
          trend={series.map((s) => s.exports)}
          delta={{ value: lineYoy('exports'), label: `vs ${year - 1}` }}
          provenance={lineProv(exportsV)}
          hint={`India's exports of this 8-digit line to the world, ${fy} (DGCIS TRADESTAT).`}
        />
        <KpiTile
          label={`India's imports ${year}`}
          value={fmtUSD(importsV)}
          icon={TrendingDown}
          trend={series.map((s) => s.imports)}
          delta={{ value: lineYoy('imports'), label: `vs ${year - 1}`, upIsGood: false }}
          provenance={lineProv(importsV)}
          hint={`India's imports of this 8-digit line from the world, ${fy} (DGCIS TRADESTAT).`}
        />
        <KpiTile
          label="Trade balance"
          value={balance !== null ? fmtUSD(balance, { signed: true }) : null}
          icon={Scale}
          accent={balance === null ? 'ink' : balance >= 0 ? 'ok' : 'bad'}
          sub={balance === null ? undefined : balance >= 0 ? 'Net exporter' : 'Net importer'}
          provenance={lineProv(balance)}
        />
        <KpiTile
          label={`World market ${year}`}
          value={fmtUSD(t?.world_trade ?? p.world_trade)}
          icon={Globe}
          accent="brand"
          trend={series.map((s) => s.world_trade ?? null)}
          sub={t?.world_cagr !== null && t?.world_cagr !== undefined ? `World ${cagrLabel(t.world_cagr, worldFrom, year)}` : undefined}
          provenance={prov}
          hint={`Total world exports of ${tradeUnit} (sum over all exporters). CAGR from the earliest year since 2018 with trade.`}
        />
        <KpiTile
          label="India's share of world exports"
          value={fmtPct(t?.india_world_share)}
          icon={Percent}
          sub={t?.export_cagr !== null && t?.export_cagr !== undefined ? `India's exports ${cagrLabel(t.export_cagr, exportFrom, year)}` : undefined}
          provenance={prov}
        />
        <KpiTile
          label="RCA (Balassa)"
          value={fmtRatio(t?.rca ?? p.rca)}
          icon={Award}
          sub={(t?.rca ?? p.rca) === null ? undefined : (t?.rca ?? p.rca ?? 0) >= 1 ? 'Revealed comparative advantage' : 'Below India’s average specialisation'}
          provenance={prov}
          hint="India's share of this product in its exports divided by the product's share in world exports. Above 1 = India is relatively specialised."
        />
        <KpiTile
          label="India's supplier rank"
          value={rank !== null ? fmtOrdinal(rank) : null}
          icon={Landmark}
          accent="brand"
          sub={rank !== null && t?.n_suppliers ? `of ${fmtNum(t.n_suppliers)} exporting countries` : undefined}
          provenance={rank !== null ? prov : { ...prov, status: 'not_available' }}
        />
        <KpiTile
          label="BCD / MFN tariff"
          value={tariffText}
          icon={ArrowLeftRight}
          accent="ink"
          sub={mfnText}
          provenance={tariffProv}
          hint="India's MFN applied simple average for the HS6 subheading (WITS, 2022)."
        />
      </StatGrid>
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-xs text-muted">
        <p className="flex-1 min-w-[280px]">
          {ownLine
            ? `India's exports and imports are this line's official DGCIS TRADESTAT figures for ${fy}. `
            : `DGCIS TRADESTAT does not publish this line separately for ${fy}, so its exports and imports are not available. `}
          World market, India's share, RCA and supplier rank are for the {contextUnit}{' '}
          <span className="font-mono">{fmtCode(tradeCode)}</span> (CEPII BACI world trade has no 8-digit national detail)
          {aggregate || contextUnit === 'heading aggregate' ? (
            <>
              {' '}- BACI reports heading <span className="font-mono">{fmtCode(p.hs4)}</span> only as this aggregate
              {typeof t?.heading_lines === 'number' ? `, shared by ${plural(t.heading_lines, 'national line')}` : ''}
            </>
          ) : null}
          .
        </p>
        <ReconciliationHelpButton size="xs" />
      </div>
    </div>
  );
}
