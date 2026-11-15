# Methodology — how every score, forecast and alert is calculated

This page explains, in plain language, every indicator the India Manufacturing Atlas shows: the formula, the
weights and thresholds, what the number means and where it can mislead. It is the page behind every
"Model estimate" label and the `/about#methodology` link in the app.

The formulas are the contract of `docs/SPEC.md` section 4. The code that implements them:

| What | Where |
|---|---|
| Trade indicators (RCA, shares, HHI, CAGR, YoY) | `backend/scripts/etl/metrics.py` → table `hs6_metrics` |
| Scores, archetypes, k-means clusters, alerts | `backend/app/services/scoring.py`, run by `backend/scripts/etl/compute_scores.py` → tables `hs6_scores`, `alerts` |
| Forecasts | `backend/app/services/forecast.py` (stored in `hs6_scores.forecast_json`) |
| Value-chain graph, critical inputs | `backend/app/services/graph.py` |
| Tariff simulator | `backend/app/services/simulator.py` |
| Opportunity Lab, risk, policy, value-chain endpoints | `backend/app/routers/{analytics,risk,policy,valuechains,network}.py` |
| Data-quality score | `backend/app/common.py` (`quality_score`) |

Recompute the scores and alerts on an existing database, in one transaction, with
`python -m scripts.etl.compute_scores` (run from `backend/`). A full rebuild (`python -m scripts.build_db`) runs it
as step 11. The tests in `backend/tests/test_api_analytics.py` check every formula on hand-made inputs, recompute the
worked example below from scratch in SQL, and reproduce the live tyre-sector figures.

---------------------------------------------------------------------------------------------------------------

## 1. Labels you will see

The app uses a three-colour provenance legend on every number:

| Label | Meaning | Used for |
|---|---|---|
| **Verified** (green) | Taken directly from an official or recognised dataset | DPIIT Guidebook mapping (16.12.2025), CEPII BACI trade, WITS tariffs, GST HSN master, HS 2022 nomenclature, UN Comtrade checks, UNIDO output, Rubber Board, ATMA, uploaded official mappings |
| **Not verified** (red) | A residual mapping, a curated mapping or an estimate nobody has checked against a source | residual/not-listed Guidebook lines, the Atlas-curated value-chain and supplier-tier mappings, every model score, forecast and alert |
| **Not available** (orange) | No data | Shown as "Not available", never as zero |

Every score, cluster, forecast, alert and simulation is a **model estimate**: a transparent calculation on
verified trade data, intended to rank and prioritise, not an official statistic or projection.

---------------------------------------------------------------------------------------------------------------

## 2. Data and notation

* **Trade**: CEPII BACI (HS 2022 for 2022-2024, HS 2017 for 2018-2021), downloaded through the OEC API.
  Values are US dollars (not millions). The **latest year is 2024**; trend indicators use **2018-2024**.
  OEC's public country profiles open on **HS 2017** by default; switch **Harmonized System Version** to **HS22**
  to compare the same classification as the Atlas. Totals and partner shares can differ slightly between editions
  because HS22 moves a small number of products between codes.
* **Tariffs**: WITS / TRAINS, India's MFN applied tariff 2022, simple average of the national tariff lines in each
  HS6 subheading. When none of the lines is ad valorem the tariff is shown as Not available (not 0).
* **Notation** for a product *p* (an HS 6-digit subheading) in 2024:
  * X_p — India's exports of *p*; M_p — India's imports of *p*;
  * W_p — world trade in *p* (the sum of all countries' exports);
  * X = Σ X_p — India's total goods exports; W = Σ W_p — world total.
* **Trade is HS6-level.** BACI does not go below six digits. An 8-digit Indian tariff line shows the figures of its
  HS6 subheading. When 8-digit lines are added up (a ministry, a sector, a scheme), each line contributes
  *HS6 value ÷ number of lines in that HS6*, so nothing is counted twice. When codes are added up for a value
  chain, a sector or an HS heading, the distinct HS6 subheadings are summed once each.
* **Heading aggregates.** For a few headings (for example petroleum oils, 2710) the source reports the whole heading
  under one code (`271000`). Lines under such a heading show that aggregate, labelled `hs4_aggregate`, and use it
  for their series, partners and scores. When lines are added up, each contributes *heading value / number of
  national lines in the heading* (69 for 2710), so the heading is counted once. Two subheadings have no BACI
  row and no heading aggregate (`7108.20`, `7118.90`); their trade stays **Not available**.
* **Universe.** All rankings are taken over the HS6 subheadings with world trade above zero in 2024
  (5,606 subheadings in the 2026-10-19 build).

---------------------------------------------------------------------------------------------------------------

## 3. Trade indicators (per HS6, 2024)

| Indicator | Formula | Plain language |
|---|---|---|
| **RCA** (Balassa revealed comparative advantage) | (X_p / X) ÷ (W_p / W); empty if W_p = 0 | How much more of its exports India puts into this product than the world does. RCA ≥ 1 = India is relatively specialised (competitive) in it. |
| **India's world share** | X_p / W_p | India's slice of world exports of the product. |
| **India's supplier rank** | India's position among the product's exporters, by value (1 = largest) | Empty when India does not export it. |
| **Supplier concentration (world HHI)** | Σ s_c² over every exporting country's share s_c | 0 = many small suppliers; 1 = a single supplier. Above about 0.25 the world market is concentrated. |
| **Import concentration (India HHI)** | Σ s_c² over India's source countries' shares | How few countries India's imports come from. |
| **China import share** | India's imports from China ÷ M_p | 0 when India imports the product but not from China; empty when India imports nothing. |
| **CAGR** (compound annual growth) | (v₂₀₂₄ / v_first)^(1 / (2024 − first)) − 1 | *first* = the earliest year from 2018 with a value above zero. Empty with fewer than two points or a zero end value. Computed for India's exports, imports and world trade. |
| **YoY** (year on year) | v₂₀₂₄ / v₂₀₂₃ − 1 | Empty when 2023 is zero or missing. |
| **Dependency ratio** | M_p / (M_p + X_p) | 0 = India only exports it; 1 = India only imports it; 0.5 = balanced. |
| **Percentile rank, pct(·)** | (r − 1) / (n − 1), *r* = the product's rank (ties share the average rank) among the *n* products with a value | 0 = smallest of all products, 1 = largest. Products without a value (for example no imports, so no log M) are left out and score 0 on that component. Ranks do not change when values are logged, so pct(log W) = pct(W). |

---------------------------------------------------------------------------------------------------------------

## 4. Scores (0–100, per HS6)

"Missing components contribute 0": a product without, for example, a CAGR simply gets no points for that part.

### 4.1 Export potential score

```
export_potential = 100 × ( 0.35 · pct(log W_p)          world market size
                         + 0.30 · min(RCA, 3) / 3       India's competitiveness (capped at RCA 3)
                         + 0.20 · pct(world CAGR)       how fast world demand grows
                         + 0.15 · pct(India export CAGR) India's own momentum )
```

High scores go to large, growing world markets where India is already competitive and gaining. The RCA cap stops
a few hyper-specialised niche products (RCA 20+) from dominating the ranking.

### 4.2 Untapped export potential (US$)

```
untapped = max(0, b_p · W_p − X_p)   if RCA ≥ 0.3, else 0
b_p      = max(India's share of world exports in p's HS chapter, India's overall share X / W)
```

The extra exports India would have if it reached its average world share for that chapter in this product.
The RCA ≥ 0.3 floor keeps products where India has no production base out of the list. It is a gap to a
benchmark, not a forecast: it says nothing about price, quality, market access or capacity.

### 4.3 Import dependency score

```
import_dependency = 100 × (0.5 · dependency ratio + 0.3 · pct(log M_p) + 0.2 · India import HHI)
```

High when India mostly imports the product, the import bill is large relative to other products, and the imports
come from few countries.

### 4.4 Supply-chain vulnerability score

```
vulnerability = 100 × (0.30 · dependency ratio + 0.25 · India import HHI
                       + 0.20 · China import share + 0.25 · pct(log M_p))
```

The risk that a supply shock (one country, one route) hurts Indian users of the product. It adds China's share as a
separate factor because the platform is designed to identify import-dependence hotspots and a single dominant source is the
most common real-world disruption.

### 4.5 Import substitution score

Only for products India imports more than it exports **and** imports at least **US$ 10 mn** of (empty otherwise):

```
substitution = 100 × (0.4 · pct(log M_p) + 0.3 · min(RCA, 1) + 0.3 · (1 − world supplier HHI))
```

High when the import bill is large, India already has some capability (RCA close to 1) and world supply is spread
across many countries — so technology and inputs can be sourced and the market is contestable.

**Limitation — primary commodities.** The formula rewards a large import bill and open world supply but cannot tell
whether a domestic *manufacturing* path exists. Ores, crude oil / coal / gas, unworked diamonds and precious stones,
precious metals and unwrought base metals (copper, nickel, aluminium, lead, zinc, tin) score highly on it although
they are extracted or refined from imported raw material, not manufactured — rough diamonds, for example, are
imported to be cut and re-exported. The Opportunity Lab's *Import substitution* ranking therefore leaves these HS
prefixes out by default (`26`, `2701-2703`, `2709`, `2711`, `7102 10/21/31`, `7103 10`, `7106-7112`, `7401-7403`,
`7501-7502`, `7601`, `7801`, `7901`, `8001` — `app.services.scoring.PRIMARY_GOODS_PREFIXES`) and reports how many
were excluded; `include_primary=true` lists them. The stored score of such a product is unchanged and still shown
on its product page, labelled as a model estimate.

### 4.6 Archetypes (rule-based)

The first rule that matches wins:

| Archetype | Rule |
|---|---|
| **Champion** | RCA ≥ 1 and India's export CAGR ≥ world CAGR |
| **Established** | RCA ≥ 1 |
| **Emerging** | 0.3 ≤ RCA < 1 and India's export CAGR > world CAGR |
| **Dependent** | M_p ≥ 2 · X_p and M_p ≥ US$ 50 mn |
| **Marginal** | none of the above |

A comparison that needs a CAGR fails when the CAGR is empty. In the 2026-10-19 build: 1,302 Champions,
520 Established, 889 Emerging, 471 Dependent and 2,424 Marginal subheadings.

### 4.7 Product clusters (k-means, unsupervised)

Every product is described by six features, each standardised to mean 0 and standard deviation 1:

`log(1 + X_p)`, `log(1 + M_p)`, `log(1 + W_p)`, `min(RCA, 5)`, world CAGR and India export CAGR (both clipped to
−50 % … +50 %; an empty CAGR or RCA counts as 0). k-means with **k = 6**, `random_state = 42`, `n_init = 10`
(scikit-learn) groups products with similar profiles. Clusters are renumbered 0–5 from the strongest exporters'
group down, so the numbering is stable between runs. Each cluster's label is written automatically from its most
distinctive features (largest distance from the average, in standard deviations), e.g. *"Strong comparative
advantage, high India exports, small world market"*. The Archetypes tab shows each cluster's average feature
values ("centroid") and those distances ("z").

Clusters are descriptive — they find natural groups without anyone choosing thresholds — and complement the
rule-based archetypes; neither is a recommendation by itself.

---------------------------------------------------------------------------------------------------------------

## 5. Forecasts (2025–2026)

For India's exports and imports of each product separately:

* fit a straight line to **ln(value)** against the year, by ordinary least squares, over the years 2018–2024 with a
  value above zero (at least **3 points**, otherwise no forecast is shown);
* extend the line to 2025 and 2026 and convert back to US$;
* the **95 % band** is ± 1.96 × the residual standard error of the fit, in log space (so the band is wider above
  the forecast than below it).

`exp(slope) − 1` is the trend growth rate per year shown next to the chart. A log-linear trend assumes the past
seven years' average growth continues; it cannot foresee shocks, policy changes or price swings, and a wide band
means the history was volatile. For a heading or chapter the history is the sum of its HS6 subheadings and the
trend is fitted to that sum.

---------------------------------------------------------------------------------------------------------------

## 6. Automated alerts

Computed for every HS6 at each scoring run (`created_at` = the run time). One product can raise several alerts.

| Alert | Fires when | Severity |
|---|---|---|
| **Import surge** | import YoY ≥ +50 %, 2024 imports ≥ US$ 20 mn and 2023 imports ≥ US$ 1 mn | high if YoY ≥ +100 %, else medium |
| **Export drop** | export YoY ≤ −30 % and 2023 exports ≥ US$ 20 mn | high if YoY ≤ −50 %, else medium |
| **Concentrated sourcing** | India import HHI ≥ 0.6 and imports ≥ US$ 50 mn | medium |
| **China dependence** | China supplies ≥ 60 % of imports and imports ≥ US$ 50 mn | high if ≥ 80 %, else medium |

The value floors keep tiny, noisy flows out (the 2023 base floor on surges stops a first shipment from a near-zero
base appearing as a x300,000 "surge"). A surge or drop compares two single years, so it can reflect a
one-off shipment, a price change or a reporting change; open the product's trend before acting. The 2026-10-19
build raised 834 alerts (274 high).

---------------------------------------------------------------------------------------------------------------

## 7. Supply-chain risk dashboard

| Figure | Definition |
|---|---|
| **High-risk product** | vulnerability score ≥ 65 and imports ≥ US$ 1 mn. (Full dependence on a top-decile import already scores about 55–60; 65 additionally needs concentrated sourcing and/or a large China share.) |
| **Imports at risk** | India's 2024 imports of the high-risk products |
| **China-dependent imports** | imports *from China* (M_p × China share) in products where China supplies ≥ 60 % of India's imports |
| **Concentrated products** | India import HHI ≥ 0.6 and imports ≥ US$ 1 mn |
| **By sector** | import-weighted average vulnerability of the sector's products, and its imports at risk (a product belongs to the most common sector of its 8-digit lines) |
| **By source country** | India's imports of the high-risk products from each country (top 15) |

---------------------------------------------------------------------------------------------------------------

## 8. Value chains and the network graph

### 8.1 Sector deep-dive KPIs

* **Global exports, India's exports, India's imports** = sums over the distinct HS6 subheadings under the chain's
  anchor code (tyres: heading 4011 → its eight subheadings), 2024, CEPII BACI.
* **India's share** = India's exports ÷ global exports (a fraction; the app shows %).
* **India's rank** = India's position among the world's exporters of the anchor code (all its subheadings summed).
* **Global / India production** come from the sourced `production` table: UNIDO INDSTAT 2026 gross output (2022,
  US$), Rubber Board natural rubber (2024, tonnes) and ATMA tyres (2023, units). When no sourced row exists the KPI
  says *Not available*. When several rows exist for one figure, every page uses the same chooser: a *verified* row
  first, then the latest reference year, then the newest row.
* **Provenance per row.** Every figure carries its real source and year. Value-chain ministry ids are resolved from
  the Atlas product mapping, so a chain page can never name a different owner than the product page. An 8-digit
  item uses its direct Guidebook owner(s); a 4/6/2-digit item uses the most common non-residual primary owner of
  the accepted 8-digit lines under it. Chapters, headings and subheadings on the HSN pages show the full owner
  mix and line coverage derived from those accepted lines.

**Live check — tyres (HS 4011), 2024:**

| KPI | Atlas (CEPII BACI 2024) |
|---|---|
| Global exports | US$ 101.2 bn |
| India's exports | US$ 3.11 bn |
| India's share | 3.07 % |
| India's imports | US$ 0.216 bn |
| India's rank among suppliers | 8th |
| India's production | 217,000,000 units (ATMA, 2023) |

### 8.2 Stage items, risk flags and top categories

* Each value-chain item shows its HS6 trade (a 4-digit item sums the subheadings under it). *Linked* means the code
  resolves to trade data.
* **Risk flags** = items with imports ≥ US$ 1 mn that are vulnerable (score ≥ 50), import-dependent (dependency
  ratio ≥ 0.5) or China-dependent (China share ≥ 50 %), or that have an automated alert; most vulnerable first
  (up to 12).
* **Top export categories** = the five subheadings under the anchor with the largest Indian exports.

### 8.3 Supplier tiers (how deep the supply chain runs)

The stages of a value chain answer *what* the product is made of (raw materials → components → finished goods).
The tiers answer *how many hand-offs lie behind those inputs*:

| Tier | Meaning | Sports goods (the study's example supplier types) |
|---|---|---|
| 1 | Direct suppliers to the manufacturer | bat, ball, leather-apparel, synthetic-turf and industrial-adhesive manufacturers |
| 2 | Suppliers of raw materials, sub-components and processing services to Tier 1 | base-polymer, rubber-compound, textile, sewing-machine, button, marker and thread manufacturers |
| 3 | Sources of basic materials and commodities used by Tier 2 | petrochemical (nylon, rubber, additives), bolt, chemical, steel and timber suppliers |

* The **level, definition and example supplier types** of every tier are curated from the source study and carried
  through verbatim; they are the study's structure, not a derived number.
* The **items** of a tier are the Atlas's own HS-coded grounding of it: each item names an HS code that exists in
  both the GST HSN master and the HS 2022 nomenclature, with a one-line note on why the goods belong in that tier.
  A code may sit in a stage *and* in a tier, so the two views never overwrite each other.
* **Ministry** = the Atlas's own product mapping (the same mapping the product page shows), re-derived at load
  time from the 8-digit line's owner; the curated file never names a second opinion. The tier mapping is
  therefore *Not verified* until a ministry validates it.
* **Trade figures** = the HS6 line that carries the item's HS code (the same `hs6_metrics` figures as every other
  page, so a tier line and a stage line agree). A tier total is the sum of its items, so a line is counted twice
  when two items share an HS6 - the tier total is a scale indicator, not an economic aggregate.
* **Balance** = India's imports minus exports on the item's HS6: a positive number is a net import dependency at
  that tier.

### 8.4 Network graph and traces

* Edges are the curated value-chain links (input → output; relations *input to* / *component of*) plus, on request,
  *parts of* links derived from HS 2022 heading texts ("parts of the goods of heading 8703" and similar).
* A 4- or 6-digit code and the longer codes under it are the same goods at different levels, so they are treated as
  connected (an *HS hierarchy* edge links each node to its nearest displayed parent code). A chain view always
  shows the chain's anchor heading (4011 for tyres) as a node: it carries the chain-level production figure
  (the verified / latest row by the shared chooser) and its lines hang off it.
* Node figures: an 8- or 6-digit node shows its HS6 values; a 4- or 2-digit node sums its subheadings (RCA of the
  sum; vulnerability = import-weighted average).
* **Trace** follows the links upstream (inputs), downstream (users) or both, up to the chosen number of hops (≤ 6).
  **Critical inputs** = upstream nodes with imports ≥ US$ 1 mn that have vulnerability ≥ 50, dependency ratio ≥ 0.5
  or China share ≥ 50 %, ranked by vulnerability.

---------------------------------------------------------------------------------------------------------------

## 9. Policy Workbench

### 9.1 Schemes (PLI, QCO)

A scheme covers every 8-digit line under its HS prefixes. Product counts are current GST lines; trade adds up the
distinct HS6 subheadings (a 2/4/6-digit prefix brings the whole subheading, an 8-digit prefix only its line's share,
HS6 value ÷ lines). *Average RCA* is the simple mean over the covered subheadings. Scheme-to-HS mappings are
curated from public notifications and marked for verification in the data.

### 9.2 Trade negotiation analyser (FTA / CEPA)

For a partner country or all partners of an agreement (EU, ASEAN, …), 2024:

* **Offensive interests** (what India could ask for): India RCA ≥ 1 and the partner(s) import ≥ US$ 5 mn of the
  product from the world. **Gap** = max(0, India's world share × partner imports − India's exports to the partner):
  how much more India would sell there if it held its world-average share in that market. Top 50 by gap.
* **Defensive interests** (what India may need to protect): India imports ≥ US$ 5 mn from the partner(s), the
  partner is competitive (partner RCA ≥ 1, computed for the group as a whole) and India has a production base
  (India RCA ≥ 0.5) or the product is covered by a PLI scheme. Top 50 by imports.
* India's MFN tariff is shown for each line; the summary counts every qualifying product, not only the top 50.

### 9.3 Tariff (BCD) scenario simulator

Inputs: the codes, the new tariff t₁, and three assumptions you can change.

```
t₀              = current tariff: WITS MFN average, as a fraction
M₁              = M₀ × ((1 + t₁) / (1 + t₀))^(−σ)          σ = import price elasticity, default 2.5
revenue         = t × M  (before: t₀·M₀, after: t₁·M₁)
domestic gain   = −(M₁ − M₀) × substitution share          default 0.5
downstream cost = input cost share^hops × ((1 + t₁)/(1 + t₀) − 1) × 100 %   input cost share default 0.10
```

* M₀ is the 2024 BACI import value; an 8-digit line gets its HS6 imports ÷ lines in the HS6; a 2/4-digit code is
  simulated subheading by subheading.
* Downstream products are those reachable through the value-chain links (up to 3 hops by default). At one hop the
  cost effect is exactly the SPEC formula; each further hop multiplies by the input cost share again, because each
  stage passes on only its input's share of cost.
* Assumes full pass-through of the tariff to landed prices, a constant elasticity and no retaliation, exchange-rate
  or quality effects. A non-ad-valorem tariff cannot be simulated unless a base rate is given. Every response lists
  all assumptions used.

### 9.4 Demand–supply

Apparent consumption = production + imports − exports, and self-sufficiency = production ÷ apparent consumption,
computed **only when production is known in US$**. Production in tonnes or units cannot be combined with trade
values, so those rows show the production figure as reported and "Not available" for consumption. Production
figures today come from real sources for the pilot chains (*Verified*) — no production number is ever invented.

---------------------------------------------------------------------------------------------------------------

## 10. Data-quality score (product page)

```
30  ministry mapping verified (DPIIT Guidebook, official upload or approved manual change)
 0  residual line (including a line absent from the Guidebook; a derived parent hint earns no points)
30  trade data present
20  tariff present (WITS MFN average)
20  production present
                                  capped at 100
```

It tells you how much of a product's picture rests on verified data, not how important the product is.

---------------------------------------------------------------------------------------------------------------

## 11. Worked example — HS 401110, new pneumatic tyres for motor cars (2024)

Figures from the 2026-10-19 build. The test `test_worked_example_401110_recomputed_independently` recomputes
these scores from the raw tables in SQL.

**Trade picture** (CEPII BACI 2024)

| | Value |
|---|---|
| India's exports X_p | US$ 272.7 mn |
| India's imports M_p | US$ 66.9 mn |
| World trade W_p | US$ 52.75 bn |
| India's total exports X / world total W | US$ 454.8 bn / US$ 22,944 bn → overall share 1.98 % |
| India's world share X_p / W_p | 0.52 % — rank **32nd** of 174 exporters |
| RCA | (272.7 mn / 454.8 bn) ÷ (52.75 bn / 22,944 bn) = 0.000600 ÷ 0.002299 = **0.26** |
| Dependency ratio | 66.9 ÷ (66.9 + 272.7) = **0.197** |
| India import HHI | **0.224** (41 source countries; Thailand 42 %, Germany 15 %, Romania 9 %, China 8.5 %) |
| China import share | **0.085** |
| CAGR 2018–2024 | exports **+13.1 %**/yr (130.6 mn → 272.7 mn), world **+3.6 %**/yr, imports −17.7 %/yr |
| World supplier HHI | 0.064 (a diversified market) |

**Percentile ranks** (among the 5,606 subheadings with world trade): world trade 0.990, imports 0.821 (among the
5,291 with imports), world CAGR 0.705, export CAGR 0.740 (among the 5,391 with a CAGR).

**Export potential**

| Component | Calculation | Points |
|---|---|---|
| World market size | 0.35 × 0.990 | 34.64 |
| Competitiveness | 0.30 × min(0.26, 3) / 3 = 0.30 × 0.087 | 2.61 |
| World growth | 0.20 × 0.705 | 14.10 |
| India's momentum | 0.15 × 0.740 | 11.09 |
| **Export potential score** | | **62.4** |

A big, growing market where India is gaining fast, held back by low competitiveness (RCA 0.26).

**Untapped potential**: RCA 0.26 is below the 0.3 floor, so **US$ 0**. (Had RCA been ≥ 0.3: the benchmark share is
max(India's chapter-40 share 2.29 %, overall 1.98 %) = 2.29 %; 2.29 % × 52.75 bn − 272.7 mn ≈ US$ 0.94 bn.)

**Import dependency** = 100 × (0.5 × 0.197 + 0.3 × 0.821 + 0.2 × 0.224) = 9.85 + 24.62 + 4.48 = **38.9**

**Vulnerability** = 100 × (0.30 × 0.197 + 0.25 × 0.224 + 0.20 × 0.085 + 0.25 × 0.821)
= 5.91 + 5.60 + 1.70 + 20.52 = **33.7** — well below the high-risk line of 65: India is a net exporter and its
imports are spread over many countries.

**Import substitution**: imports (66.9 mn) are below exports (272.7 mn) → not a substitution candidate (empty).

**Archetype**: RCA < 1 (not Champion / Established); RCA < 0.3 (not Emerging); imports < 2 × exports (not
Dependent) → **Marginal**. Note the label describes today's competitiveness; the export potential score (62.4)
shows the product is nevertheless an attractive, fast-moving opportunity.

**Cluster**: 1 — *"Large world market, high India imports, high India exports"* (1,959 subheadings).

**Forecast** (exports): ln(exports) fitted on 2018–2024 (7 points): slope 0.145 → trend growth **+15.6 %/yr**,
residual standard error 0.212 → band factor e^(1.96 × 0.212) = 1.52.

| Year | Forecast | 95 % band |
|---|---|---|
| 2025 | US$ 321.0 mn | 211.8 – 486.7 mn |
| 2026 | US$ 371.3 mn | 244.9 – 562.8 mn |

Imports are trending down: 2025 US$ 36.3 mn (19.4 – 68.0 mn), 2026 US$ 28.8 mn (15.4 – 53.9 mn).

**Alerts**: none. Import YoY is +40 % (below +50 %), export YoY +25 %, import HHI 0.22, China share 8.5 %.

**Tariff simulation** for the 8-digit line 40111010 (radial car tyres), BCD raised from the MFN average 12.5 % to
20 %, default assumptions: M₀ = 66.9 mn ÷ 2 lines = US$ 33.4 mn; price ratio 1.20 / 1.125 = 1.0667;
M₁ = 33.4 mn × 1.0667^(−2.5) = US$ 28.5 mn (−4.98 mn); customs revenue 4.18 mn → 5.69 mn; domestic opportunity
0.5 × 4.98 mn = **US$ 2.49 mn**; downstream vehicles using tyres (motor cars, buses, lorries, motorcycles) see an
input-cost increase of 0.10 × 6.67 % = **0.67 %**.

**Data-quality score** of 40111010: Guidebook mapping 30 + trade 30 + tariff 20 + no product-level production
row 0 = **80**.

---------------------------------------------------------------------------------------------------------------

## 12. Caveats

* **HS6 granularity.** Indian 8-digit lines share their subheading's trade; differences between lines within an
  HS6 are invisible in BACI. Official DGCI&S 8-digit data would remove this limitation.
* **Mirror-reconciled data.** BACI reconciles exporter and importer declarations; India's figures can differ from
  DGCI&S / Ministry of Commerce statistics (the Data Hub cross-checks a sample against UN Comtrade).
* **Code changes.** 2018–2021 use HS 2017 and 2022–2024 HS 2022; subheadings created or split in 2022 have a short
  history, so their CAGR and forecast may be missing.
* **Relative scores.** Percentile-based scores rank products against each other; a score of 70 means "higher than
  most products", not a probability.
* **Weights are policy judgements.** The weights above follow the SPEC; they are fixed in code, documented here and
  can be revised by DPIIT. Changing them changes the ranking, not the underlying data.
* **Residual mapping.** The DPIIT Guidebook (16.12.2025) leaves 1,448 GST lines residual (495 Guidebook
  residual codes, 960 lines absent from the Guidebook). They stay Not verified. Ownership shown at 2/4/6 digits
  and a residual product's parent hint are derived from accepted 8-digit lines, not separate acceptances;
  ministry and sector totals include only accepted direct owners unless stated otherwise.
* **Production data** is sparse (sourced output exists for the pilot chains only). Demand–supply analysis is therefore limited until ministries
  upload production in value terms.
* **Forecasts and simulations** are model estimates with stated assumptions — useful for comparing options, not
  for predicting exact outcomes.
