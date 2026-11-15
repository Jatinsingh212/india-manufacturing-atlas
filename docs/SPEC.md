# India Manufacturing Atlas - Build Specification

This document describes the current implementation contract. The running code and the tests in
`backend/tests/` are authoritative; this is the map, not a substitute for them.

## 0. What the platform is

An HSN-code intelligence platform over India's 2-, 4-, 6- and 8-digit HS codes: search, ministry ownership,
trade, tariffs, value chains, production, policy analysis, risk, data quality and an assistant. The backend is
FastAPI + SQLite; the frontend is React 19 + TypeScript + Vite.

The platform uses real, sourced data only. Every number carries a provenance label:

| Status | Meaning | Examples |
|---|---|---|
| **Verified** | official/recognised source or approved upload | DPIIT Guidebook (16.12.2025), BACI, WITS, GST HSN master, HS 2022, UN Comtrade, UNIDO, Rubber Board, ATMA, `official_upload`, `manual` |
| **Not verified** | residual mapping, Atlas-curated mapping or model output | residual Guidebook lines, lines absent from the Guidebook, curated value-chain and tier mappings, scores, forecasts, archetypes, suggestions |
| **Not available** | no source value | missing production, non-ad-valorem tariff, absent trade record |

## 1. Architecture

```
browser (React 19 + Vite + TypeScript)
  |  /api/* JSON (fetch, Bearer JWT)
  v
FastAPI app/ (routers/, services/, services/connectors/)
  |  sqlite3, one connection per request, WAL
  v
backend/data/atlas.db
  ^
scripts/build_db.py -> scripts/etl/* -> schema, nomenclature, mapping, trade, tariffs,
metrics, value chains, supply tiers, policy, ops seed, scores
  ^
data/raw/ (downloads + manifest.json)   data/curated/ (platform-curated knowledge)
```

Conventions:

* JSON is UTF-8, snake_case, `null` for missing values (never 0 as a substitute).
* Dates are ISO 8601; money is US$ unless `unit` says otherwise.
* List endpoints return `{items, total, page, page_size}` unless documented otherwise.
* Pagination caps: `page_size <= 200`; reports stream their own files.
* Every mutating action is audited.

## 2. Auth and roles

Five roles: `public`, `industry`, `analyst`, `ministry`, `admin`.

* `public`: public pages, search, product/ministry/sector/value-chain data, assistant, reports.
* `industry`: public plus watchlist, own tickets, uploads they created.
* `analyst`: government analytics, risk, residual read, Data Hub read, all tickets.
* `ministry`: analyst scope restricted to the user's ministry for claims/tickets; uploads.
* `admin`: users, audit log, claim approval, upload apply, connector runs.

Auth endpoints: `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/demo-login`,
`GET /api/auth/me`, `POST /api/auth/logout`. Tokens are HS256 JWTs (12 h). Passwords use PBKDF2-SHA256
(200,000 iterations). Sign-in throttling is configurable.

## 3. ETL

Run from `backend/`:

```powershell
python -m scripts.build_db          # full build
python -m scripts.build_deploy_db   # slim copy + gzip for Vercel
```

The build writes `data/atlas.db.tmp`, runs the sanity gate, then atomically replaces `data/atlas.db`. Steps:

1. schema (`scripts/etl/schema.sql`)
2. HS 2022 nomenclature and GST 8-digit products
3. official DPIIT Guidebook mapping (`data/curated/ministry_mapping.json`) plus ministry/sector tags
4. BACI trade, WITS tariffs, metrics
5. value chains (`data/curated/value_chains.json`)
5b. supplier tiers (`data/curated/supply_tiers.json`)
6. part links from HS text
7. policy knowledge and info cards
8. operational seed (users, sources, tickets, claims, sourced production)
9. scores, archetypes, forecasts, alerts

`data/raw/manifest.json` records downloads. `data/curated/production.json` is the only production source:
UNIDO INDSTAT 2026 (2022 gross output, US$), Rubber Board (2024 natural rubber, tonnes), ATMA (2023 tyres, units).

## 4. Data model (main tables)

* `sections`, `hs_nodes`, `products` - HS hierarchy and India's 8-digit lines (`is_current` marks HS 2022-valid
  lines); full-text index `products_fts`.
* `ministries`, `sectors`, `product_ministries` - ownership and secondary owners. Primary ownership comes
  from the first-listed section in the Guidebook; other accepting ministries are secondary.
* `guidebook_mapping` - the published Guidebook rows (accepted and residual) with source page and SHA-256
  provenance. 2/4/6-digit ownership is not a separate table: it is aggregated on request from accepted
  8-digit lines, so it can never diverge from the direct mapping.
* `countries`, `hs6_products`, `world_suppliers`, `world_markets`, `india_partners`, `trade_series` - BACI trade.
* `tariffs` - WITS MFN applied averages at HS6, 2022.
* `production` - sourced production rows: `scope` (`chain` / `hs4` / `hs6`), `key`, `label`, `value`, `unit`,
  `year`, `source`, `status`.
* `value_chains`, `vc_stages`, `vc_items`, `vc_edges`, `clusters` - curated value chains. `value_chains.source` is
  always `curated`; `vc_items` has no presentation-slide fields. Chain-scope production is loaded by the ops seed.
* `vc_tiers`, `vc_tier_items` - curated supplier tiers: how deep the supply chain runs behind the finished
  product (Tier 1 = direct suppliers of the manufacturer, Tier 2 = their suppliers, Tier 3 = basic materials
  and commodities). A code can sit in a stage *and* in a tier, so the two views stay separate tables.
* `schemes`, `scheme_products`, `trade_agreements`, `skill_councils`, `info_pages`, `roadmap_items`, `risks`.

* `scores`, `alerts`, `archetypes`, `forecasts` - model outputs.
* `users`, `audit_log`, `tickets`, `ticket_messages`, `residual_claims`, `watchlist`, `data_sources`,
  `refresh_jobs`, `uploads`, `cross_checks`, `residual_suggestions`.

## 5. API

All routes are under `/api`. `GOV` means analyst/ministry/admin (anonymous 401, industry 403).

### System and meta

* `GET /api/health` -> `{status, built_at, latest_year, products, db_path, build_mode, version, routers}`
* `GET /api/meta/overview` - KPIs, distributions, mapping sources, and `mapping_by_level` coverage at
  2/4/6/8 digits (parent levels aggregate accepted 8-digit lines).
* `GET /api/meta/ministries`, `GET /api/meta/sectors`, `GET /api/meta/stats`, `GET /api/meta/info`,
  `GET /api/meta/provenance`, `GET /api/meta/years`
* `GET /api/meta/flow` - the Overview ownership tree: top sectors + `other`, top ministries + `other` +
  `residual`, all present mapping statuses, the 2-way links, and exact `sector_ministry_status` triples.
* `GET /api/meta/flow/detail?sector_id=&ministry_id=&status=` - the exact intersection behind a tree
  selection: line count, share, exports/imports, actual sector/ministry/status breakdowns, the six largest
  8-digit lines by allocated exports and provenance. Supplied ids must be visible flow nodes; `other`
  selects the folded tail and unknown ids return 404.

### HSN / products

* `GET /api/hsn/tree`, `GET /api/hsn/search`, `GET /api/hsn/{hsn8}`, `GET /api/hsn/{hsn8}/siblings`
* `GET /api/hsn/lookup/{code}` - a product for 8 digits; for 2/4/6 digits a node with `ownership`
  (total/mapped/residual lines, leading owner and all owners) and children with the same summary.
  `tree` children and product details expose the same derived parent-level coverage.
* `GET /api/hsn/{hsn8}/trade`, `/world-suppliers`, `/world-markets`, `/partners`, `/tariff`, `/schemes`
* `GET /api/hsn/{hsn8}/network` (`direction=upstream|downstream|both`, `depth<=6`)
* Search supports `q`, `chapter`, `ministry_id`, `sector_id`, `mapping_status`, `mapping_source`, trade/RCA filters,
  sorting and pagination.

### Ministries and sectors

* `GET /api/ministries`, `GET /api/ministries/{id}`, `GET /api/ministries/{id}/products`
* `GET /api/sectors`, `GET /api/sectors/{id}`, `GET /api/sectors/{id}/products`

### Value chains and network

* `GET /api/valuechains` - list with anchor-code trade headline
* `GET /api/valuechains/{id}` - stages, items, KPIs, suppliers, markets, partners, categories, manufacturers,
  clusters, skill council, schemes, risk flags, provenance
* `GET /api/valuechains/{id}/mapping?stage_id=` - ministry-wise product mapping
* `GET /api/valuechains/{id}/tiers` - supplier tiers (how deep the supply chain runs): for every tier the
  definition, the example supplier types and the HS-coded items with their live trade figures
* `GET /api/network?chain_id=&center=&depth=&include_parts=` - nodes, edges, stats, critical inputs
* `GET /api/network/trace?code=&direction=&depth=`

Value-chain KPIs are computed from BACI 2024 and the sourced `production` table. A missing value is `null` with
status `not_available`; no presentation-slide comparator is returned.

`GET /api/valuechains/{id}` also carries `has_tiers` (true when the chain has tiers), so a client can offer the
tier view without a second request.

### Analytics (GOV)

* `GET /api/analytics/summary`, `/export-potential`, `/import-dependency`, `/import-substitution`,
  `/competitiveness`, `/demand-supply`, `/archetypes`, `/forecasts`, `/forecast`

### Policy

* `GET /api/policy/use-cases`, `/schemes`, `/schemes/{id}`, `/agreements`, `/skilling`
* `GET /api/policy/negotiation?partner=|agreement=` (GOV)
* `POST /api/policy/simulate-tariff` (GOV) - BCD scenario with downstream propagation



### Risk (GOV)

* `GET /api/risk/summary`, `/alerts`, `/by-sector`, `/by-country`, `/products`

### Residual, helpdesk, Data Hub, reports, admin, assistant

* `GET /api/residual`, `POST /api/residual/claims`, `GET /api/residual/claims`, `POST /api/residual/claims/{id}/review`
* `GET/POST /api/tickets`, `GET /api/tickets/{id}`, `POST /api/tickets/{id}/messages`
* `GET /api/datahub/sources`, `/jobs`, `/uploads`, `/quality`, `/cross-checks`; upload create/inspect/apply;
  connector start (admin where mutating)
* `GET /api/reports/{product|ministry|valuechain}/{id}?format=pdf|xlsx|csv`
* Admin: `/api/admin/users`, `/api/admin/audit`, `/api/admin/claims`, `/api/admin/overrides`; roadmap/risk reads
* `POST /api/assistant/ask` (public with rate limit), assistant health/config endpoints

Response shapes are exercised by `backend/tests/test_contract_smoke.py` against the real database.

## 6. Curated files

`backend/data/curated/`:

* `ministries.json` - 33 ministries/departments (31 with Guidebook codes) plus `residual`, colours and aliases.
* `sectors.json` - 25 sectors with HS chapter/heading mapping.
* `value_chains.json` - 15 chains, fully curated: stages, items, edges, manufacturers, clusters, skill council.
  Ministry ids on items are replaced at load time with the Atlas product mapping.
* `supply_tiers.json` - the supplier tiers of a chain (currently sports goods: 3 tiers, 40 HS-coded items).
  Tier levels, descriptions and example supplier types are curated from the source study; the items are the
  Atlas's own HS-coded grounding, and their ministry ids are replaced at load time with the Atlas product
  mapping, exactly like the chain items.
* `production.json` - the 12 sourced production rows and their source metadata.
* `policy.json` - PLI/QCO schemes, agreements, skill councils, roadmap, risks.
* `info.json` - the four dashboard info cards.
* `ops_seed.json` - demo users, data-source registry and demo tickets/claims.

## 7. Frontend

Routes: `/`, `/explore`, `/product/:hsn8`, `/ministries`, `/ministry/:id`, `/sector/:id`, `/value-chains`,
`/value-chains/:id`, `/value-chains/:id/mapping`, `/network`, `/analytics`, `/policy`, `/risk`, `/data-hub`,
`/login`, plus the Ask Atlas drawer. Residual, helpdesk, roadmap, admin and about are API-only; there are no
dashboard pages for them.

The typed client is `frontend/src/api/client.ts`; types are `frontend/src/api/types.ts`. The app must pass
`npm run typecheck` and `npm run build`.

The chain deep-dive has four tabs - Trade, Ecosystem, Supply tiers, Items & risk. The **Supply tiers** tab is
shown only when the chain has tiers (`has_tiers` on the chain detail) and loads `/api/valuechains/{id}/tiers`
when it is first opened, so a chain without tiers makes no extra request.

## 8. Quality bar

* All backend tests pass: `python -m pytest -q` (521 tests).
* Frontend typecheck and build pass with no errors.
* `test_contract_smoke.py` passes against the deploy database (`ATLAS_DB=data/deploy/atlas.db`).
* Every displayed number has provenance; no invented values; no presentation-slide figures or comparisons.
* Mutating endpoints are role-checked and audited.
* `build_deploy_db` output contains 13,110 products, 15 value chains, 256 chain items, 3 supplier tiers with
  40 tier items and 12 sourced production rows, with no legacy override tables.
