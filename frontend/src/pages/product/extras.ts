/**
 * Optional fields the HSN API sends beyond the SPEC section 6.3 shapes (the API owner's additions to the
 * contract). They are read defensively: every page works when they are absent.
 *
 * - trade: top_import_source_name, top_destination(_name / _share), n_import_sources, world_yoy and
 *   first_year (the first year of the CAGR window).
 * - tariff.bcd_source / bcd_provenance: where `bcd_display` comes from (WITS MFN average); tariff.non_ad_valorem:
 *   MFN duty without an ad-valorem rate.
 * - scores.provenance: the "Model estimate" provenance of the scores.
 * - upstream / downstream links: `source` (curated | hs_text).
 * - value_chains: `items`, the item names of the stage that list this line.
 * - lookup node.trade: aggregated India / world trade of the node's distinct HS6 subheadings.
 * - product.alerts: automated risk alerts for the product's HS6 subheading.
 */
import type {
  Alert,
  HsNodeInfo,
  ProductDetail,
  ProductLink,
  ProductScores,
  ProductTariff,
  ProductTrade,
  ProductValueChainRef,
  Provenance,
  TradeSeriesPoint,
} from '@/api/types';

export interface TariffExtras extends ProductTariff {
  bcd_source?: string | null;
  bcd_provenance?: Provenance | null;
  non_ad_valorem?: boolean | null;
}

export interface TradeExtras extends ProductTrade {
  top_import_source_name?: string | null;
  top_destination?: string | null;
  top_destination_name?: string | null;
  top_destination_share?: number | null;
  n_import_sources?: number | null;
  world_yoy?: number | null;
  /** First year of the CAGR window (earliest year since 2018 with trade). */
  first_year?: number | null;
}

export interface ScoresExtras extends ProductScores {
  provenance?: Provenance | null;
}

export interface LinkExtras extends ProductLink {
  /** 'curated' | 'hs_text' */
  source?: string | null;
}

export interface ValueChainRefExtras extends ProductValueChainRef {
  items?: string[];
}

export interface NodeTrade {
  exports: number | null;
  imports: number | null;
  world_trade: number | null;
  n_hs6?: number | null;
  provenance?: Provenance | null;
}

export type HsNodeWithTrade = HsNodeInfo & { trade?: NodeTrade | null };

/** Tariff block with the optional extras typed. */
export function tariffOf(p: Pick<ProductDetail, 'tariff'>): TariffExtras | null {
  return (p.tariff as TariffExtras | null) ?? null;
}

/** Trade block with the optional extras typed. */
export function tradeOf(p: Pick<ProductDetail, 'trade'>): TradeExtras | null {
  return (p.trade as TradeExtras | null) ?? null;
}

/** Provenance of the BCD figure shown: WITS MFN (Verified / Not available). */
export function bcdProvenance(p: Pick<ProductDetail, 'tariff'>): Provenance | null {
  const t = tariffOf(p);
  if (!t) return null;
  return t.bcd_provenance ?? t.provenance ?? null;
}

/** Risk alerts attached to the product, if the API sends them. */
export function alertsOf(p: ProductDetail): Alert[] {
  const a = (p as ProductDetail & { alerts?: unknown }).alerts;
  return Array.isArray(a) ? (a as Alert[]) : [];
}

/** True for a link derived from HS nomenclature text ("parts of"), as opposed to a curated value-chain link. */
export function isDerivedLink(l: LinkExtras): boolean {
  return l.source === 'hs_text' || l.relation === 'parts_of';
}

/**
 * First year of a CAGR window: the earliest year >= 2018 with a positive value (SPEC section 4). The API
 * reports it only for the export series (`trade.first_year`), so other series derive it from `series`.
 */
export function cagrWindowStart(series: TradeSeriesPoint[], key: 'exports' | 'imports' | 'world_trade'): number | null {
  const years = series
    .filter((pt) => pt.year >= 2018 && typeof pt[key] === 'number' && (pt[key] as number) > 0)
    .map((pt) => pt.year)
    .sort((a, b) => a - b);
  return years[0] ?? null;
}
