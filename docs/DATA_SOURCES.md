# Data sources and provenance

The Atlas uses real, downloaded or curated sources only. Every table is loaded by a deterministic ETL step; every
number the API returns carries a source and provenance status. No presentation-slide figures, reference values or
sample baselines are stored in the database.

## Sources

| # | Source | Files / access | Used for | Loaded into |
|---|---|---|---|---|
| 1 | WCO Harmonized System 2022 via `datahub.io/harmonized-system` | `raw/hs_sections.csv`, `raw/hs_nomenclature.csv` | sections, chapters, headings, subheadings, labels | `sections`, `hs_nodes` |
| 2 | GST portal HSN master | `raw/gst_hsn_master.xlsx` (`HSN_MSTR`) | India's 8-digit lines | `products` |
| 3 | DPIIT Guidebook on HSN Code Mapping, 16.12.2025 revision | [official PDF](https://www.dpiit.gov.in/static/uploads/2025/12/aa547e2ea8a7d7ddd98325a155ad4549.pdf), parsed to `data/curated/ministry_mapping.json` | accepted and residual 8-digit codes, all accepting ministries | `guidebook_mapping`, `products`, `product_ministries` |
| 4 | CEPII BACI 2018-2024, HS17/HS22, via the OEC API | `raw/oec_baci_*.json` / ETL connector | bilateral trade at HS6, partners, suppliers, markets | `hs6_products`, `world_suppliers`, `world_markets`, `india_partners`, `trade_series` |
| 5 | World Bank WITS / UNCTAD TRAINS, India MFN applied 2022 | `raw/wits_india_mfn_2022.csv` | MFN applied tariff average, min/max, line counts | `tariffs` |
| 6 | DGFT public ITC-HS import / export policy | [DGFT Discover ITC-HS page](https://www.dgft.gov.in/CP/?opt=itchs-import-export), fetched to `raw/dgft_itc/dgft_itc_policy.jsonl.gz` | 8-digit Schedule I (import) and Schedule II (export) policy, conditions, notifications | `dgft_itc_policy` |
| 7 | UN Comtrade public preview API | Data Hub connector | BACI cross-checks only | `cross_checks` |
| 8 | UNIDO INDSTAT 2026, ISIC Rev.4 gross output, India (2022) | `data/curated/production.json` | domestic output for the pilot value chains, US$ | `production` |
| 9 | Rubber Board, Government of India (2024) | `data/curated/production.json` | natural-rubber production, tonnes | `production` |
| 10 | ATMA (2023) | `data/curated/production.json` | tyre production, units | `production` |
| 11 | Platform-curated knowledge | `data/curated/*.json` | ministries, sectors, value chains, supplier tiers, schemes, agreements, skill councils, info cards, seed data | corresponding tables |
| 12 | Cluster Observatory (Foundation for MSME Clusters) | `gl_sme.php` cluster register, scraped by the `cluster_observatory` connector to `raw/cluster_observatory.json` | industrial, handloom and handicraft clusters, state, product, diagnostic-study PDF | `co_clusters` |
| 13 | WITS / UNCTAD TRAINS, MFN applied tariffs of US, EU, UK, UAE, Australia, Japan, Canada | `market_tariffs` connector to `raw/market_tariffs.json` | duty faced by Indian goods in each market (with `data/curated/deep_dive.json` agreements and additional duties) | `market_tariffs`, `markets` |
| 14 | India Industrial Land Bank, IIS 2.0 web API | `iilb` connector; needs `ATLAS_IILB_ACCESS_TOKEN` + `ATLAS_IILB_STATE_LGCS` | industrial parks, available land, vacant plots | `iilb_parks` |


The source registry (`data_sources`) records each source's refreshability, configuration state and last refresh.
CBIC, GSTN and the credentialed DGFT connector are registered but report `not_configured` until credentials and
URLs are supplied (`ATLAS_CBIC_API_KEY`, `ATLAS_GSTN_API_KEY`, `ATLAS_DGFT_API_KEY` and their `_URL` companions).
The **public** DGFT ITC-HS policy tables are a separate connected source, `dgft_itc_hs`; they do not use the
credentialed connector.

## Ministry mapping

The Atlas applies the public official DPIIT Guidebook HSN-to-ministry mapping (16.12.2025 revision,
`data/curated/ministry_mapping.json`). The PDF is 461 pages; its SHA-256 is
`5dcb6ac5e55104a3d868aa09b8a91da50f360c482cbb3b8af56e7ee5e6c01246`. The parser reads the accepted
ministry tables on **pages 24-429** and the residual annexure on **pages 430-459**, so the requested
pages 24-450 are fully covered. The parsed mapping contains **11,679** accepted unique codes, **12,912**
acceptances, **1,217** multi-owner codes and **495** residual codes. All **12,174** published rows are
kept in `guidebook_mapping` with page provenance; residual rows also keep DPIIT's probable-ministry text
separate from the HS description.

* **Primary owner** = the first-listed section for a code. Every additional accepting ministry is stored as a
  secondary owner in `product_ministries`.
* **8-digit GST lines.** 11,662 accepted codes match the GST master; 488 Guidebook residual codes match it; 960
  GST lines are absent from the Guidebook and are `mapping_source = unmapped`, `mapping_status = residual`.
  17 Guidebook codes do not exist in the GST master.
* **2/4/6-digit levels.** Ownership is aggregated on request from the accepted 8-digit lines under each prefix.
  The API reports total/mapped/residual lines, coverage, the leading owner (most directly-primary lines) and
  every owner, with `method = aggregated_from_8_digit_lines`. This is a derived navigation view, not a separate
  Guidebook acceptance.
* **Residual 8-digit hints.** A residual line may show a `parent_ownership` hint from the nearest 6/4/2-digit
  parent only when that parent has exactly one accepted primary owner and at least 50% line coverage. The line
  remains residual and is not counted as verified.
* **Uploads.** A ministry can upload a newer mapping through the Data Hub; after admin apply it is stored as
  `official_upload` and treated as **Verified** for those codes. Manual review is stored as `manual`, also
  Verified.

Value-chain ministry ids are taken from the same product mapping at load time, so a chain page cannot name a
different owner from the product page. An 8-digit item uses its direct primary and secondary owners; a 4/6/2-digit
item uses the most common non-residual primary owner of the lines under it. Unmapped 8-digit lines are `residual`
and get a transparent TF-IDF suggestion.

## Supplier tiers

`data/curated/supply_tiers.json` holds the supplier-tier structure of a chain: how deep the supply chain runs
behind the finished product. Tier 1 are the direct suppliers of the manufacturer, Tier 2 the suppliers of those
suppliers, Tier 3 the basic materials and commodities Tier 2 works with. The tier levels, definitions and example
supplier types are taken from the source study's supply-chain table; they are curated structure, not derived
numbers, and they carry the study as their `source`.

The items of a tier are the Atlas's own HS-coded grounding of it. Every code must exist in the **GST HSN master**
and in the **HS 2022 nomenclature** (`raw/gst_hsn_master.xlsx`, `raw/hs_nomenclature.csv`); the loader rejects
anything else, and the audit re-checks the same rule. The ministry of a tier item is **re-derived from the Atlas
product mapping** at load time - the curated file never carries a second opinion - so a tier page can never name a
different owner than the product page. The tier mapping is therefore published as **Not verified** until a
ministry validates it, exactly like the curated value-chain mapping.

Trade figures on a tier item are the HS6 line that carries its HS code (`hs6_metrics`, the same figures as every
other page); the tier total is the sum of its items and is a scale indicator, not an economic aggregate.

## Production

`data/curated/production.json` contains 12 sourced rows covering 11 pilot chains:

* UNIDO INDSTAT 2026 gross output for 2022 (ten chains, US$);
* Rubber Board natural-rubber production for 2024 (857,000 tonnes);
* ATMA tyre production for 2023 (217,000,000 units).

Every row carries `source`, `year`, `unit`, `label` and `status = verified`. Lines without a sourced production row
return **Not available**; the Atlas never estimates a production figure.

## Trade and tariffs

* BACI reports at HS6. An 8-digit line shows its subheading's trade; aggregations distribute HS6 values across the
  lines of that subheading (`lines_in_hs6`). Where the source reports only a heading aggregate (`2710` -> `271000`),
  lines under it show that total and aggregations split it across every national line in the heading, so the
  heading is counted once. `7108.20` and `7118.90` have no BACI row and no heading aggregate, so their trade is
  **Not available**.
* BACI 2018-2021 uses HS17 and 2022-2024 uses HS22. They are joined on identical 6-digit codes without a
  concordance, so lines created or split in HS22 can show a break in their trend.
* WITS/TRAINS provides the 2022 MFN applied simple average at HS6. Non-ad-valorem (specific or compound) duties are
  stored as NULL and shown **Not available**, never as an estimated percentage. Tariffs exclude AIDC, SWS, IGST and
  preferential rates.

## DGFT trade policy

The DGFT "Discover" page publishes the ITC-HS Schedule I (import) and Schedule II (export) policy at 8-digit
level. `scripts/etl/fetch_dgft_itc.py` retrieves it reproducibly:

* **Public access only.** The script GETs the public home page for its `<meta name="_csrf">` token and POSTs
  `webHP?requestType=ApplicationRH&screenId=90000802&actionVal=getChapterDetails` with `itcCode=<chapter>` and
  `expType=1|2`. No account, login, OTP, CAPTCHA, CAPTCHA-solving service or access-control bypass is used.
* **Direction quirk.** `expType=1` returns the import policy and `expType=2` the export policy, but both arrive in
  the portal's `imp*` fields. The ETL normalises them to explicit `import` / `export` records.
* **Coverage.** All chapters 01-98, both directions: **25,187** published 8-digit records covering **12,571**
  unique codes. Import has 12,587 records (12,512 codes with a policy value); export has 12,600 records
  (12,510 with a policy value). Chapter 77 is reserved and empty.
* **Duplicates.** The portal repeats a few codes (43 groups, 45 extra records: 16 import, 29 export). Every
  published record is kept. Exactly one row per code and direction is `is_current = 1`: the **last record in
  portal (API) order**, which is the latest notification (no duplicate group has an older notification date at
  the last position).
* **Plain text.** The portal's HTML conditions are stripped to plain text at ingest; mathematical text such as
  "Specific Gravity < 4.0" is preserved. Raw portal HTML is never rendered.
* **States, no fallback.** A product's `trade_policy` direction is `specified` when the current record has a
  policy value, `not_specified` when the code is published but that direction has no value, and `not_listed`
  when the code is absent from that direction's table. No rule, parent code or ministry hint is substituted.
* **Provenance.** `data/raw/dgft_itc/manifest.json` records the endpoint, method, fetch time, per-chapter
  response hashes, file hashes and totals; `data/raw/manifest.json` carries the `dgft_itc_hs` freshness entry.
  `--from-dir` rebuilds the dataset deterministically from saved chapter payloads for audit without re-fetching.
  The dataset is loaded by `scripts/etl/load_dgft_itc.py` (build step 8), which validates 8-digit codes,
  directions, unique keys and exactly one current record per code and direction.



## Provenance rules

| Status | Meaning | Examples |
|---|---|---|
| **Verified** | Official or recognised dataset, or an approved upload | DPIIT Guidebook mapping, BACI trade, WITS tariff, GST nomenclature, DGFT ITC-HS policy (specified), UNIDO, Rubber Board, ATMA, official mapping upload, manual approval |
| **Not verified** | Residual mapping, Atlas-curated mapping or model output | residual/not-listed Guidebook lines, the curated value-chain and supplier-tier mappings, RCA, HHI, forecasts, k-means, TF-IDF suggestions |
| **Not available** | No source value exists | missing production, non-ad-valorem tariff, absent trade record, DGFT code not listed or no policy specified |

## Rebuilding

```powershell
cd backend
python -m scripts.fetch_sources          # only if data/raw is incomplete
python -m scripts.build_db               # full database (includes load_dgft_itc)
python -m scripts.build_deploy_db        # slim deploy copy + gzip
```

To refresh only the public DGFT policy dataset before a build:

```powershell
cd backend
python -m scripts.etl.fetch_dgft_itc              # all chapters, both directions
python -m scripts.etl.fetch_dgft_itc --chapters 01  # public connectivity probe; writes nothing
python -m scripts.etl.fetch_dgft_itc --from-dir "$env:TEMP\dgft_chapters"  # audit rebuild from saved payloads
```

A partial `--chapters` run validates the requested chapters but never writes the dataset or manifests, so it
cannot replace the complete 98-chapter reference file. The `--from-dir` path rebuilds the committed dataset
deterministically from saved payloads.



The build runs the ETL steps in `backend/scripts/etl/`, then the sanity gate. `data/raw/manifest.json` records every
downloaded file's URL, timestamp and hash.

## Product deep-dive (HS 9506 pilot)

`/deep-dive/:hs4` drills one heading from India to sector, heading, 6-digit subheadings and 8-digit lines. Cluster HS codes are the Atlas' curated mapping of Observatory product labels (`data/curated/deep_dive.json`); the Observatory publishes none. Standards (QCO, ISI, Hallmark in India; CE / UKCA PPE, CPSIA and federation approvals abroad) are curated with a `verified` flag. Duty faced in a market = agreement rate, else the market's WITS MFN, plus the market's additional duty on Indian goods; the US figure is project-team input (`extra_duty_status = user_input`) until an admin verifies it. Export readiness weights demand 25, RCA 30, duty 25, compliance 10, capability 10; a product with RCA below 0.1 is capped at Not ready.

Daily sync: `python -m scripts.refresh_sources` (cluster_observatory, market_tariffs, iilb) from `backend/`, scheduled with cron or Windows Task Scheduler; each run is a normal Data Hub refresh job.

**Sports equipment basket** (`/deep-dive/sports_equipment`, the default deep-dive): the 28 HS6 codes of the study's table A2 (world exports 2024, US$ 52 bn), stored in `baskets` / `basket_codes` from `data/curated/deep_dive.json` with the study's labels and published values beside BACI. 950890 is an HS 2017 code with no HS 2022 data; it is listed but not scored or mapped to a successor.

## Daily cloud sync (Vercel)

The deployed site refreshes the deep-dive sources itself: Vercel Cron calls `GET /api/cron/sync` at 22:30 UTC (04:00 IST)
with `CRON_SECRET`. In one run of up to 5 minutes it scrapes, in parallel:

* **Cluster Observatory** - all list pages; the district pass runs *sequentially* for 150 s a day from where the
  previous run stopped (the site slows to ~5 s per request under parallel load), keeping districts already confirmed;
* **WITS** - the MFN schedule of every market, one thread per market;
* **India Industrial Land Bank** - the public park report, read by the Node function `api/iilb-report.mjs` with a
  serverless Chromium (`@sparticuz/chromium` + `puppeteer-core`), the same way the local Playwright connector reads it.

Each source is stored as a gzipped snapshot in a private Vercel Blob store (`sync/<source>.json.gz`, via
`api/blob-store.mjs`) with `sync/manifest.json`; a failed source keeps its previous snapshot. Every API instance
overlays snapshots newer than its bundled data (checked every 5 minutes), updates `data_sources` and records a
refresh job. `GET /api/sync/status` shows the last run; admins can start one with `POST /api/sync/run`.

One-time setup (owner of the Vercel project): `powershell -NoProfile -ExecutionPolicy Bypass -File setup_cloud_sync.ps1`
creates the Blob store (sets `BLOB_READ_WRITE_TOKEN`) and a random `CRON_SECRET`, then redeploy. Locally the sync is
off and `python -m scripts.refresh_sources` refreshes the same sources.
