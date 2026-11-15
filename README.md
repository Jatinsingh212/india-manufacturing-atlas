# India Manufacturing Atlas

> **Secondary copy.** This repository and its Git-connected Vercel project (`india-manufacturing-atlas-git`) are a parallel, secondary version. The source of truth is the directly deployed Vercel project `india-manufacturing-atlas` (https://india-manufacturing-atlas.vercel.app), deployed from the local folder with the Vercel CLI.

An HSN-code intelligence platform for India: search and analyse India's 2-, 4-, 6- and 8-digit HS codes,
their ministry ownership, trade, tariffs, value chains and production. The backend is FastAPI + SQLite; the
dashboard is React 19 + TypeScript + Vite. Every figure carries provenance: **Verified** (official or
recognised source), **Not verified** (residual mapping or model estimate) or **Not available** (no data,
never a zero).

The platform uses real, sourced data only. It does not ship presentation-slide figures, reference values or
sample baselines.

## Data sources

| Source | Used for | Status |
|---|---|---|
| WCO Harmonized System 2022 nomenclature | sections, chapters, headings, subheadings, labels | Verified |
| GST portal HSN master (`HSN_MSTR`) | India's 13,110 current 8-digit lines | Verified |
| DPIIT Guidebook on HSN Code Mapping, 16.12.2025 revision | ministry ownership of 11,679 accepted 8-digit codes; 495 residual codes | Verified |
| CEPII BACI (HS17 2018-21, HS22 2022-24) via the OEC API | India and world trade at HS6, partners, suppliers, markets | Verified |
| World Bank WITS / UNCTAD TRAINS, India MFN applied 2022 | BCD / MFN applied tariff averages | Verified |
| DGFT public ITC-HS import / export policy (Discover portal) | 8-digit Schedule I / II policy, conditions and notifications | Verified when published |

| UN Comtrade public preview API | BACI cross-checks only (Data Hub) | Verified when fetched |
| UNIDO INDSTAT 2026, ISIC Rev.4 gross output, India (2022) | domestic output for the pilot value chains, US$ | Verified |
| Rubber Board, Government of India (2024) | natural-rubber production, tonnes | Verified |
| ATMA (2023) | tyre production, units | Verified |
| Curated files in `backend/data/curated/` | ministries, sectors, value chains, supply tiers, schemes, agreements, councils, info cards, demo seed | platform-curated; mapping not official |

The Atlas applies the public official DPIIT Guidebook HSN-to-ministry mapping (16.12.2025 revision):
11,679 accepted codes, 12,912 acceptances and 495 residual codes. The parser reads pages 24-450 in full
(accepted tables 24-429; residual annexure 430-459). 11,662 accepted codes match the GST product
master; the remaining 960 GST lines are absent from the Guidebook and stay residual. When several ministries
accept a code, the first-listed section is the primary owner and the others are stored as secondary owners.

Chapters, headings and subheadings (2/4/6 digits) show ownership derived from the accepted 8-digit lines under
them, with the number of lines covered and the leading owner. This is a transparent parent-level view, not a
separate Guidebook acceptance. A residual 8-digit line may show a derived parent-owner hint when its nearest
6/4/2-digit parent has exactly one accepted owner and at least 50% line coverage; the line itself remains
residual. DPIIT can upload a newer mapping through the Data Hub, after which those lines become
`official_upload` and Verified.

## Pages

* **Overview `/`** - KPI tiles, interactive sector → register → ministry → status tree with exact
  intersection detail, ministry distribution, Enter-HSN lookup, ministry-wise HS table, sector distribution,
  info cards and data freshness.
* **HSN Explorer `/explore`** - HS hierarchy, faceted search table, compare tray and signed-in CSV/XLSX export.
* **Product `/product/:hsn8`** - hierarchy, ministry ownership and provenance, trade KPIs and trend, world
  suppliers and markets, India's partners, WITS tariff, DGFT ITC-HS import / export policy, model scores,
  value-chain links, schemes, production, sibling lines, watchlist, query and downloads.
* **Ministries `/ministries`, `/ministry/:id`, `/sector/:id`** - all 33 ministries/departments (31 with
  Guidebook codes) plus the residual bucket; KPIs, sector and chapter mix, trade, dependencies, value chains,
  production where available and the ministry-wise HS table.
* **Value chains `/value-chains`, `/value-chains/:id`, `/value-chains/:id/mapping`** - fifteen curated chains
  (tyre, natural rubber, cotton apparel, auto components, pharma API, mobile electronics, solar PV, steel,
  EV battery, leather footwear, toys, sports goods, bicycles, fishing gear, sporting firearms), with stage and
  ministry mapping, trade, suppliers, markets, manufacturers, clusters, skill councils, schemes and risk flags.
* **Supply tiers** - a "Supply tiers" tab on the chain deep-dive shows how deep the supply chain runs behind the
  finished product: Tier 1 are the direct suppliers of the manufacturer, Tier 2 their suppliers, Tier 3 the basic
  materials and commodities underneath them. Each tier carries the source study's definition and example supplier
  types plus the Atlas's HS-coded items with India's trade on each line (sports goods: 3 tiers, 40 items).
* **Product deep-dive `/deep-dive/:hs4`** - one HS heading (pilot: 9506 sports goods) from India to sector, heading, 6-digit and 8-digit lines with trade, tariffs and DGFT policy; Cluster Observatory clusters and India Industrial Land Bank parks; QCO / ISI / Hallmark and export-market standards; export readiness per destination market with a what-if on the extra duty a market charges Indian goods.
* **Network `/network`** - value-chain graph with chain filter, centre, depth, optional HS-text links, ministry
  colouring and production/trade side panel.


* **Opportunity Lab `/analytics`** (government roles) - export potential, import dependency, import substitution,
  RCA competitiveness, demand-supply, archetypes and forecasts.
* **Policy Workbench `/policy`** - five policy use cases, PLI schemes, QCOs, trade negotiation analysis, tariff
  scenario simulation and skilling.
* **Supply-chain Risk `/risk`** (government roles) - vulnerability KPIs, alert feed, by-sector and by-country
  analysis and the most vulnerable products.
* **Data Hub `/data-hub`** - source registry, connectors, refresh jobs, validated uploads with admin apply, and
  data-quality coverage. CBIC, GSTN and the credentialed DGFT connector report `not_configured` until credentials
  are configured; the public DGFT ITC-HS policy feed is connected as `dgft_itc_hs`.
* **Login `/login`** - email/password, demo-role buttons and industry self-registration.
* **Ask Atlas** (top bar) - assistant over the platform's own data; uses a configured LLM or a deterministic
  offline answer engine.

The backend keeps APIs for residual claims, helpdesk tickets, roadmap data and admin users/audit. Those modules
are intentionally not exposed as dashboard pages.

## Architecture

```
browser (React 19 + Vite + TypeScript, Tailwind, ECharts, cytoscape)
     |  /api/* JSON (fetch, Bearer JWT)        dev: Vite :5173 proxies /api -> :8000
     v
FastAPI app/  (uvicorn, h11)  ->  SQLite data/atlas.db (WAL, one connection per request)
     ^
ETL scripts/build_db.py -> scripts/etl/* (schema, nomenclature, mapping, trade, tariffs,
     metrics, value chains, supply tiers, policy, ops seed, scores), writing atlas.db atomically
     ^
data/raw/ (downloaded sources + manifest.json)   data/curated/ (platform-curated knowledge)
```

## How to run

Requirements: Python 3.11, Node 20+ and about 2 GB of disk.

### One command

```powershell
.\start.ps1                 # Windows PowerShell
.\start.ps1 -Port 8080
.\start.ps1 -Rebuild        # force fresh ETL and frontend build
```

```bash
./start.sh
./start.sh --rebuild
```

API docs: `http://127.0.0.1:8000/api/docs`.

### Manual commands

```powershell
cd backend
python -m pip install -r requirements.txt
python -m scripts.fetch_sources          # only if data/raw is incomplete
python -m scripts.build_db               # data/atlas.db
python -m scripts.build_deploy_db        # slim deploy database + gzip

cd ../frontend
npm install
npm run typecheck
npm run build                            # frontend/dist

cd ../backend
python -m app.main --port 8000
```

Use `python -m app.main` (or uvicorn with `--http h11`); uvicorn's default `httptools` implementation is broken
on the reference Windows machine.

### Development

```powershell
cd backend;  python -m app.main --port 8000 --reload
cd frontend; npm run dev                 # Vite on :5173, proxies /api to :8000
```

## Deploy to Vercel

The repository root is a Vercel project. Vercel serves `frontend/dist` and runs the API as one Python function
(`api/index.py`), with `/api/*` rewritten to it.

1. Build the slim deploy database:
   `cd backend && python -m scripts.build_deploy_db`
   This writes `data/deploy/atlas.db.gz`. Residual suggestions are precomputed so the function does not need
   scikit-learn; partner tables keep the top 25 countries per product plus agreement partners and value-chain
   products. The function unpacks the database to `/tmp` on cold start.
2. Set `ATLAS_JWT_SECRET` (long random string, shared by every instance) and optionally an LLM key for Ask Atlas:
   `GROQ_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`.
3. `npx vercel deploy --prod` from the repository root.

Serverless limits: each function instance writes its own `/tmp` copy, so sign-ins work but uploads, tickets and
claims are per instance and disappear when recycled. For persistence run the API with a disk (`start.sh`) or
point `ATLAS_DB` at a mounted volume.

## Demo accounts

Demo mode (`ATLAS_DEMO_MODE=1`, default) seeds one account per role and enables one-click login. The shared
password is stored in `backend/data/curated/ops_seed.json` under `demo_password`; change it and disable demo mode
before any real deployment.

| Email | Role | Scope |
|---|---|---|
| `admin@atlas.gov.in` | admin | everything: users, claim approvals, uploads, connectors, audit log |
| `textiles@atlas.gov.in` | ministry (`mot`) | government analytics; own ministry's claims/tickets; uploads |
| `dpiit@atlas.gov.in` | ministry (`dpiit`) | as above for DPIIT |
| `analyst@atlas.gov.in` | analyst | analytics, risk, residual read, Data Hub read, all tickets |
| `industry@example.com` | industry | own tickets, watchlist, reports |

Anonymous visitors can use the public pages, assistant, query form and reports. Industry accounts can self-register.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ATLAS_DB` | `backend/data/atlas.db` | SQLite database path |
| `ATLAS_JWT_SECRET` | unset: generated once in `backend/data/.jwt_secret` | HS256 signing secret |
| `ATLAS_JWT_SECRET_FILE` | `backend/data/.jwt_secret` | where the generated secret is persisted |
| `ATLAS_LOGIN_RATE_PER_MINUTE` | 5 | failed sign-ins per email per minute; `0` disables |
| `ATLAS_DEMO_MODE` | `1` | `0` disables demo login |
| `ATLAS_FRONTEND_DIST` | `frontend/dist` | built SPA folder |
| `ATLAS_UPLOAD_DIR` | `backend/data/uploads/` | Data Hub upload storage |
| `ATLAS_WARM_MODELS` | `1` | fit the residual-suggestion index at start-up |
| `ANTHROPIC_API_KEY` | unset | Claude mode for Ask Atlas |
| `GROQ_API_KEY` / `XAI_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` | unset | OpenAI-compatible LLM providers |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` | unset | explicit provider/model or compatible endpoint |
| `ATLAS_ASSISTANT_RATE_PER_MINUTE` | 20 | assistant rate limit when an LLM is configured |
| `ATLAS_CBIC_API_KEY`, `ATLAS_CBIC_API_URL` | unset | CBIC / ICEGATE connector |
| `ATLAS_GSTN_API_KEY`, `ATLAS_GSTN_API_URL` | unset | GSTN connector |
| `ATLAS_DGFT_API_KEY`, `ATLAS_DGFT_API_URL` | unset | credentialed DGFT connector (separate from the public ITC-HS feed) |
| `ATLAS_COMTRADE_YEAR`, `ATLAS_WITS_YEAR` | 2023 / 2022 | connector years |

## Security

* HS256 JWTs (12 h) signed with `ATLAS_JWT_SECRET`, or a generated secret persisted on disk.
* Sign-in throttling per email and client address.
* Passwords stored as salted PBKDF2-SHA256 hashes (200,000 iterations).
* Five roles: public, industry, analyst, ministry and admin; ministry officers are scoped to their ministry.
* Every mutating action is written to the audit log.
* Before a shared deployment set `ATLAS_DEMO_MODE=0`, create real users and put the API behind TLS.

## Testing

```powershell
cd backend
python -m pytest -q
cd ../frontend
npm run typecheck
npm run build
```

The suite has 521 tests: ETL, curated data contracts, API core/analytics/ops, LLM provider handling and a contract smoke test that calls every frontend client function
against the real database. Mutating tests use a private copy of the database.

## Project layout

```
manufacturing-atlas/
  README.md  start.ps1  start.sh
  docs/
    SPEC.md               API and build contract
    METHODOLOGY.md        formulas and scoring methods
    DATA_SOURCES.md       source provenance, licences and ETL notes
  backend/
    app/                  FastAPI: main, config, db, security, common, routers/, services/, connectors/
    scripts/              fetch_sources.py, build_db.py, build_deploy_db.py, etl/
    data/raw/             downloaded sources + manifest.json
    data/curated/         ministries, sectors, value chains, supply tiers, production, policy, info cards, ops seed
    data/atlas.db         generated
    tests/
  frontend/
    src/api/              typed API client, types and hooks
    src/pages/            overview, explore, product, ministries, sectors, value chains, network,
                          analytics, policy, risk, data hub, auth, assistant
    dist/                 built bundle
```

## Known limitations

* **Production coverage.** Real sourced output exists for the pilot chains (UNIDO 2022, Rubber Board 2024, ATMA
  2023). Other HS lines show **Not available**; the Atlas never invents a production figure.
* **Official mapping.** The DPIIT Guidebook (16.12.2025) leaves 1,448 GST lines residual (495 Guidebook
  residual codes and 960 lines absent from the Guidebook). They stay Not verified; parent-level coverage is
  derived from accepted 8-digit lines and is labelled as such.
* **Government feeds.** CBIC, GSTN and the credentialed DGFT connector are registered but need credentials and
  URLs. The public DGFT ITC-HS policy tables are fetched separately without login or CAPTCHA; a code absent from
  a direction's table is shown as **Not listed**, never assigned a policy from a parent or a rule.

* **Trade granularity.** BACI is HS6; an 8-digit line shows its subheading's trade, and aggregations split HS6
  values across the lines in that subheading.
* **HS revisions.** 2018-2021 BACI (HS17) is joined to 2022-2024 (HS22) on identical 6-digit codes without a
  concordance, so subheadings created or split in 2022 show a break in their trend.
* **Tariffs.** WITS/TRAINS 2022 MFN simple averages at HS6. Non-ad-valorem duties show **Not available**.
* **Models.** RCA, HHI, OLS log-trend forecasts, k-means and TF-IDF suggestions are transparent estimates.
* **Refresh.** OEC/BACI, WITS and UN Comtrade connectors run on demand from the Data Hub; scheduled refresh is
  not enabled.
