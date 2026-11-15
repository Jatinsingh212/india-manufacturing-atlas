-- India Manufacturing Atlas — SQLite schema (the data contract shared by ETL, API and UI).
-- Money is always US$ (REAL, not millions). Years are INTEGER. Codes are TEXT with leading zeros.
-- Owner of this file: platform lead. Do not change column names without updating docs/SPEC.md.
PRAGMA foreign_keys = OFF;

-- ------------------------------------------------------------------ reference / nomenclature
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,            -- Roman numeral 'I'..'XXI'
  num INTEGER NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hs_nodes (       -- WCO HS2022 hierarchy
  code TEXT PRIMARY KEY,          -- '40', '4011', '401110'
  level INTEGER NOT NULL,         -- 2 | 4 | 6
  parent TEXT,                    -- NULL for chapters
  section_id TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_hs_nodes_parent ON hs_nodes(parent);

CREATE TABLE IF NOT EXISTS ministries (
  id TEXT PRIMARY KEY,            -- slug, see data/curated/ministries.json ('residual' = unmapped bucket)
  short_name TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_ministry TEXT,
  kind TEXT NOT NULL,             -- 'department' | 'ministry' | 'residual'
  website TEXT,
  color TEXT
);

CREATE TABLE IF NOT EXISTS sectors (
  id TEXT PRIMARY KEY,            -- slug, see data/curated/sectors.json
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  icon TEXT,                      -- lucide icon name
  chapters TEXT                   -- JSON array of 2-digit chapters
);

CREATE TABLE IF NOT EXISTS products (       -- India 8-digit national tariff lines (ITC-HS / GST HSN)
  hsn8 TEXT PRIMARY KEY,
  hs6 TEXT NOT NULL,
  hs4 TEXT NOT NULL,
  hs2 TEXT NOT NULL,
  section_id TEXT,
  description TEXT NOT NULL,      -- display label (sentence case)
  line_description TEXT,          -- raw national line text from GST master
  full_description TEXT,          -- 'Heading — Subheading — Line'
  sector_id TEXT,
  ministry_id TEXT NOT NULL,      -- primary owner; 'residual' when unmapped
  mapping_status TEXT NOT NULL,   -- 'accepted' | 'residual'
  mapping_source TEXT NOT NULL,   -- 'dpiit_guidebook' | 'official_upload' | 'manual' | 'rule' | 'unmapped'
  mapping_confidence REAL,        -- 0..1
  mapping_rule TEXT,              -- human-readable rule id, e.g. 'ch61->mot'
  is_current INTEGER NOT NULL DEFAULT 1,   -- 1 if HS6 valid in HS2022
  lines_in_hs6 INTEGER NOT NULL DEFAULT 1  -- number of current lines sharing this hs6 (aggregation weight = 1/lines_in_hs6)
);
CREATE INDEX IF NOT EXISTS ix_products_hs6 ON products(hs6);
CREATE INDEX IF NOT EXISTS ix_products_hs4 ON products(hs4);
CREATE INDEX IF NOT EXISTS ix_products_hs2 ON products(hs2);
CREATE INDEX IF NOT EXISTS ix_products_ministry ON products(ministry_id);
CREATE INDEX IF NOT EXISTS ix_products_sector ON products(sector_id);

CREATE TABLE IF NOT EXISTS product_ministries (  -- all owners incl. secondary (e.g. silica: Mines + DCPC)
  hsn8 TEXT NOT NULL,
  ministry_id TEXT NOT NULL,
  role TEXT NOT NULL,             -- 'primary' | 'secondary'
  PRIMARY KEY (hsn8, ministry_id)
);
CREATE INDEX IF NOT EXISTS ix_pm_ministry ON product_ministries(ministry_id);

-- Official DPIIT Guidebook mapping (16.12.2025 revision), including every code in the published
-- accepted and residual tables. Rows are loaded by scripts/etl/load_official_mapping.py.
CREATE TABLE IF NOT EXISTS guidebook_mapping (
  hsn8 TEXT PRIMARY KEY,
  status TEXT NOT NULL,                 -- 'accepted' | 'residual'
  primary_ministry_id TEXT,             -- first-listed owner for accepted codes, NULL for residual
  ministries_json TEXT NOT NULL DEFAULT '[]',  -- every accepting ministry/department, in Guidebook order
  probable_ministry TEXT,               -- residual table's "probable ministry/department" text
  description TEXT,
  page INTEGER,                         -- PDF page of the first occurrence
  source TEXT NOT NULL DEFAULT 'dpiit_guidebook'
);
CREATE INDEX IF NOT EXISTS ix_guidebook_status ON guidebook_mapping(status);

-- Full-text search over products (rebuilt by ETL; rowid = products.rowid)
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  hsn8, description, full_description, ministry, sector, tokenize = 'porter unicode61'
);

-- ------------------------------------------------------------------ trade (CEPII BACI via OEC; HS6, US$)
CREATE TABLE IF NOT EXISTS countries (
  id TEXT PRIMARY KEY,            -- OEC id, e.g. 'asind'
  iso3 TEXT,                      -- 'IND'
  name TEXT NOT NULL,
  continent TEXT                  -- 'Asia' | 'Europe' | 'Africa' | 'North America' | 'South America' | 'Oceania' | 'Other'
);

CREATE TABLE IF NOT EXISTS country_totals (
  country_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  exports REAL,
  imports REAL,
  PRIMARY KEY (country_id, year)
);

CREATE TABLE IF NOT EXISTS hs6_products (    -- every HS6 with trade data (description + chapter)
  hs6 TEXT PRIMARY KEY,
  hs4 TEXT NOT NULL,
  hs2 TEXT NOT NULL,
  description TEXT NOT NULL,
  sector_id TEXT,
  n_lines INTEGER NOT NULL DEFAULT 0          -- India 8-digit lines under it
);

CREATE TABLE IF NOT EXISTS trade_hs6 (       -- yearly series 2018..2024
  hs6 TEXT NOT NULL,
  year INTEGER NOT NULL,
  india_exports REAL,             -- official DGCIS FY value (NULL when not reported)
  india_imports REAL,
  world_trade REAL,               -- sum of all countries' exports of the product
  PRIMARY KEY (hs6, year)
);

-- Official DGCIS / TRADESTAT 8-digit national lines (FY2018-19 .. FY2024-25, US$).
-- This is the authoritative source for India's trade. BACI remains the source for world trade
-- and for the world exporter/importer tables. A line absent from a flow's published table is
-- NULL (not zero): the Atlas shows "Not available" rather than inventing a value.
CREATE TABLE IF NOT EXISTS trade_hs8 (
  hsn8 TEXT NOT NULL,
  year INTEGER NOT NULL,
  india_exports REAL,
  india_imports REAL,
  PRIMARY KEY (hsn8, year)
);
CREATE INDEX IF NOT EXISTS ix_trade_hs8_year ON trade_hs8(year);

-- Official DGCIS bilateral trade by 8-digit line for the latest year (FY2024-25, US$).
-- Aggregated to HS6 into india_partners for the product / value-chain panels.
CREATE TABLE IF NOT EXISTS india_partners_hs8 (
  hsn8 TEXT NOT NULL,
  flow TEXT NOT NULL,             -- 'X' India exports to country | 'M' India imports from country
  country_id TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (hsn8, flow, country_id)
);
CREATE INDEX IF NOT EXISTS ix_ip8_country ON india_partners_hs8(country_id, flow);

-- Product-line allocation of the official India totals (latest year). A line that TRADESTAT
-- publishes keeps the exact national figure; the other national lines of the same reported group
-- share the remainder (undefined for the few codes DGCIS reports but the Atlas has no line for).
-- Used only for summing over lines (ministry panels, analytics); the product page keeps the exact
-- per-line values so "not published separately" is never silently replaced by a derived one.
CREATE TABLE IF NOT EXISTS alloc_products (
  hsn8 TEXT PRIMARY KEY,
  exports_alloc REAL,
  imports_alloc REAL
);

CREATE TABLE IF NOT EXISTS india_partners (  -- latest year, ALL partners (not only top-N)
  hs6 TEXT NOT NULL,
  flow TEXT NOT NULL,             -- 'X' India exports to country | 'M' India imports from country
  country_id TEXT NOT NULL,
  value REAL NOT NULL,
  share REAL,                     -- share of India's flow for this hs6
  rank INTEGER,
  PRIMARY KEY (hs6, flow, country_id)
);
CREATE INDEX IF NOT EXISTS ix_ip_country ON india_partners(country_id, flow);

CREATE TABLE IF NOT EXISTS world_suppliers ( -- latest year, ALL exporters of each hs6
  hs6 TEXT NOT NULL,
  country_id TEXT NOT NULL,
  value REAL NOT NULL,
  share REAL,
  rank INTEGER,
  PRIMARY KEY (hs6, country_id)
);
CREATE INDEX IF NOT EXISTS ix_ws_country ON world_suppliers(country_id);

CREATE TABLE IF NOT EXISTS world_markets (   -- latest year, ALL importers of each hs6
  hs6 TEXT NOT NULL,
  country_id TEXT NOT NULL,
  value REAL NOT NULL,
  share REAL,
  rank INTEGER,
  PRIMARY KEY (hs6, country_id)
);
CREATE INDEX IF NOT EXISTS ix_wm_country ON world_markets(country_id);

CREATE TABLE IF NOT EXISTS tariffs (          -- India MFN applied (WITS/TRAINS, HS6 simple average of national lines)
  hs6 TEXT PRIMARY KEY,
  mfn_avg REAL,                   -- percent; NULL when non-ad-valorem / not available
  mfn_min REAL,
  mfn_max REAL,
  n_lines INTEGER,
  n_na_lines INTEGER,
  year INTEGER,
  source TEXT
);

-- DGFT ITC-HS import / export policy (public Discover portal, 8-digit). Every published record is
-- kept, including duplicates; exactly one row per itc_code + direction is is_current = 1 (the last
-- record in portal order). Loaded by scripts/etl/load_dgft_itc.py from
-- data/raw/dgft_itc/dgft_itc_policy.jsonl.gz.
CREATE TABLE IF NOT EXISTS dgft_itc_policy (
  itc_code TEXT NOT NULL,
  direction TEXT NOT NULL,        -- 'import' (Schedule I) | 'export' (Schedule II)
  record_index INTEGER NOT NULL,  -- API order within itc_code + direction (0-based)
  chapter TEXT NOT NULL,          -- 2-digit chapter of the published table
  description TEXT,
  policy TEXT,                    -- as published ('Free', 'Restricted', 'Prohibited', 'STE ...'); NULL = not specified
  policy_condition TEXT,          -- plain text (HTML stripped), NULL when none
  itc_code_type TEXT,             -- portal 'YES' / 'NO' flag for the direction
  notification_no TEXT,
  notification_date TEXT,         -- as published (DD/MM/YYYY, DD.MM.YYYY, ...)
  notification_date_iso TEXT,     -- normalised YYYY-MM-DD when parseable
  is_current INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'dgft_itc_hs',
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (itc_code, direction, record_index)
);
CREATE INDEX IF NOT EXISTS ix_dgft_policy_current ON dgft_itc_policy(direction, is_current, itc_code);
CREATE INDEX IF NOT EXISTS ix_dgft_policy_chapter ON dgft_itc_policy(chapter);



CREATE TABLE IF NOT EXISTS hs6_metrics (      -- precomputed, latest year
  hs6 TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  india_exports REAL,
  india_imports REAL,
  world_trade REAL,
  trade_balance REAL,
  rca REAL,                       -- Balassa revealed comparative advantage
  india_world_share REAL,         -- 0..1
  india_supplier_rank INTEGER,
  n_suppliers INTEGER,
  world_supplier_hhi REAL,        -- 0..1
  india_import_hhi REAL,          -- 0..1
  n_import_sources INTEGER,
  top_import_source TEXT,         -- country_id
  top_import_source_share REAL,   -- 0..1
  china_import_share REAL,        -- 0..1
  top_destination TEXT,           -- country_id
  top_destination_share REAL,
  export_cagr REAL,               -- fraction per year
  import_cagr REAL,
  world_cagr REAL,
  export_yoy REAL,
  import_yoy REAL,
  world_yoy REAL,
  first_year INTEGER              -- first year used for CAGRs
);

-- Aggregation view: every product line with its official DGCIS 8-digit India flow and the BACI
-- HS6 world total. India's exports/imports are the exact published national line (NULL when DGCIS
-- does not report the line separately); world trade is the HS6 subheading total, allocated to the
-- line only for summing across products (world_alloc). `metric_hs6` is the HS6 used for series,
-- RCA / world-share / partner metrics. A line with no exact HS6 row falls back to BACI's heading
-- aggregate (<hs4>00, e.g. 2710 -> 271000) for those context metrics.
DROP VIEW IF EXISTS v_product_trade;
CREATE VIEW v_product_trade AS
SELECT *, alloc_x AS exports_alloc,
          alloc_m AS imports_alloc,
          COALESCE(world_trade, 0) * weight AS world_alloc
FROM (
  SELECT p.hsn8, p.hs6, p.hs4, p.hs2, p.ministry_id, p.sector_id, p.mapping_status,
         e.hs6 AS exact_hs6, m.hs6 AS metric_hs6,
         e.india_exports AS hs6_india_exports, e.india_imports AS hs6_india_imports,
         CASE WHEN h8.hsn8 IS NOT NULL THEN 'hs8'
              WHEN e.hs6 IS NOT NULL THEN 'hs6'
              WHEN m.hs6 IS NOT NULL THEN 'hs4_aggregate' END AS trade_level,
         COALESCE(a.exports_alloc, 0) AS alloc_x,
         COALESCE(a.imports_alloc, 0) AS alloc_m,         CASE WHEN e.hs6 IS NOT NULL THEN 1.0 / p.lines_in_hs6
              WHEN m.hs6 IS NOT NULL THEN 1.0 / (SELECT COUNT(*) FROM products p2 WHERE p2.hs4 = p.hs4)
         END AS weight,
         m.year, h8.india_exports, h8.india_imports, m.world_trade,
         CASE WHEN h8.india_exports IS NOT NULL AND h8.india_imports IS NOT NULL
              THEN h8.india_exports - h8.india_imports END AS trade_balance,
         m.rca, m.india_world_share, m.india_supplier_rank, m.n_suppliers, m.world_supplier_hhi,
         m.india_import_hhi, m.n_import_sources, m.top_import_source, m.top_import_source_share,
         m.china_import_share, m.top_destination, m.top_destination_share, m.export_cagr,
         m.import_cagr, m.world_cagr, m.export_yoy, m.import_yoy, m.world_yoy, m.first_year,
         p.lines_in_hs6
  FROM products p
  LEFT JOIN trade_hs8 h8 ON h8.hsn8 = p.hsn8 AND h8.year = (SELECT MAX(year) FROM trade_hs8)
  LEFT JOIN hs6_metrics e ON e.hs6 = p.hs6
  LEFT JOIN hs6_metrics m ON m.hs6 = COALESCE(e.hs6, p.hs4 || '00')
  LEFT JOIN alloc_products a ON a.hsn8 = p.hsn8
);

CREATE TABLE IF NOT EXISTS production (       -- domestic production (sparse; 'not_available' when absent)
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,            -- 'hsn8' | 'hs4' | 'hs6' | 'chain'
  key TEXT NOT NULL,              -- code or chain id
  label TEXT,
  year INTEGER,
  value REAL,
  unit TEXT,                      -- 'tonnes' | 'units' | 'usd' ...
  source TEXT NOT NULL,
  status TEXT NOT NULL            -- 'verified' | 'not_verified'
);
CREATE INDEX IF NOT EXISTS ix_production_key ON production(scope, key);

-- ------------------------------------------------------------------ analytics outputs (etl/compute_scores.py)
CREATE TABLE IF NOT EXISTS hs6_scores (
  hs6 TEXT PRIMARY KEY,
  export_potential_score REAL,    -- 0..100
  untapped_potential_usd REAL,
  import_dependency_score REAL,   -- 0..100
  vulnerability_score REAL,       -- 0..100
  substitution_score REAL,        -- 0..100 (NULL when not a net importer)
  archetype TEXT,                 -- 'Champion' | 'Established' | 'Emerging' | 'Dependent' | 'Marginal'
  ml_cluster INTEGER,             -- k-means cluster id
  forecast_json TEXT,             -- {"exports":[{"year":2025,"value":..,"lo":..,"hi":..}], "imports":[...]}
  product_readiness_index REAL,   -- 0..100 multidimensional readiness index
  readiness_tier TEXT             -- 'Tier 1: Export Champion' | 'Tier 2: Scale-Ready' | 'Tier 3: Substitution Target' | 'Tier 4: Nascent'
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'import_surge' | 'export_drop' | 'concentration' | 'china_dependence'
  hs6 TEXT NOT NULL,
  severity TEXT NOT NULL,         -- 'high' | 'medium' | 'low'
  title TEXT NOT NULL,
  detail TEXT,
  value REAL,
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ value chains (curated; etl/load_value_chains.py)
CREATE TABLE IF NOT EXISTS value_chains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT,                     -- e.g. 'Tyre Sector (HS Code 4011)'
  anchor_hs TEXT NOT NULL,        -- HS prefix used for sector KPIs ('4011')
  lead_ministry_id TEXT,
  description TEXT,
  phase TEXT,                     -- 'Phase I pilot'
  source TEXT,                    -- 'curated'
  manufacturers_json TEXT,        -- [{"name":..., "url":...}]
  skill_council_json TEXT,        -- {"name":..., "url":...}
  sort_order INTEGER,
  notes_json TEXT                 -- optional curator notes
);

CREATE TABLE IF NOT EXISTS vc_stages (
  chain_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,         -- 'raw' | 'processing' | 'components' | 'finished' ...
  name TEXT NOT NULL,
  stage_order INTEGER NOT NULL,
  ministry_text TEXT,
  ministry_ids_json TEXT,
  PRIMARY KEY (chain_id, stage_id)
);

CREATE TABLE IF NOT EXISTS vc_items (
  id INTEGER PRIMARY KEY,
  chain_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  item_name TEXT NOT NULL,        -- 'Natural Rubber'
  hs_code TEXT,                   -- as curated: 8, 6 or 4 digits
  hsn8 TEXT,                      -- resolved 8-digit line when hs_code is 8 digits and exists
  description TEXT,
  ministry_text TEXT,
  ministry_ids_json TEXT,         -- the Atlas's product mapping
  source TEXT
);
CREATE INDEX IF NOT EXISTS ix_vc_items_chain ON vc_items(chain_id, stage_id);
CREATE INDEX IF NOT EXISTS ix_vc_items_code ON vc_items(hs_code);

-- supplier tiers: how deep the supply chain runs behind the finished product.
-- Tier 1 = direct suppliers to the manufacturer, Tier 2 = their suppliers,
-- Tier 3 = basic materials and commodities used by Tier 2 (curated; etl/load_supply_tiers.py).
CREATE TABLE IF NOT EXISTS vc_tiers (
  chain_id TEXT NOT NULL,
  tier_level INTEGER NOT NULL,      -- 1 = direct supplier .. 3 = basic materials
  name TEXT NOT NULL,               -- 'Tier 1 suppliers'
  description TEXT,
  examples_json TEXT,               -- JSON array of example supplier types
  sort_order INTEGER NOT NULL,
  source TEXT,
  PRIMARY KEY (chain_id, tier_level)
);

CREATE TABLE IF NOT EXISTS vc_tier_items (
  id INTEGER PRIMARY KEY,
  chain_id TEXT NOT NULL,
  tier_level INTEGER NOT NULL,
  item_order INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  hs_code TEXT,                     -- as curated: 8, 6 or 4 digits
  hsn8 TEXT,                        -- resolved 8-digit line when hs_code is 8 digits and exists
  description TEXT,
  ministry_text TEXT,
  ministry_ids_json TEXT,           -- the Atlas's product mapping
  source TEXT
);
CREATE INDEX IF NOT EXISTS ix_vc_tier_items_chain ON vc_tier_items(chain_id, tier_level);

CREATE TABLE IF NOT EXISTS vc_edges (            -- directed product interlinkages (input -> output)
  src TEXT NOT NULL,              -- HS code (8/6/4 digits)
  dst TEXT NOT NULL,
  relation TEXT NOT NULL,         -- 'input_to' | 'component_of' | 'parts_of'
  chain_id TEXT,                  -- NULL for links derived from HS text
  weight REAL DEFAULT 1,
  source TEXT NOT NULL,           -- 'curated' | 'hs_text' | 'official_upload'
  PRIMARY KEY (src, dst, relation)
);
CREATE INDEX IF NOT EXISTS ix_vc_edges_dst ON vc_edges(dst);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  district TEXT,
  chain_ids_json TEXT,
  sector_ids_json TEXT,
  products TEXT,
  lat REAL,
  lon REAL,
  source TEXT
);

-- ------------------------------------------------------------------ policy (curated; etl/load_policy.py)
CREATE TABLE IF NOT EXISTS schemes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'PLI' | 'QCO'
  ministry_id TEXT,
  outlay_crore REAL,
  launched TEXT,
  description TEXT,
  url TEXT,
  source TEXT
);
CREATE TABLE IF NOT EXISTS scheme_products (
  scheme_id TEXT NOT NULL,
  hs_prefix TEXT NOT NULL,        -- 2..8 digit prefix
  note TEXT,
  PRIMARY KEY (scheme_id, hs_prefix)
);
CREATE TABLE IF NOT EXISTS trade_agreements (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  partners_json TEXT NOT NULL,    -- JSON array of countries.id
  status TEXT NOT NULL,           -- 'in_force' | 'signed' | 'negotiating'
  year INTEGER,
  url TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS skill_councils (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sector_ids_json TEXT,
  chain_ids_json TEXT,
  url TEXT
);
CREATE TABLE IF NOT EXISTS info_pages (       -- left-panel content of the Guidebook dashboard
  id TEXT PRIMARY KEY,            -- 'about_hsn' | 'guidebook' | 'how_to_use' | 'cbic_tariff'
  title TEXT NOT NULL,
  icon TEXT,
  body_md TEXT NOT NULL,
  links_json TEXT,
  sort_order INTEGER
);

-- ------------------------------------------------------------------ governance / operations
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,    -- 'pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>'
  role TEXT NOT NULL,             -- 'admin' | 'ministry' | 'analyst' | 'industry'
  ministry_id TEXT,
  organisation TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id INTEGER,
  user_email TEXT,
  action TEXT NOT NULL,           -- 'login' | 'mapping.change' | 'claim.create' | 'upload.apply' ...
  entity TEXT,
  entity_id TEXT,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS mapping_changes (
  id INTEGER PRIMARY KEY,
  hsn8 TEXT NOT NULL,
  old_ministry_id TEXT,
  new_ministry_id TEXT,
  source TEXT NOT NULL,           -- 'claim' | 'official_upload' | 'manual'
  changed_by INTEGER,
  ts TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS residual_claims (
  id INTEGER PRIMARY KEY,
  hsn8 TEXT NOT NULL,
  ministry_id TEXT NOT NULL,
  claimed_by INTEGER,
  justification TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
  reviewed_by INTEGER,
  review_note TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS tickets (           -- industry <-> government interface
  id INTEGER PRIMARY KEY,
  hsn8 TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,         -- 'classification' | 'tariff' | 'policy_support' | 'trade_remedy' | 'other'
  submitter_name TEXT,
  submitter_org TEXT,
  submitter_email TEXT,
  submitted_by INTEGER,
  routed_ministry_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- 'open' | 'in_progress' | 'resolved'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  author_id INTEGER,
  author_name TEXT,
  author_role TEXT,
  body TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_sources (
  id TEXT PRIMARY KEY,            -- 'oec_baci' | 'wits_trains' | 'gst_hsn' | 'hs_nomenclature' | 'un_comtrade' | 'unido_indstat' | 'rubber_board' | 'atma' | 'cbic' | 'gstn' | 'dgft'
  name TEXT NOT NULL,
  owner TEXT,
  kind TEXT NOT NULL,             -- 'api' | 'file' | 'manual'
  status TEXT NOT NULL,           -- 'connected' | 'not_refreshed' (live connector never run) | 'not_configured' | 'error'
  last_refreshed TEXT,
  records INTEGER,
  url TEXT,
  licence TEXT,
  description TEXT,
  refresh_cron TEXT
);
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,           -- 'running' | 'success' | 'failed'
  records INTEGER,
  message TEXT,
  triggered_by INTEGER
);
CREATE TABLE IF NOT EXISTS comtrade_checks (   -- cross-validation of BACI against UN Comtrade reported values
  hs6 TEXT NOT NULL,
  year INTEGER NOT NULL,
  flow TEXT NOT NULL,             -- 'X' | 'M'
  comtrade_value REAL,
  baci_value REAL,
  diff_pct REAL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (hs6, year, flow)
);
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'ministry_mapping' | 'production' | 'value_chain_edges'
  filename TEXT NOT NULL,
  stored_path TEXT,
  uploaded_by INTEGER,
  ts TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'validated' | 'applied' | 'rejected'
  rows_total INTEGER,
  rows_valid INTEGER,
  errors_json TEXT,
  applied_at TEXT
);
CREATE TABLE IF NOT EXISTS watchlist (
  user_id INTEGER NOT NULL,
  hsn8 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, hsn8)
);

CREATE TABLE IF NOT EXISTS roadmap_items (
  id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,            -- 'Phase 0' | 'Phase I' | 'Phase II'
  workstream TEXT,                -- the 8 'what needs to be done' steps
  title TEXT NOT NULL,
  description TEXT,
  start_month INTEGER,            -- months from programme start
  end_month INTEGER,
  status TEXT NOT NULL,           -- 'done' | 'in_progress' | 'planned'
  owner TEXT,
  platform_route TEXT,            -- UI route that delivers it, e.g. '/network'
  sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS risks (
  id INTEGER PRIMARY KEY,
  area TEXT NOT NULL,
  risk TEXT NOT NULL,
  mitigation TEXT NOT NULL,
  likelihood INTEGER,             -- 1..5
  impact INTEGER,                 -- 1..5
  status TEXT NOT NULL,           -- 'open' | 'mitigating' | 'closed'
  owner TEXT,
  platform_control TEXT           -- how this platform implements the mitigation
);

-- ------------------------------------------------------------------ product deep-dive (etl/load_deep_dive.py)
-- Cluster Observatory (Foundation for MSME Clusters) cluster register, scraped by the
-- `cluster_observatory` connector. hs_prefixes_json is the Atlas' own product -> HS mapping
-- (curated in data/curated/deep_dive.json); the Observatory itself publishes no HS codes.
CREATE TABLE IF NOT EXISTS co_clusters (
  id TEXT PRIMARY KEY,            -- slug of type + name + state
  name TEXT NOT NULL,
  cluster_type TEXT NOT NULL,     -- 'industrial' | 'handicraft' | 'handloom' | 'micro' | 'services'
  state TEXT,
  district TEXT,
  district_source TEXT,           -- 'observatory' (register's district filter) | 'name' (inferred from the name)
  products TEXT,                  -- product label as published
  profile_url TEXT,               -- diagnostic study PDF, when published
  hs_prefixes_json TEXT,          -- ["9506", "95069920"] from the curated product map
  lat REAL,
  lon REAL,
  fetched_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'cluster_observatory'
);
CREATE INDEX IF NOT EXISTS ix_co_clusters_products ON co_clusters(products);

-- Destination markets and what India's exporters face there (curated + editable through the API).
CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,            -- 'us', 'eu', 'uk' ...
  name TEXT NOT NULL,
  wits_code TEXT NOT NULL,        -- WITS reporter code (840, 918 ...)
  country_ids_json TEXT NOT NULL, -- OEC country ids whose imports make up the market
  agreement TEXT,                 -- trade agreement with India in force, else NULL
  pref_rate_pct REAL,             -- duty on Indian goods under that agreement (NULL = MFN applies)
  extra_duty_pct REAL NOT NULL DEFAULT 0, -- additional duty on Indian-origin goods on top of MFN
  extra_duty_basis TEXT,
  extra_duty_status TEXT NOT NULL DEFAULT 'none', -- 'none' | 'verified' | 'user_input'
  source TEXT,
  as_of TEXT,
  note TEXT,
  sort_order INTEGER
);

-- Each market's own MFN applied tariff at HS6 (WITS / TRAINS, partner = World), `market_tariffs` connector.
CREATE TABLE IF NOT EXISTS market_tariffs (
  market_id TEXT NOT NULL,
  hs6 TEXT NOT NULL,
  mfn_avg REAL,
  mfn_min REAL,
  mfn_max REAL,
  year INTEGER,
  source TEXT NOT NULL,
  PRIMARY KEY (market_id, hs6)
);

-- Standards and conformity schemes per HS prefix and market (QCO / ISI / Hallmark in India; CE, CPSC ... abroad).
CREATE TABLE IF NOT EXISTS product_standards (
  id INTEGER PRIMARY KEY,
  hs_prefix TEXT NOT NULL,        -- 4..8 digits
  market_id TEXT NOT NULL,        -- 'in' for India, else markets.id
  scheme TEXT NOT NULL,           -- 'QCO' | 'ISI' | 'Hallmark' | 'CE (PPE)' | 'Federation approval' ...
  name TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'mandatory' | 'voluntary' | 'not_applicable' | 'none_found'
  body TEXT,
  url TEXT,
  note TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  as_of TEXT
);
CREATE INDEX IF NOT EXISTS ix_product_standards_prefix ON product_standards(hs_prefix);

-- India Industrial Land Bank parks (IIS 2.0 web API, `iilb` connector; needs an access token).
CREATE TABLE IF NOT EXISTS iilb_parks (
  park_no TEXT NOT NULL,
  state_lgc TEXT NOT NULL,
  name TEXT,
  state TEXT,
  district TEXT,
  sector TEXT,
  total_area_ha REAL,
  available_area_ha REAL,
  vacant_plots INTEGER,
  lat REAL,
  lon REAL,
  raw_json TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (state_lgc, park_no)
);

-- Product baskets: a study's own list of HS6 codes spanning several headings (e.g. "sports equipment" = 9506 +
-- 8712 + 9303/9304 + 9504 + 9507 + 9508). Loaded from data/curated/deep_dive.json by etl/load_deep_dive.py.
CREATE TABLE IF NOT EXISTS baskets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT,                    -- the study / table the list comes from
  sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS basket_codes (
  basket_id TEXT NOT NULL,
  hs6 TEXT NOT NULL,
  category TEXT NOT NULL,         -- the study's label
  study_world_exports REAL,       -- US$ as published by the study (for comparison with BACI)
  study_year INTEGER,
  note TEXT,                      -- e.g. HS-version caveats
  sort_order INTEGER,
  PRIMARY KEY (basket_id, hs6)
);
