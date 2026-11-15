/**
 * TypeScript types for every request / response shape of the Atlas API (docs/SPEC.md section 6).
 *
 * Conventions (SPEC section 1):
 * - JSON is snake_case; HS codes are strings with leading zeros ("0602", "40111010").
 * - Money is US$ (not millions) as a number; shares / CAGRs / YoY are fractions (0.0307 = 3.07 %).
 * - Tariff rates (`mfn_tariff`, `mfn_avg` ...) are percentages (12.5 = 12.5 %).
 * - `null` is meaningful: it means "Not available" and must be rendered as such - never as 0.
 *
 * Where SPEC lists a shape only by its database table (tickets, uploads, jobs, claims, roadmap items,
 * risks, audit rows) the fields follow backend/scripts/etl/schema.sql. Fields that SPEC does not pin
 * down are marked optional (`?`) so pages degrade gracefully if a backend owner omits them.
 */

// ============================================================================ primitives

/** An HS code string: 2, 4, 6 or 8 digits with leading zeros. */
export type HsCode = string;
/** ISO-8601 timestamp string as stored by the backend (UTC). */
export type IsoDateTime = string;

export type Role = 'public' | 'industry' | 'analyst' | 'ministry' | 'admin';
export type DemoRole = Exclude<Role, 'public'>;
export const GOV_ROLES = ['analyst', 'ministry', 'admin'] as const satisfies readonly Role[];
export type GovRole = (typeof GOV_ROLES)[number];

export type ProvenanceSource =
  | 'baci'
  | 'wits'
  | 'gst_master'
  | 'hs_nomenclature'
  | 'unido_indstat'
  | 'rubber_board'
  | 'atma'
  | 'dpiit_guidebook'
  | 'rule'
  | 'official_upload'
  | 'manual'
  | 'unmapped'
  | 'dgft_itc_hs'
  | 'model'
  | 'comtrade';
export type ProvenanceStatus = 'verified' | 'not_verified' | 'not_available';

/** Attached to every displayed number (SPEC section 1, "Provenance object"). */
export interface Provenance {
  source: ProvenanceSource | string;
  status: ProvenanceStatus;
  label: string | null;
  year: number | null;
}

export type MappingStatus = 'accepted' | 'residual';
export type MappingSource = 'dpiit_guidebook' | 'rule' | 'official_upload' | 'manual' | 'unmapped';
export type Archetype = 'Champion' | 'Established' | 'Emerging' | 'Dependent' | 'Marginal';
export type TradeFlow = 'X' | 'M';
export type SortOrder = 'asc' | 'desc';
export type ReportKind = 'product' | 'ministry' | 'sector' | 'valuechain';
export type ReportFormat = 'pdf' | 'xlsx' | 'csv';

/** Standard paginated list envelope (page is 1-based, default page_size 25, max 200). */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

/** Common pagination query params. */
export interface PageParams {
  page?: number;
  page_size?: number;
}

/** FastAPI error body. `detail` is a string, or a list of validation issues for 422. */
export interface ApiErrorBody {
  detail?: string | Array<{ loc?: Array<string | number>; msg?: string; type?: string }>;
}

// ============================================================================ shared shapes (app/common.py)

export interface MinistryRef {
  id: string;
  short_name: string;
  name: string;
  color: string | null;
}

export interface CountryValue {
  country_id: string;
  country: string;
  iso3: string | null;
  value: number;
  share: number | null;
  rank: number | null;
}

/** One 8-digit national tariff line with HS6-level 2024 trade values. */
export interface ProductSummary {
  hsn8: HsCode;
  hs6: HsCode;
  hs4: HsCode;
  hs2: HsCode;
  description: string;
  full_description: string | null;
  ministry_id: string;
  ministry_short: string | null;
  ministry_name: string | null;
  sector_id: string | null;
  sector_name: string | null;
  mapping_status: MappingStatus;
  mapping_source: MappingSource;
  mapping_confidence: number | null;
  exports: number | null;
  imports: number | null;
  world_trade: number | null;
  rca: number | null;
  /** India MFN applied tariff, percent (HS6 simple average). */
  mfn_tariff: number | null;
  /** e.g. "12.5%". */
  bcd_display: string | null;
  /** Where `bcd_display` comes from: 'wits' = the WITS MFN average, null = no figure. */
  bcd_source?: 'wits' | null;
  lines_in_hs6: number;
  /** 'hs8' = the line's own DGCIS TRADESTAT figure; 'hs6' / 'hs4_aggregate' (BACI reports 2710 only as 271000)
   *  = DGCIS does not publish the line separately, so exports / imports are null and only context is shown. */
  trade_level: TradeLevel;
  /** HS6 code carrying the trade: the line's own subheading, or the heading aggregate. */
  metric_hs6?: HsCode | null;
}

/**
 * Level at which a code's trade was aggregated: 'hs8' = one national line (DGCIS TRADESTAT); 'hs6' = one subheading; 'hs4' / 'hs2' = every subheading
 * under a 4- / 2-digit code summed; 'hs4_aggregate' = BACI reports the subheading only as its heading total
 * (petroleum oils 2710 -> 271000), so the figure is the whole heading.
 */
export type TradeLevel = 'hs8' | 'hs6' | 'hs4' | 'hs2' | 'hs4_aggregate' | string;

/** Common facets used by HS6-level analytics items. */
export interface Hs6ItemBase {
  hs6: HsCode;
  description: string;
  hsn8_sample: HsCode | null;
  ministry_id: string | null;
  ministry_short: string | null;
  sector_id: string | null;
  sector_name: string | null;
}

export interface YearValue {
  year: number;
  value: number | null;
}

export interface ForecastPoint {
  year: number;
  value: number | null;
  lo: number | null;
  hi: number | null;
}

export interface ForecastSet {
  exports: ForecastPoint[];
  imports: ForecastPoint[];
}

export interface TradeSeriesPoint {
  year: number;
  exports: number | null;
  imports: number | null;
  world_trade?: number | null;
}

export interface SchemeRef {
  id: string;
  name: string;
  kind: 'PLI' | 'QCO' | string;
}

export interface LinkRef {
  label: string;
  url: string;
}

// ============================================================================ 6.1 system / auth

export interface HealthResponse {
  status: 'ok' | string;
  built_at: IsoDateTime | null;
  latest_year: number | null;
  products: number | null;
  db_path: string | null;
}

export interface User {
  id: number | null;
  email: string | null;
  name: string | null;
  role: Role;
  ministry_id: string | null;
  organisation: string | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface DemoLoginRequest {
  role: DemoRole;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  organisation: string;
}

export interface AuthResponse {
  access_token: string;
  token_type: 'bearer';
  user: User;
}

// ============================================================================ 6.2 meta

export interface OverviewKpis {
  total_codes: number;
  accepted_codes: number;
  residual_codes: number;
  ministries_assigned: number;
  sectors: number;
  hs6_with_trade: number;
  india_exports: number | null;
  india_imports: number | null;
  world_trade: number | null;
  latest_year: number;
}

export interface MinistryDistributionRow {
  ministry_id: string;
  short_name: string;
  name: string;
  color: string | null;
  codes: number;
  exports: number | null;
  imports: number | null;
}

export interface SectorDistributionRow {
  sector_id: string;
  name: string;
  color: string | null;
  codes: number;
  exports: number | null;
  imports: number | null;
}

export interface DataFreshnessRow {
  source_id: string;
  name: string;
  last_refreshed: IsoDateTime | null;
}

export interface OverviewResponse {
  kpis: OverviewKpis;
  /** Descending by codes, excludes the residual bucket. */
  distribution_by_ministry: MinistryDistributionRow[];
  sector_distribution: SectorDistributionRow[];
  mapping_sources: Array<{ source: MappingSource | string; codes: number }>;
  /** Coverage at 2/4/6/8 digits; parent levels are derived from the accepted 8-digit lines. */
  mapping_by_level: Array<{
    level: 2 | 4 | 6 | 8;
    nodes: number;
    nodes_with_owner: number;
    lines: number;
    mapped_lines: number;
    node_coverage: number;
    line_coverage: number;
    source: 'dpiit_guidebook' | string;
    method: 'aggregated_from_8_digit_lines' | 'direct' | string;
  }>;
  data_freshness: DataFreshnessRow[];
  provenance: { trade: Provenance; mapping: Provenance };
}

export interface MinistryListItem {
  id: string;
  short_name: string;
  name: string;
  parent_ministry: string | null;
  kind: 'department' | 'ministry' | 'residual' | string;
  website: string | null;
  color: string | null;
  codes: number;
  accepted: number;
  exports: number | null;
  imports: number | null;
}

export interface SectorListItem {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  /** lucide icon name, e.g. "Shirt" */
  icon: string | null;
  codes: number;
  exports: number | null;
  imports: number | null;
}

export interface SectionChapter {
  code: HsCode;
  description: string;
  codes: number;
}

export interface Section {
  /** Roman numeral 'I'..'XXI' */
  id: string;
  num: number;
  name: string;
  chapters: SectionChapter[];
}

export interface Country {
  id: string;
  iso3: string | null;
  name: string;
  continent: string | null;
}

export interface InfoCard {
  id: string;
  title: string;
  icon: string | null;
  body_md: string;
  links: LinkRef[];
}



// ============================================================================ 6.3 HSN

export type SearchSort = 'relevance' | 'exports' | 'imports' | 'rca' | 'code' | 'world_trade';

export interface ProductSearchParams extends PageParams {
  q?: string;
  ministry_id?: string;
  sector_id?: string;
  chapter?: string;
  mapping_status?: MappingStatus;
  mapping_source?: MappingSource;
  min_exports?: number;
  min_imports?: number;
  rca_min?: number;
  rca_max?: number;
  sort?: SearchSort;
  order?: SortOrder;
}

export interface SuggestItem {
  hsn8: HsCode;
  description: string;
  ministry_short: string | null;
}

export interface HierarchyNode {
  /** Section uses its roman numeral as code. */
  code: string;
  level: number;
  description: string;
}

export interface ProductMinistry extends MinistryRef {
  role: 'primary' | 'secondary' | string;
}

export interface ProductMapping {
  status: MappingStatus;
  source: MappingSource;
  confidence: number | null;
  rule: string | null;
  provenance: Provenance;
}

export interface ProductTrade {
  year: number;
  exports: number | null;
  imports: number | null;
  world_trade: number | null;
  trade_balance: number | null;
  rca: number | null;
  india_world_share: number | null;
  india_supplier_rank: number | null;
  n_suppliers: number | null;
  world_supplier_hhi: number | null;
  india_import_hhi: number | null;
  top_import_source: string | null;
  top_import_source_share: number | null;
  china_import_share: number | null;
  export_cagr: number | null;
  import_cagr: number | null;
  world_cagr: number | null;
  export_yoy: number | null;
  import_yoy: number | null;
  trade_level: 'hs6' | 'hs4_aggregate' | string;
  /** HS6 code carrying the trade (the line's own subheading or the heading aggregate). */
  metric_hs6?: HsCode | null;
  /** Number of national lines in the heading when `trade_level` is 'hs4_aggregate'. */
  heading_lines?: number | null;
  lines_in_hs6: number;
  provenance: Provenance;
}

export interface ProductTariff {
  mfn_avg: number | null;
  mfn_min: number | null;
  mfn_max: number | null;
  n_lines: number | null;
  year: number | null;
  bcd_display: string | null;
  provenance: Provenance;
}

/** DGFT ITC-HS policy state: published with a value, published without one, or absent from the tables. */
export type TradePolicyStatus = 'specified' | 'not_specified' | 'not_listed';

export interface ProductTradePolicyDirection {
  status: TradePolicyStatus;
  /** As published: 'Free', 'Restricted', 'Prohibited', 'STE (State Trading Enterprise)', ... */
  policy: string | null;
  /** Policy condition, plain text (the portal's HTML is stripped during ingest). */
  condition: string | null;
  /** Portal 'YES' / 'NO' flag for this direction. */
  itc_type: string | null;
  notification_no: string | null;
  notification_date: string | null;
  notification_date_iso: string | null;
  /** ITC-HS description of the code in this direction's published table. */
  description: string | null;
  /** Number of published records for this code and direction (duplicates preserved). */
  n_records: number;
  provenance: Provenance;
}

/** DGFT ITC-HS import / export policy of the line (public DGFT Discover portal). */
export interface ProductTradePolicy {
  import: ProductTradePolicyDirection;
  export: ProductTradePolicyDirection;
  chapter: string;
  source: 'dgft_itc_hs' | string;
  source_url: string;
  fetched_at: string | null;
  provenance: Provenance;
}

export interface ProductScores {
  export_potential_score: number | null;
  untapped_potential_usd: number | null;
  import_dependency_score: number | null;
  vulnerability_score: number | null;
  substitution_score: number | null;
  archetype: Archetype | null;
  ml_cluster: number | null;
  forecast: ForecastSet;
  product_readiness_index?: number | null;
  readiness_tier?: string | null;
}

export interface ProductValueChainRef {
  chain_id: string;
  name: string;
  stage_id: string;
  stage_name: string;
}

export interface ProductLink {
  code: HsCode;
  description: string | null;
  relation: VcRelation;
  chain_id: string | null;
}

export interface ProductionRow {
  year: number | null;
  value: number | null;
  unit: string | null;
  label: string | null;
  source: string;
  status: ProvenanceStatus | string;
}

export interface ProductSibling {
  hsn8: HsCode;
  description: string;
  ministry_short: string | null;
}

export interface ProductDetail extends ProductSummary {
  /** section (code = roman numeral), chapter, heading, subheading */
  hierarchy: HierarchyNode[];
  ministries: ProductMinistry[];
  mapping: ProductMapping;
  trade: ProductTrade | null;
  series: TradeSeriesPoint[];
  tariff: ProductTariff | null;
  /** DGFT ITC-HS import / export policy; null when the policy dataset is not loaded. */
  trade_policy: ProductTradePolicy | null;
  top_destinations: CountryValue[];
  top_sources: CountryValue[];
  /** Top 10, plus India appended if outside the top 10. */
  world_top_suppliers: CountryValue[];
  world_top_markets: CountryValue[];
  scores: ProductScores | null;
  value_chains: ProductValueChainRef[];
  upstream: ProductLink[];
  downstream: ProductLink[];
  schemes: SchemeRef[];
  production: ProductionRow[];
  siblings: ProductSibling[];
  /** Residual-line hint: nearest parent with one accepted owner and >=50% coverage. */
  parent_ownership?: (OwnershipSummary & {
    level: 2 | 4 | 6;
    parent_code: string;
    owner: OwnershipOwner;
  }) | null;
  data_quality_score: number;
}

/** Ownership of a 2/4/6-digit HS node, aggregated from the Guidebook's accepted 8-digit lines. */
export interface OwnershipOwner {
  id: string;
  short_name: string;
  name: string;
  color: string | null;
  role: 'primary' | 'secondary';
  n_primary: number;
  n_lines: number;
  share: number | null;
}

export interface OwnershipSummary {
  total_lines: number;
  mapped_lines: number;
  residual_lines: number;
  coverage: number;
  n_owners: number;
  owners: OwnershipOwner[];
  source: 'dpiit_guidebook' | string;
  method: 'aggregated_from_8_digit_lines' | string;
}

export interface HsNodeInfo {
  code: HsCode;
  level: number;
  description: string;
  parent: HsCode | null;
  section_id: string | null;
  /** Present for 2/4/6-digit nodes: owners of the accepted 8-digit lines under this code. */
  ownership?: OwnershipSummary | null;
}

export interface HsNodeChild {
  code: HsCode;
  level: number;
  description: string;
  n_products: number;
  ownership?: OwnershipSummary | null;
}

export type LookupResponse =
  | { type: 'product'; product: ProductDetail }
  | { type: 'node'; node: HsNodeInfo; children: HsNodeChild[]; products: ProductSummary[] };

/** Levels: 0 section, 2 chapter, 4 heading, 6 subheading, 8 national line. */
export interface TreeNode {
  code: string;
  level: 0 | 2 | 4 | 6 | 8;
  description: string;
  n_products: number;
  exports: number | null;
  imports: number | null;
  has_children: boolean;
  /** How `exports` / `imports` were aggregated ('hs6' subheading, 'hs4' heading, 'hs2' chapter). */
  trade_level?: TradeLevel | null;
  /** HS6 code carrying the trade, when the row shows a single subheading or heading aggregate. */
  metric_hs6?: HsCode | null;
  /** Guidebook ownership aggregated from accepted 8-digit lines (2/4/6-digit nodes). */
  ownership?: OwnershipSummary | null;
}

export interface CompareItem extends ProductSummary {
  series: TradeSeriesPoint[];
  india_world_share: number | null;
  export_cagr: number | null;
  import_cagr: number | null;
}

export interface CompareResponse {
  items: CompareItem[];
}

// ============================================================================ 6.4 ministries & sectors

export interface EntityKpis {
  codes: number;
  accepted: number;
  secondary_codes: number;
  exports: number | null;
  imports: number | null;
  trade_balance: number | null;
  world_trade: number | null;
  sectors_covered: number;
  chains_involved: number;
  open_tickets: number;
  pending_claims: number;
}

export interface ChapterMixRow {
  hs2: HsCode;
  description: string;
  codes: number;
  exports: number | null;
  imports: number | null;
}

export interface DependencyHotspot extends ProductSummary {
  vulnerability_score: number | null;
  top_import_source: string | null;
  top_import_source_share: number | null;
  china_import_share: number | null;
}

export interface OpportunityProduct extends ProductSummary {
  export_potential_score: number | null;
  untapped_potential_usd: number | null;
  archetype: Archetype | null;
}

export interface EntityValueChain {
  chain_id: string;
  name: string;
  stages: string[];
}

/** Scope of a production figure: a value chain (key = chain id) or an 8 / 6 / 4-digit HS code. */
export type ProductionScope = 'chain' | 'hsn8' | 'hs6' | 'hs4';

/**
 * One real "Domestic production" figure on a ministry / sector dashboard, one per (scope, key, label),
 * chosen by the shared rule (verified first, then latest year, then newest row).
 */
export interface EntityProductionRow {
  scope: ProductionScope | string;
  /** Chain id for scope 'chain', else the HS code. */
  key: string;
  /** Measure key, e.g. 'global_production' / 'india_production'; free text or null for uploads. */
  label: string | null;
  /** e.g. "India's production - Tyre Sector (HS Code 4011)" or "<description> (HSN8 40111010)". */
  display_label: string;
  year: number | null;
  value: number | null;
  /** e.g. 'units', 'tonnes', 'usd' */
  unit: string | null;
  source: string | null;
  status: ProvenanceStatus | string;
  provenance: Provenance;
  /** Set for scope 'chain'. */
  chain_id: string | null;
  /** Candidate rows behind the chosen figure. */
  n_rows: number;
}

/** Provenance whose source may be null (nothing to cite, e.g. no production figure at all). */
export interface OptionalSourceProvenance extends Omit<Provenance, 'source'> {
  source: Provenance['source'] | null;
}

/** Provenance block of a ministry / sector dashboard. */
export interface EntityDashboardProvenance {
  trade?: Provenance | null;
  scores?: Provenance | null;
  /** One badge for the production card: not available, sourced figures, or uploads present. */
  production?: OptionalSourceProvenance | null;
}

/** Body shared by the ministry and sector dashboards. */
export interface EntityDashboardBase {
  kpis: EntityKpis;
  chapter_mix: ChapterMixRow[];
  top_exports: ProductSummary[];
  top_imports: ProductSummary[];
  dependency_hotspots: DependencyHotspot[];
  opportunities: OpportunityProduct[];
  value_chains: EntityValueChain[];
  schemes: SchemeRef[];
  trend: TradeSeriesPoint[];
  /** Real domestic production figures; [] = not available yet. Optional: older backends omit it. */
  production?: EntityProductionRow[];
  provenance?: EntityDashboardProvenance | null;
}

export interface MinistryDetailRef extends MinistryRef {
  parent_ministry: string | null;
  kind: string;
  website: string | null;
}

export interface MinistryDashboard extends EntityDashboardBase {
  ministry: MinistryDetailRef;
  sector_mix: SectorDistributionRow[];
}

export interface SectorDetailRef {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  chapters?: string[];
}

export interface SectorDashboard extends EntityDashboardBase {
  sector: SectorDetailRef;
  ministry_mix: MinistryDistributionRow[];
}

export interface EntityProductsParams extends PageParams {
  q?: string;
  sort?: SearchSort;
  order?: SortOrder;
}

// ============================================================================ 6.5 value chains & network

export type VcRelation = 'input_to' | 'component_of' | 'parts_of' | string;

export interface ValueChainListItem {
  id: string;
  name: string;
  title: string | null;
  anchor_hs: HsCode;
  lead_ministry: MinistryRef | null;
  description: string | null;
  n_stages: number;
  n_items: number;
  india_exports: number | null;
  world_trade: number | null;
  india_share: number | null;
}

export type ValueChainKpiKey =
  | 'global_production'
  | 'india_production'
  | 'india_output'
  | 'global_exports'
  | 'india_exports'
  | 'india_share'
  | 'india_imports';

export interface ValueChainKpi {
  key: ValueChainKpiKey | string;
  label: string;
  value: number | null;
  /** e.g. 'usd', 'tonnes', 'units', 'fraction' */
  unit: string | null;
  year: number | null;
  provenance: Provenance;
}

/** Rows behind a mapping provenance (all curated by the Atlas team). */
export interface MappingProvenanceCounts {
  curated: number;
}

/** A mapping provenance that carries the number of rows behind it (chain, stage or table level). */
export interface MappingProvenance extends Provenance {
  counts?: MappingProvenanceCounts | null;
}

/** Row fields shared by stage items and mapping rows. */
export interface ValueChainRowFields {
  /** 'curated' = added by the Atlas team. */
  source?: 'curated' | string | null;
  /** GST HSN master text of `hs_code` (null for 4/6-digit codes). */
  gst_description?: string | null;
  /** Row-level provenance (curated rows are not verified until the ministry validates them). */
  provenance?: Provenance | null;
}

export interface ValueChainItem extends ValueChainRowFields {
  id: number;
  item_name: string;
  hs_code: HsCode | null;
  hsn8: HsCode | null;
  description: string | null;
  ministry_text: string | null;
  ministries: MinistryRef[];
  exports: number | null;
  imports: number | null;
  rca: number | null;
  mfn_tariff: number | null;
  /** true when hs_code resolves to a product / node with trade data */
  linked: boolean;
  /** The single HS6 carrying the trade (null for 2/4-digit codes spanning several); sent by the C2 endpoint. */
  hs6?: HsCode | null;
  /** How `exports` / `imports` were aggregated (null when not linked); sent by the C2 endpoint. */
  trade_level?: TradeLevel | null;
  /** Vulnerability score of the item's subheading (model estimate), when scored. */
  vulnerability_score?: number | null;
  /** Position of the item within its stage. */
  item_order?: number | null;
}

export interface ValueChainStage {
  stage_id: string;
  name: string;
  order: number;
  ministry_text: string | null;
  ministries: MinistryRef[];
  items: ValueChainItem[];
  /** The stage's mapping provenance. */
  provenance?: MappingProvenance | null;
}

/** One item of a supplier tier (GET /api/valuechains/{id}/tiers). */
export interface ValueChainTierItem extends ValueChainRowFields {
  id: number;
  item_name: string;
  hs_code: HsCode | null;
  hsn8: HsCode | null;
  description: string | null;
  ministry_text: string | null;
  ministries: MinistryRef[];
  exports: number | null;
  imports: number | null;
  rca: number | null;
  mfn_tariff: number | null;
  vulnerability_score: number | null;
  linked: boolean;
  hs6?: HsCode | null;
  trade_level?: TradeLevel | null;
  item_order?: number | null;
}

/** One supplier tier: Tier 1 = direct suppliers, Tier 3 = basic materials and commodities. */
export interface ValueChainTier {
  tier_level: number;
  name: string;
  description: string | null;
  /** Example supplier types, as named in the study. */
  examples: string[];
  items: ValueChainTierItem[];
  provenance?: MappingProvenance | null;
}

/** The chain's supplier tiers (how deep the supply chain runs). */
export interface ValueChainTiers {
  chain_id: string;
  title: string | null;
  tiers: ValueChainTier[];
  notes?: string[] | null;
  provenance?: {
    mapping?: MappingProvenance | null;
    trade?: Provenance | null;
  } | null;
}

export interface Manufacturer {
  name: string;
  url: string | null;
}

export interface Cluster {
  id: string;
  name: string;
  state: string;
  district: string | null;
  products: string | null;
  lat: number | null;
  lon: number | null;
}

export interface RiskFlag {
  code: HsCode;
  description: string;
  vulnerability_score: number | null;
  reason: string;
}

/** Provenance block of the chain deep-dive (GET /api/valuechains/{id}). */
export interface ValueChainProvenance {
  trade?: Provenance | null;
  /** Mapping provenance with the number of curated rows (`counts`). */
  mapping?: MappingProvenance | null;
  scores?: Provenance | null;
}

export interface ValueChainDetail {
  chain: {
    id: string;
    name: string;
    title: string | null;
    anchor_hs: HsCode;
    description: string | null;
    phase: string | null;
    source: string | null;
    lead_ministry: MinistryRef | null;
  };
  /** Curator notes on the chain, when any. */
  notes?: string[] | null;
  provenance?: ValueChainProvenance | null;
  /** Keys in order: global_production, india_production, india_output, global_exports, india_exports, india_share, india_imports */
  kpis: ValueChainKpi[];
  india_rank: { rank: number | null; n_suppliers: number | null; text: string | null };
  stages: ValueChainStage[];
  /** True when the chain has supplier tiers (GET /api/valuechains/{id}/tiers returns them). */
  has_tiers?: boolean;
  world_top_suppliers: CountryValue[];
  world_top_markets: CountryValue[];
  india_top_destinations: CountryValue[];
  india_top_sources: CountryValue[];
  /** Top 5 hs6 under the anchor by India exports. */
  top_export_categories: Array<{ code: HsCode; label: string; value: number | null }>;
  manufacturers: Manufacturer[];
  clusters: Cluster[];
  skill_council: { name: string; url: string | null } | null;
  schemes: SchemeRef[];
  risk_flags: RiskFlag[];
}

export interface ValueChainMappingRow extends ValueChainRowFields {
  s_no: number | string | null;
  stage_id: string;
  stage: string;
  item: string;
  hs_code: HsCode | null;
  description: string | null;
  ministry_text: string | null;
  linked_hsn8: HsCode | null;
  /** The Atlas's live product mapping. */
  ministries?: MinistryRef[];
  /** The stage item behind the row (`ValueChainItem.id`). */
  item_id?: number | null;
}

/** Stage header of the mapping table. */
export interface ValueChainMappingStage {
  stage_id: string;
  name: string;
  order: number;
  ministry_text: string | null;
}

export interface ValueChainMapping {
  chain_id: string;
  title: string | null;
  rows: ValueChainMappingRow[];
  stages?: ValueChainMappingStage[];
  /** Curator notes on the chain, when any. */
  notes?: string[] | null;
  /** The table's provenance. */
  provenance?: MappingProvenance | null;
}

export interface NetworkNode {
  id: string;
  code: HsCode;
  label: string;
  description: string | null;
  level: number;
  ministry_id: string | null;
  ministry_short: string | null;
  color: string | null;
  sector_id: string | null;
  exports: number | null;
  imports: number | null;
  world_trade: number | null;
  rca: number | null;
  vulnerability_score: number | null;
  production: { value: number | null; unit: string | null } | null;
  chain_ids: string[];
  stage_id: string | null;
  is_center: boolean;
}

export interface NetworkEdge {
  id: string;
  source: string;
  target: string;
  relation: VcRelation;
  chain_id: string | null;
  /** 'curated' | 'hs_text' */
  source_kind: string;
}

export interface NetworkResponse {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  stats: { n_nodes: number; n_edges: number; chains: string[] };
}

export interface NetworkParams {
  chain_id?: string;
  center?: string;
  depth?: number;
  include_parts?: boolean;
}

export type TraceDirection = 'upstream' | 'downstream' | 'both';

export interface TraceParams {
  direction?: TraceDirection;
  depth?: number;
}

export interface CriticalInput {
  code: HsCode;
  description: string;
  vulnerability_score: number | null;
  imports: number | null;
  top_import_source: string | null;
  reason: string;
}

export interface TraceResponse extends NetworkResponse {
  critical_inputs: CriticalInput[];
}

// ============================================================================ 6.6 analytics (GOV_ROLES)

/** Common analytics filters (SPEC 6.6). */
export interface AnalyticsFilters {
  ministry_id?: string;
  sector_id?: string;
  chapter?: string;
  chain_id?: string;
  /** default 50, max 500 */
  limit?: number;
  min_world_trade?: number;
  min_imports?: number;
}

export interface OpportunityItem extends Hs6ItemBase {
  india_exports: number | null;
  world_trade: number | null;
  rca: number | null;
  world_cagr: number | null;
  export_cagr: number | null;
  export_potential_score: number | null;
  untapped_potential_usd: number | null;
  archetype: Archetype | null;
  india_world_share: number | null;
}

export interface OpportunityMatrixPoint {
  hs6: HsCode;
  label: string;
  /** RCA */
  x: number | null;
  /** world CAGR (fraction) */
  y: number | null;
  /** world trade US$ */
  size: number | null;
  archetype: Archetype | null;
}

export interface OpportunitiesResponse {
  items: OpportunityItem[];
  matrix: OpportunityMatrixPoint[];
  summary: { total_untapped_usd: number | null; n_products: number };
}

export interface ImportDependencyItem extends Hs6ItemBase {
  india_imports: number | null;
  india_exports: number | null;
  dependency_ratio: number | null;
  india_import_hhi: number | null;
  top_import_source: string | null;
  top_import_source_name: string | null;
  top_import_source_share: number | null;
  china_import_share: number | null;
  import_dependency_score: number | null;
  vulnerability_score: number | null;
}

export interface SourceCountryRow {
  country_id: string;
  country: string;
  imports: number | null;
  n_products: number;
}

export interface ImportDependencyResponse {
  items: ImportDependencyItem[];
  by_source_country: SourceCountryRow[];
  summary: { total_imports: number | null; china_share: number | null };
}

export interface ImportSubstitutionItem extends Hs6ItemBase {
  india_imports: number | null;
  india_exports: number | null;
  rca: number | null;
  world_supplier_hhi: number | null;
  mfn_tariff: number | null;
  substitution_score: number | null;
  schemes: SchemeRef[];
}

export interface ImportSubstitutionResponse {
  items: ImportSubstitutionItem[];
  /** SPEC leaves the summary open; typical keys: n_products, total_imports. */
  summary: Record<string, number | string | null>;
}

export interface CompetitivenessItem extends Hs6ItemBase {
  india_exports: number | null;
  world_trade: number | null;
  rca: number | null;
  india_world_share?: number | null;
  export_cagr?: number | null;
}

export interface CompetitivenessResponse {
  histogram: Array<{ bucket: string; count: number; exports: number | null }>;
  by_sector: Array<{ sector_id: string; name: string; rca_weighted: number | null; n_rca_gt1: number; exports: number | null }>;
  top_rca: CompetitivenessItem[];
  summary: { n_rca_gt1: number; exports_rca_gt1_share: number | null };
}

export interface DemandSupplyParams {
  chain_id?: string;
  sector_id?: string;
}

export interface DemandSupplyItem {
  code: HsCode;
  description: string;
  production: number | null;
  unit: string | null;
  imports: number | null;
  exports: number | null;
  /** production + imports - exports, only when production is in value terms; else null */
  apparent_consumption: number | null;
  self_sufficiency: number | null;
  provenance: Provenance;
}

export interface DemandSupplyResponse {
  items: DemandSupplyItem[];
}

export interface ArchetypeSummary {
  name: Archetype | string;
  n: number;
  exports: number | null;
  imports: number | null;
  examples: Array<{ hs6: HsCode; description: string }>;
}

export interface ClusterSummary {
  id: number;
  n: number;
  centroid: Record<string, number | null>;
  label: string;
  examples: Array<{ hs6: HsCode; description: string }>;
}

export interface ArchetypesResponse {
  archetypes: ArchetypeSummary[];
  clusters: ClusterSummary[];
}

export interface ForecastResponse {
  code: HsCode;
  description: string;
  history: TradeSeriesPoint[];
  forecast: ForecastSet;
  method: string;
}

export type TrendLevel = 'total' | 'ministry' | 'sector' | 'chapter';

export interface TrendsParams {
  level?: TrendLevel;
  id?: string;
}

export interface TrendsResponse {
  series: TradeSeriesPoint[];
}

// ============================================================================ 6.7 policy

export interface PolicyUseCase {
  id: 'import_substitution' | 'pli_targeting' | 'trade_negotiations' | 'skilling' | 'quality_control' | string;
  title: string;
  description: string;
  question: string;
  /** UI route that answers it, e.g. '/analytics?tab=substitution' */
  route: string;
  metrics: string[];
}

export interface SchemeListItem {
  id: string;
  name: string;
  kind: 'PLI' | 'QCO' | string;
  ministry: MinistryRef | null;
  outlay_crore: number | null;
  launched: string | null;
  description: string | null;
  url: string | null;
  n_products: number;
  exports: number | null;
  imports: number | null;
  source: string | null;
}

export interface SchemeDetail {
  scheme: SchemeListItem;
  kpis: { n_products: number; exports: number | null; imports: number | null; trade_balance: number | null; avg_rca: number | null };
  /** <= 200 */
  products: ProductSummary[];
  top_dependencies: DependencyHotspot[];
}

export interface AgreementPartner {
  id: string;
  name: string;
}

export interface TradeAgreement {
  id: string;
  name: string;
  short_name: string | null;
  partners: AgreementPartner[];
  status: 'in_force' | 'signed' | 'negotiating' | string;
  year: number | null;
  url: string | null;
  notes: string | null;
  india_exports_to: number | null;
  india_imports_from: number | null;
}

export interface NegotiationParams {
  partner?: string;
  agreement?: string;
}

export interface BilateralFlowItem {
  hs6: HsCode;
  description: string;
  value: number | null;
}

export interface OffensiveInterest {
  hs6: HsCode;
  description: string;
  partner_imports_world: number | null;
  india_exports_to_partner: number | null;
  india_rca: number | null;
  gap_usd: number | null;
  india_mfn: number | null;
}

export interface DefensiveInterest {
  hs6: HsCode;
  description: string;
  india_imports_from_partner: number | null;
  partner_rca: number | null;
  india_rca: number | null;
  india_mfn: number | null;
  reason: string;
}

export interface NegotiationResponse {
  partners: AgreementPartner[];
  bilateral: {
    india_exports_to: number | null;
    india_imports_from: number | null;
    balance: number | null;
    top_exports: BilateralFlowItem[];
    top_imports: BilateralFlowItem[];
  };
  offensive: OffensiveInterest[];
  defensive: DefensiveInterest[];
  summary: { n_offensive: number; n_defensive: number; total_gap_usd: number | null };
}

export interface SimulateTariffRequest {
  codes: HsCode[];
  new_tariff_pct: number;
  /** default 2.5 */
  elasticity?: number;
  /** default 0.5 */
  substitution_share?: number;
  /** default 0.10 */
  input_cost_share?: number;
}

export interface SimulationResultRow {
  code: HsCode;
  hs6: HsCode;
  description: string;
  tariff_before: number | null;
  tariff_after: number | null;
  imports_before: number | null;
  imports_after: number | null;
  delta_imports: number | null;
  revenue_before: number | null;
  revenue_after: number | null;
  domestic_opportunity_usd: number | null;
}

export interface SimulateTariffResponse {
  results: SimulationResultRow[];
  downstream: Array<{ code: HsCode; description: string; via: string; cost_increase_pct: number | null }>;
  totals: {
    imports_before: number | null;
    imports_after: number | null;
    delta_imports: number | null;
    revenue_before: number | null;
    revenue_after: number | null;
    domestic_opportunity_usd: number | null;
  };
  assumptions: { elasticity: number; substitution_share: number; input_cost_share: number; formula: string };
}

export interface SkillingParams {
  chain_id?: string;
  sector_id?: string;
}

export interface SkillCouncil {
  id: string;
  name: string;
  url: string | null;
  sectors: string[];
  chains: string[];
}

// ============================================================================ 6.8 risk (GOV)

export type AlertKind = 'import_surge' | 'export_drop' | 'concentration' | 'china_dependence' | string;
export type Severity = 'high' | 'medium' | 'low';

export interface Alert {
  id: number;
  kind: AlertKind;
  hs6: HsCode;
  description: string;
  severity: Severity;
  title: string;
  detail: string | null;
  value: number | null;
  created_at: IsoDateTime;
}

export interface AlertParams {
  severity?: Severity;
  kind?: AlertKind;
  limit?: number;
}

export interface VulnerableItem extends Hs6ItemBase {
  vulnerability_score: number | null;
  top_import_source_name: string | null;
  china_import_share: number | null;
  india_imports?: number | null;
  india_exports?: number | null;
  dependency_ratio?: number | null;
  india_import_hhi?: number | null;
}

export interface RiskOverviewResponse {
  kpis: {
    high_risk_products: number;
    imports_at_risk_usd: number | null;
    china_dependent_imports_usd: number | null;
    concentrated_products: number;
  };
  top_vulnerable: VulnerableItem[];
  by_sector: Array<{ sector_id: string; name: string; avg_vulnerability: number | null; imports_at_risk: number | null }>;
  by_source_country: Array<{ country_id: string; country: string; imports_at_risk: number | null; n_products: number }>;
  /** <= 20 */
  alerts: Alert[];
}

// ============================================================================ 6.9 residual workbench

export interface ResidualProduct extends ProductSummary {
  pending_claims: number;
}

export interface ResidualParams extends PageParams {
  q?: string;
}

export interface ResidualSuggestion {
  ministry: MinistryRef;
  score: number;
  similar: Array<{ hsn8: HsCode; description: string }>;
}

export interface ResidualSuggestResponse {
  hsn8: HsCode;
  suggestions: ResidualSuggestion[];
}

export interface ClaimRequest {
  ministry_id: string;
  justification: string;
}

export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface ResidualClaim {
  id: number;
  hsn8: HsCode;
  description: string | null;
  ministry: MinistryRef | null;
  claimed_by_name: string | null;
  justification: string | null;
  status: ClaimStatus;
  created_at: IsoDateTime;
  reviewed_at: IsoDateTime | null;
  review_note: string | null;
}

export interface ClaimReviewRequest {
  decision: 'approve' | 'reject';
  note?: string;
}

// ============================================================================ 6.10 helpdesk

export type TicketCategory = 'classification' | 'tariff' | 'policy_support' | 'trade_remedy' | 'other';
export type TicketStatus = 'open' | 'in_progress' | 'resolved';

export interface CreateTicketRequest {
  hsn8?: HsCode;
  subject: string;
  body: string;
  category: TicketCategory;
  submitter_name?: string;
  submitter_org?: string;
  submitter_email?: string;
}

/** Ticket row (schema.sql `tickets`), optionally enriched by the API. */
export interface Ticket {
  id: number;
  hsn8: HsCode | null;
  subject: string;
  body: string;
  category: TicketCategory | string;
  submitter_name: string | null;
  submitter_org: string | null;
  submitter_email: string | null;
  submitted_by: number | null;
  routed_ministry_id: string | null;
  status: TicketStatus;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  routed_ministry?: MinistryRef | null;
  product_description?: string | null;
  n_messages?: number;
}

export interface TicketMessage {
  id: number;
  ticket_id: number;
  author_id: number | null;
  author_name: string | null;
  author_role: Role | string | null;
  body: string;
  ts: IsoDateTime;
}

export interface CreateTicketResponse {
  ticket: Ticket;
  routed_ministry: MinistryRef | null;
}

/** POST /api/tickets/{id}/messages: the new message plus the ticket (a reply may move it open -> in_progress). */
export interface AddTicketMessageResponse {
  message: TicketMessage;
  ticket: Ticket;
}

/** POST /api/tickets/{id}/status {status, routed_ministry_id?}: the updated (possibly forwarded) ticket. */
export interface SetTicketStatusResponse {
  ticket: Ticket;
}

export interface TicketListParams extends PageParams {
  status?: TicketStatus;
}

export interface TicketDetail {
  ticket: Ticket;
  messages: TicketMessage[];
  product: ProductSummary | null;
}

export interface TicketStats {
  by_status: Array<{ status: TicketStatus | string; n: number }>;
  by_ministry: Array<{ ministry_id: string | null; short_name?: string | null; n: number; open?: number }>;
  avg_resolution_hours: number | null;
}

// ============================================================================ 6.11 data hub

export interface DataSource {
  id: string;
  name: string;
  owner: string | null;
  kind: 'api' | 'file' | 'manual' | string;
  status: 'connected' | 'not_configured' | 'error' | string;
  last_refreshed: IsoDateTime | null;
  records: number | null;
  url: string | null;
  licence: string | null;
  description: string | null;
  refresh_cron: string | null;
}

export interface RefreshJob {
  id: number;
  source_id: string;
  started_at: IsoDateTime;
  finished_at: IsoDateTime | null;
  status: 'running' | 'success' | 'failed' | 'not_configured' | string;
  records: number | null;
  message: string | null;
  triggered_by: number | null;
}

export type UploadKind = 'ministry_mapping' | 'production' | 'value_chain_edges';

export interface Upload {
  id: number;
  kind: UploadKind;
  filename: string;
  stored_path?: string | null;
  uploaded_by: number | null;
  ts: IsoDateTime;
  status: 'validated' | 'applied' | 'rejected' | string;
  rows_total: number | null;
  rows_valid: number | null;
  errors_json?: string | null;
  applied_at: IsoDateTime | null;
}

export interface UploadError {
  row: number;
  error: string;
}

export interface UploadResponse {
  upload: Upload;
  /** first 10 rows as parsed */
  preview: Array<Record<string, unknown>>;
  errors: UploadError[];
}

export interface DataQualityResponse {
  coverage: {
    products: number;
    with_trade: number;
    with_tariff: number;
    with_production: number;
    mapping_guidebook: number;
    mapping_rule: number;
    mapping_official: number;
    mapping_manual: number;
    mapping_guidebook_residual: number;
    mapping_unmapped: number;
    residual: number;
    mapping_verified: number;
    avg_quality: number | null;
  };
  by_ministry: Array<{
    ministry_id: string;
    short_name: string;
    codes: number;
    with_trade_pct: number | null;
    verified_pct: number | null;
    avg_quality: number | null;
  }>;
  cross_checks: Array<{
    hs6: HsCode;
    year: number;
    flow: TradeFlow;
    comtrade_value: number | null;
    baci_value: number | null;
    diff_pct: number | null;
  }>;
  quality_histogram: Array<{ bucket: string; count: number }>;
}

// ============================================================================ 6.12 reports

/** Filters accepted by GET /api/reports/search (same as the HSN search). */
export type SearchReportParams = Omit<ProductSearchParams, 'page' | 'page_size'>;

// ============================================================================ 6.13 admin, roadmap, watchlist

/** User row for administration (never includes password_hash). */
export interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: Exclude<Role, 'public'>;
  ministry_id: string | null;
  organisation: string | null;
  active: boolean | number;
  is_demo: boolean | number;
  created_at: IsoDateTime;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  name: string;
  role: Exclude<Role, 'public'>;
  ministry_id?: string | null;
  organisation?: string | null;
}

export interface UpdateUserRequest {
  name?: string;
  role?: Exclude<Role, 'public'>;
  ministry_id?: string | null;
  organisation?: string | null;
  active?: boolean;
  password?: string;
}

export interface AuditEntry {
  id: number;
  ts: IsoDateTime;
  user_id: number | null;
  user_email: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  /** parsed details_json (backends may also send the raw string as details_json) */
  details?: Record<string, unknown> | null;
  details_json?: string | null;
}

export interface AuditParams extends PageParams {
  action?: string;
}

export type RoadmapStatus = 'done' | 'in_progress' | 'planned';

export interface RoadmapItem {
  id: string;
  phase: 'Phase 0' | 'Phase I' | 'Phase II' | string;
  workstream: string | null;
  title: string;
  description: string | null;
  start_month: number | null;
  end_month: number | null;
  status: RoadmapStatus;
  owner: string | null;
  platform_route: string | null;
  sort_order: number | null;
}

export interface RoadmapResponse {
  phases: Array<{ phase: string; label: string; months: string; items: RoadmapItem[] }>;
  progress: { done: number; in_progress: number; planned: number; pct: number };
}

export type RiskStatus = 'open' | 'mitigating' | 'closed';

/** Programme risk register row (schema.sql `risks`). */
export interface RiskRegisterRow {
  id: number;
  area: string;
  risk: string;
  mitigation: string;
  likelihood: number | null;
  impact: number | null;
  status: RiskStatus;
  owner: string | null;
  platform_control: string | null;
}

export interface UpdateRiskRequest {
  status?: RiskStatus;
  owner?: string | null;
  likelihood?: number;
  impact?: number;
}

// ============================================================================ 6.14 AI assistant

/** 'claude', a free OpenAI-compatible provider ('groq' | 'xai' | 'gemini' | 'openrouter' | 'custom'), or 'offline'. */
export type AssistantMode = 'claude' | 'offline' | (string & {});

export interface AssistantStatus {
  mode: AssistantMode;
  model: string | null;
  /** Human label of the provider, e.g. 'Groq' (null offline). */
  provider?: string | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
}

export interface Citation {
  type: 'product' | 'ministry' | 'chain' | 'hs6' | string;
  id: string;
  label: string;
  route: string;
}

export interface ChatResponse {
  /** markdown */
  reply: string;
  citations: Citation[];
  mode: AssistantMode;
  tools_used: string[];
  model?: string | null;
}
