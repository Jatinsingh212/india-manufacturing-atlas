"""ETL step 3 — ministries, sectors and the provisional HSN -> Ministry mapping.

Why a rule table
----------------
This step loads the ministry/sector registers and writes a provisional, fully transparent mapping
(``mapping_source='rule'``) from the rule table below. The next core step,
:mod:`scripts.etl.load_official_mapping`, replaces it with the official DPIIT Guidebook mapping
(``mapping_source='dpiit_guidebook'``). The rules are retained only for a build that explicitly
skips the official step; they are never used as a fallback for lines the Guidebook does not cover.
The rules follow the Government of India (Allocation of Business) Rules, 1961 as amended ("AoB") and
the commodity boards / councils each ministry runs.

Precedence (most specific wins) and confidence
----------------------------------------------
1. ``LINE_RULES``         an individual 8-digit line ...................... 0.90
2. ``TEXT_RULES``         regex on the line text / subheading text in a scope 0.80 (narrow scope, fuzzy match)
3. ``SUBHEADING_RULES``   6-digit subheading ............................. 0.85
4. generic residual       catch-all 'Other' line, see below .............. NULL (residual)
5. ``HEADING_RULES``      4-digit heading ................................ 0.75
6. ``CHAPTER_RULES``      2-digit chapter default ......................... 0.60
The rule that fired is stored in ``products.mapping_rule`` ('l33074100->msme',
't:ayush->ayush', 's854143->mnre', 'g:other-nec->residual', 'h8710->ddp', 'ch61->mot').

Residual products
-----------------
A line is left **Residual** (``ministry_id='residual'``, ``mapping_status='residual'``, confidence NULL,
no ``product_ministries`` rows) when no single owner can be inferred without seeing the actual product:

* explicit catch-all subheadings/headings of cross-cutting materials, machinery and instruments
  ('… n.e.c.' articles of plastics, iron and steel, base metals, machines and electrical apparatus,
  instruments) — every line under them (``SUBHEADING_RULES`` / ``HEADING_RULES`` with 'residual');
* generic residual: an 8-digit line whose own text is just 'Other'/'Others', inside an HS2022 subheading
  described as 'n.e.c.' / 'not elsewhere specified', in one of the multi-owner industrial chapters
  ``GENERIC_RESIDUAL_CHAPTERS``, unless a line, text or subheading rule names its owner. It outranks
  heading and chapter rules because those name the owner of the *typical* product of a heading, not of its
  'other, n.e.c.' remainder.

Chapters 98/99 (project imports, baggage, etc.) default to residual too, but those national lines have no
HS2022 subheading and are therefore not current lines.

Secondary owners
----------------
``SECONDARY_RULES`` add ``product_ministries`` rows with role 'secondary' where responsibility is shared
(e.g. vaccines: MoHFW primary, DoP secondary; solar modules: MNRE primary, MeitY secondary).

Also written here: ``ministries`` and ``sectors`` (curated JSON) and ``products.sector_id``. The old
``meta.guidebook_baseline`` key is deleted. ``products_fts`` is rebuilt at the end because it embeds the
ministry and sector names.
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from scripts.etl import CURATED_DIR
from scripts.etl.nomenclature import own_label, rebuild_fts

MINISTRIES_JSON = CURATED_DIR / "ministries.json"
SECTORS_JSON = CURATED_DIR / "sectors.json"

CONF_LINE, CONF_TEXT, CONF_SUBHEADING, CONF_HEADING, CONF_CHAPTER = 0.9, 0.8, 0.85, 0.75, 0.6
RESIDUAL = "residual"

# ============================================================================ THE RULE TABLE
# chapter -> (ministry_id, rationale)
CHAPTER_RULES: dict[str, tuple[str, str]] = {
    "01": ("dahd", "Live animals - animal husbandry"),
    "02": ("mofpi", "Meat and offal - meat & poultry processing (AoB MoFPI)"),
    "03": ("dofish", "Fish, crustaceans, molluscs - fisheries development"),
    "04": ("dahd", "Milk, eggs, edible animal products - animal husbandry & dairying"),
    "05": ("dahd", "Products of animal origin n.e.s."),
    "06": ("dafw", "Live plants, floriculture - horticulture mission"),
    "07": ("dafw", "Vegetables - horticulture"),
    "08": ("dafw", "Fruit and nuts - horticulture"),
    "09": ("doc", "Coffee, tea, spices - Coffee / Tea / Spices Boards (DoC)"),
    "10": ("dafw", "Cereals - crop production"),
    "11": ("mofpi", "Milling products - food-grain milling (AoB MoFPI)"),
    "12": ("dafw", "Oilseeds, misc. grains, fodder"),
    "13": ("dafw", "Lac, gums, resins, plant extracts"),
    "14": ("dafw", "Vegetable plaiting materials"),
    "15": ("dfpd", "Edible oils and vanaspati (AoB DFPD)"),
    "16": ("mofpi", "Meat and fish preparations"),
    "17": ("dfpd", "Sugar (AoB DFPD)"),
    "18": ("mofpi", "Cocoa processing and chocolate (AoB MoFPI)"),
    "19": ("mofpi", "Bakery, breakfast cereals, pasta"),
    "20": ("mofpi", "Fruit and vegetable preparations"),
    "21": ("mofpi", "Miscellaneous edible preparations"),
    "22": ("mofpi", "Beverages, beer, non-molasses spirits, aerated waters (AoB MoFPI)"),
    "23": ("dahd", "Animal feed and food-industry residues"),
    "24": ("doc", "Unmanufactured tobacco - Tobacco Board (DoC)"),
    "25": ("mom", "Salt, earths, stone, minerals"),
    "26": ("mom", "Ores, slag and ash"),
    "27": ("mopng", "Mineral fuels, petroleum products and gas"),
    "28": ("dcpc", "Inorganic chemicals"),
    "29": ("dcpc", "Organic chemicals"),
    "30": ("dop", "Pharmaceutical products"),
    "31": ("dofert", "Fertilisers"),
    "32": ("dcpc", "Dyes, pigments, paints, inks"),
    "33": ("dcpc", "Essential oils, perfumery, cosmetics"),
    "34": ("dcpc", "Soaps, detergents, waxes"),
    "35": ("dcpc", "Albuminoids, glues, enzymes"),
    "36": ("dpiit", "Explosives, matches, fireworks - PESO under DPIIT"),
    "37": ("dcpc", "Photographic and cinematographic goods"),
    "38": ("dcpc", "Miscellaneous chemical products incl. pesticides"),
    "39": ("dcpc", "Polymers and plastics processing (petrochemicals)"),
    "40": ("dpiit", "Rubber products and tyres - rubber goods industry"),
    "41": ("dpiit", "Hides, skins and leather - leather industry"),
    "42": ("dpiit", "Leather articles, travel goods"),
    "43": ("dpiit", "Furskins"),
    "44": ("dpiit", "Wood and articles of wood"),
    "45": ("dpiit", "Cork"),
    "46": ("dpiit", "Straw and plaiting manufactures"),
    "47": ("dpiit", "Pulp - paper industry"),
    "48": ("dpiit", "Paper and paperboard - paper industry"),
    "49": ("mib", "Printed books, newspapers - Registrar of Newspapers / publications"),
    **{f"{c}": ("mot", "Textiles and apparel (AoB MoT)") for c in map(str, range(50, 64))},
    "64": ("dpiit", "Footwear - leather & footwear industry"),
    "65": ("dpiit", "Headgear"),
    "66": ("dpiit", "Umbrellas, walking sticks"),
    "67": ("dpiit", "Feathers, artificial flowers, human-hair articles"),
    "68": ("dpiit", "Articles of stone, cement, asbestos"),
    "69": ("dpiit", "Ceramic products"),
    "70": ("dpiit", "Glass and glassware"),
    "71": ("doc", "Gems and jewellery - GJEPC under DoC"),
    "72": ("mos", "Iron and steel (AoB MoS)"),
    "73": ("mos", "Articles of iron or steel"),
    **{c: ("mom", "Non-ferrous metals - metallurgy of non-ferrous metals (AoB MoM)")
       for c in ("74", "75", "76", "78", "79", "80", "81")},
    "82": ("dpiit", "Tools, implements, cutlery"),
    "83": ("dpiit", "Miscellaneous articles of base metal"),
    "84": ("dpiit", "General machinery and mechanical appliances"),
    "85": ("meity", "Electrical machinery and electronics"),
    "86": ("mor", "Railway rolling stock and track fixtures"),
    "87": ("mhi", "Vehicles - automobile industry (AoB MHI)"),
    "88": ("moca", "Aircraft, drones, spacecraft"),
    "89": ("mopsw", "Ships, boats - shipbuilding"),
    "90": ("dpiit", "Optical, measuring and precision instruments"),
    "91": ("dpiit", "Clocks and watches"),
    "92": ("dpiit", "Musical instruments"),
    "93": ("ddp", "Arms and ammunition"),
    "94": ("dpiit", "Furniture, bedding, lighting, prefabricated buildings"),
    "95": ("dpiit", "Toys, games, sports goods"),
    "96": ("dpiit", "Miscellaneous manufactured articles"),
    "97": ("mocul", "Works of art, collectors' pieces, antiques"),
    "98": (RESIDUAL, "National special classification (project imports, baggage)"),
    "99": (RESIDUAL, "National special classification"),
}

# heading -> (ministry_id, rationale)
HEADING_RULES: dict[str, tuple[str, str]] = {
    "0303": ("mofpi", "Frozen fish - fish processing incl. freezing (AoB MoFPI)"),
    "0304": ("mofpi", "Fish fillets and fish meat - fish processing"),
    "0305": ("mofpi", "Dried, salted, smoked fish - fish processing"),
    "0309": ("mofpi", "Flours, meals and pellets of fish - fish processing"),
    "0402": ("mofpi", "Milk powder, condensed milk - dairy products (AoB MoFPI)"),
    "0403": ("mofpi", "Yoghurt, buttermilk - dairy products"),
    "0404": ("mofpi", "Whey - dairy products"),
    "0405": ("mofpi", "Butter and ghee - dairy products"),
    "0406": ("mofpi", "Cheese - dairy products"),
    "0408": ("mofpi", "Eggs not in shell, egg powder - egg processing"),
    "0409": ("dafw", "Natural honey - National Bee Board (DA&FW)"),
    "0710": ("mofpi", "Frozen vegetables - freezing & dehydration (AoB MoFPI)"),
    "0711": ("mofpi", "Provisionally preserved vegetables"),
    "0712": ("mofpi", "Dried vegetables"),
    "0811": ("mofpi", "Frozen fruit"),
    "0812": ("mofpi", "Provisionally preserved fruit"),
    "0813": ("mofpi", "Dried fruit"),
    "0814": ("mofpi", "Peel of citrus fruit or melons"),
    "1208": ("mofpi", "Flours and meals of oil seeds - oilseed meals (edible) (AoB MoFPI)"),
    "1211": ("ayush", "Medicinal and aromatic plants - National Medicinal Plants Board (Ayush)"),
    "1501": ("mofpi", "Pig and poultry fat - meat-processing by-product"),
    "1502": ("mofpi", "Bovine fat (tallow) - meat-processing by-product"),
    "1503": ("mofpi", "Lard stearin, lard oil"),
    "1504": ("mofpi", "Fish oils - fish processing"),
    "1505": ("dcpc", "Wool grease and lanolin - oleochemicals"),
    "1506": ("mofpi", "Other animal fats and oils"),
    "1520": ("dcpc", "Glycerol - oleochemicals"),
    "1704": ("mofpi", "Sugar confectionery (AoB MoFPI)"),
    "1801": ("dafw", "Cocoa beans - Directorate of Cashewnut & Cocoa Development"),
    "1802": ("dafw", "Cocoa shells and husks"),
    "2207": ("dfpd", "Ethyl alcohol (molasses / grain ethanol) - sugar & ethanol (DFPD); AoB gives MoFPI only non-molasses drinks"),
    "2302": ("mofpi", "Bran and other milling residues - food-grain milling"),
    "2303": ("mofpi", "Residues of starch manufacture, brewing and distilling"),
    "2304": ("dfpd", "Soybean oil-cake - by-product of vegetable-oil extraction"),
    "2305": ("dfpd", "Groundnut oil-cake"),
    "2306": ("dfpd", "Other oil-cakes"),
    "2307": ("mofpi", "Wine lees, argol"),
    "2402": ("dpiit", "Cigars and cigarettes - manufactured tobacco (IDR Act industry)"),
    "2403": ("dpiit", "Manufactured tobacco"),
    "2404": ("dpiit", "Nicotine products"),
    "2501": ("dpiit", "Salt - Salt Commissioner (DPIIT)"),
    "2523": ("dpiit", "Cement - cement industry (DPIIT)"),
    "2612": ("dae", "Uranium and thorium ores (DAE)"),
    "2701": ("mocoal", "Coal"),
    "2702": ("mocoal", "Lignite"),
    "2703": ("mocoal", "Peat"),
    "2704": ("mocoal", "Coke and semi-coke"),
    "2705": ("mocoal", "Coal gas"),
    "2706": ("mocoal", "Tar distilled from coal"),
    "2716": ("mop", "Electrical energy"),
    "2809": ("dofert", "Phosphoric acid - DAP / complex fertiliser feedstock"),
    "2814": ("dofert", "Ammonia - nitrogenous fertiliser feedstock"),
    "2844": ("dae", "Radioactive elements and isotopes"),
    "2845": ("dae", "Isotopes, heavy water"),
    "2846": ("dae", "Rare-earth compounds - IREL (DAE)"),
    "2933": ("dop", "Heterocyclic N-compounds - bulk drugs / APIs (industrial exceptions below)"),
    "2934": ("dop", "Nucleic acids and other heterocyclics - APIs"),
    "2935": ("dop", "Sulphonamides - APIs"),
    "2936": ("dop", "Vitamins and provitamins"),
    "2937": ("dop", "Hormones and steroids"),
    "2938": ("dop", "Glycosides"),
    "2939": ("dop", "Alkaloids"),
    "2940": ("dop", "Chemically pure sugars"),
    "2941": ("dop", "Antibiotics"),
    "2942": ("dop", "Other organic compounds (pharmaceutical)"),
    "3002": ("mohfw", "Vaccines, blood, sera - public health (MoHFW)"),
    **{h: ("dpiit", "Perfumery, cosmetics and toilet preparations - IDR Act consumer industry (DPIIT)")
       for h in ("3303", "3304", "3305", "3306", "3307")},
    "3401": ("dpiit", "Soap - IDR Act 'soaps, cosmetics and toilet preparations' (DPIIT)"),
    "3405": ("dpiit", "Polishes and creams - consumer products"),
    "3406": ("dpiit", "Candles - consumer products"),
    "3407": ("dpiit", "Modelling pastes, dental waxes"),
    "3506": ("dpiit", "Prepared glues and adhesives (DPIIT)"),
    **{h: ("dpiit", "Photographic plates, film and paper - IDR Act 'photographic raw film and paper' (DPIIT)")
       for h in ("3701", "3702", "3703", "3704", "3705")},
    "3706": ("mib", "Cinematographic film, exposed - film industry (MoI&B)"),
    "3818": ("meity", "Doped wafers for electronics"),
    "3825": ("moefcc", "Municipal, clinical and hazardous waste; sewage sludge - waste rules (MoEFCC)"),
    "3826": ("mopng", "Biodiesel - National Policy on Biofuels (MoPNG nodal)"),
    "3822": ("dop", "Diagnostic and laboratory reagents - in-vitro diagnostics (medical devices, DoP)"),
    "4001": ("doc", "Natural rubber - Rubber Board (DoC)"),
    "4011": ("dpiit", "New pneumatic tyres - tyre industry (DPIIT)"),
    "4012": ("dpiit", "Retreaded / used tyres, flaps - tyre industry"),
    "4013": ("dpiit", "Inner tubes - tyre industry"),
    "4002": ("dcpc", "Synthetic rubber - petrochemicals"),
    "4401": ("moefcc", "Fuel wood - forest produce"),
    "4402": ("moefcc", "Wood charcoal - forest produce"),
    "4403": ("moefcc", "Wood in the rough - forest produce"),
    "4420": ("mot", "Wooden statuettes, caskets, marquetry - handicrafts (DC Handicrafts, MoT)"),
    "4602": ("mot", "Basketwork, wickerwork - cane & bamboo handicrafts"),
    "6505": ("mot", "Knitted / textile hats and hairnets"),
    "6702": ("mot", "Artificial flowers - handicrafts"),
    "6913": ("mot", "Ceramic statuettes and ornaments - handicrafts"),
    "7019": ("mot", "Glass fibres and fabrics - technical textiles (NTTM)"),
    "7117": ("mot", "Imitation jewellery - handicrafts"),
    "7310": ("dpiit", "Steel drums, cans and containers - light engineering"),
    "7311": ("dpiit", "Gas cylinders - PESO gas cylinder rules (DPIIT)"),
    **{h: ("dpiit", "Fabricated articles of iron or steel (chains, fasteners, needles, springs, stoves, "
                    "household and sanitary ware) - light engineering (DPIIT); MoS keeps primary steel, "
                    "tubes, structures and wire")
       for h in ("7315", "7316", "7317", "7318", "7319", "7320", "7321", "7322", "7323", "7324", "7325",
                 "7326")},
    "7418": ("dpiit", "Household and sanitary articles of copper - consumer goods"),
    "7615": ("dpiit", "Household articles of aluminium incl. pressure cookers - consumer goods (QCO, DPIIT)"),
    "8306": ("mot", "Bells, statuettes, frames of base metal - art metalware handicrafts"),
    "8401": ("dae", "Nuclear reactors and fuel elements"),
    **{h: ("mhi", "Boilers, engines, turbines - heavy engineering (MHI)")
       for h in ("8402", "8403", "8404", "8405", "8406", "8407", "8408", "8409", "8410", "8411", "8412")},
    "8429": ("mhi", "Earth-moving machinery - capital goods"),
    "8430": ("mhi", "Mining and construction machinery - capital goods"),
    "8432": ("dafw", "Agricultural machinery - farm mechanisation"),
    "8433": ("dafw", "Harvesting and threshing machinery - farm mechanisation"),
    "8436": ("dafw", "Agricultural, horticultural and poultry machinery"),
    **{h: ("mhi", "Textile machinery - capital goods")
       for h in ("8444", "8445", "8446", "8447", "8448", "8449")},
    **{h: ("mhi", "Machine tools - capital goods")
       for h in ("8456", "8457", "8458", "8459", "8460", "8461", "8462", "8463", "8464", "8465", "8466")},
    "8470": ("meity", "Calculators, data-recording machines"),
    "8471": ("meity", "Computers and peripherals"),
    "8472": ("meity", "Office machines"),
    "8473": ("meity", "Parts of computers and office machines"),
    "8486": ("meity", "Semiconductor manufacturing equipment - India Semiconductor Mission"),
    "8487": (RESIDUAL, "Machinery parts n.e.s. (except propellers, below)"),
    "8501": ("mhi", "Electric motors and generators - heavy electricals"),
    "8502": ("mhi", "Generating sets"),
    "8503": ("mhi", "Parts of motors and generators"),
    "8504": ("mhi", "Transformers, converters"),
    "8506": ("dpiit", "Primary cells and batteries - light electricals"),
    "8507": ("mhi", "Accumulators - ACC battery PLI (MHI)"),
    "8508": ("dpiit", "Vacuum cleaners - consumer durables"),
    "8509": ("dpiit", "Domestic electro-mechanical appliances - consumer durables"),
    "8510": ("dpiit", "Shavers, hair clippers - consumer durables"),
    "8511": ("mhi", "Ignition and starting equipment for engines - auto electricals"),
    "8512": ("mhi", "Lighting and signalling equipment for vehicles - auto electricals"),
    "8513": ("dpiit", "Portable electric lamps - consumer goods"),
    "8514": ("mhi", "Industrial furnaces and ovens - capital goods"),
    "8515": ("mhi", "Welding machines - capital goods"),
    "8516": ("dpiit", "Electro-thermic domestic appliances - consumer durables"),
    "8517": ("dot", "Telephone and network equipment - telecom (DoT)"),
    "8535": ("mhi", "Switchgear above 1000 V - heavy electricals"),
    "8536": ("mhi", "Switchgear up to 1000 V"),
    "8537": ("mhi", "Control panels"),
    "8530": ("mor", "Railway and traffic signalling equipment"),
    "8539": ("dpiit", "Lamps incl. LED - White Goods PLI (DPIIT)"),
    "8544": ("mhi", "Insulated wire and cables"),
    "8546": ("mhi", "Electrical insulators"),
    "8547": ("mhi", "Insulating fittings"),
    "8548": (RESIDUAL, "Electrical parts n.e.s."),
    "8710": ("ddp", "Tanks and armoured fighting vehicles"),
    "8712": ("dpiit", "Bicycles"),
    "8713": ("dpiit", "Carriages for disabled persons"),
    "9018": ("dop", "Medical instruments - medical devices (DoP)"),
    "9019": ("dop", "Therapy apparatus - medical devices"),
    "9020": ("dop", "Breathing appliances - medical devices"),
    "9021": ("dop", "Orthopaedic appliances, implants - medical devices"),
    "9022": ("dop", "X-ray apparatus - medical devices"),
    "9601": ("mot", "Worked ivory, bone, horn, shell - handicrafts"),
    "9602": ("mot", "Worked vegetable carving materials - handicrafts"),
    "9619": ("mot", "Sanitary towels, diapers - hygiene technical textiles (NTTM)"),
}

# subheading -> (ministry_id, rationale)
SUBHEADING_RULES: dict[str, tuple[str, str]] = {
    "051191": ("dofish", "Products of fish n.e.s."),
    "293331": ("dcpc", "Pyridine and its salts - industrial chemical"),
    "293361": ("dcpc", "Melamine - industrial chemical"),
    "293369": ("dcpc", "Other triazines (e.g. herbicides)"),
    "293371": ("dcpc", "Caprolactam - nylon intermediate"),
    "293392": ("dcpc", "Azinphos-methyl - pesticide"),
    "293420": ("dcpc", "Benzothiazoles - rubber chemicals (DCPC)"),
    "382499": (RESIDUAL, "Chemical products n.e.c. - multi-owner catch-all"),
    "392690": (RESIDUAL, "Other articles of plastics n.e.c."),
    "732690": (RESIDUAL, "Other articles of iron or steel n.e.c."),
    "741980": (RESIDUAL, "Other articles of copper n.e.c."),
    "761699": (RESIDUAL, "Other articles of aluminium n.e.c."),
    "780600": (RESIDUAL, "Other articles of lead"),
    "790700": (RESIDUAL, "Other articles of zinc"),
    "800700": (RESIDUAL, "Other articles of tin"),
    "841912": ("mnre", "Solar water heaters"),
    "847989": (RESIDUAL, "Machines having individual functions n.e.c."),
    "847990": (RESIDUAL, "Parts of machines n.e.c."),
    "848710": ("mopsw", "Ships' propellers"),
    "850231": ("mnre", "Wind-powered generating sets"),
    "851713": ("meity", "Smartphones - Large Scale Electronics Manufacturing PLI (MeitY)"),
    "851714": ("meity", "Other mobile phones"),
    "854142": ("mnre", "Photovoltaic cells not in modules - solar PV PLI (MNRE)"),
    "854143": ("mnre", "Photovoltaic modules / panels"),
    "854370": (RESIDUAL, "Electrical machines and apparatus n.e.c."),
    "854390": (RESIDUAL, "Parts of electrical apparatus n.e.c."),
    "854470": ("dot", "Optical fibre cables - BharatNet (DoT)"),
    "854800": (RESIDUAL, "Electrical parts n.e.c."),
    "871410": ("mhi", "Parts of motorcycles"),
    "871420": ("dpiit", "Parts of carriages for disabled persons"),
    **{s: ("dpiit", "Parts of bicycles") for s in ("871491", "871492", "871493", "871494", "871495",
                                                   "871496", "871499")},
    "890610": ("ddp", "Warships"),
    "940440": ("mot", "Quilts, bedspreads, eiderdowns - textile made-ups"),
    "940490": ("mot", "Pillows, cushions and other bedding - textile made-ups"),
    "900110": ("dot", "Optical fibres and bundles"),
    "902830": ("mop", "Electricity meters - Smart Meter National Programme (MoP)"),
    "903180": (RESIDUAL, "Measuring or checking instruments n.e.c."),
    "903300": (RESIDUAL, "Parts of chapter-90 instruments n.e.c."),
}

# 8-digit line -> (ministry_id, rationale)
LINE_RULES: dict[str, tuple[str, str]] = {
    "33074100": ("msme", "Agarbatti - KVIC / Ministry of MSME"),
}

# (rule id, prefixes in scope, field 'line' | 'hs6', regex, ministry_id, rationale)
TEXT_RULES: list[tuple[str, tuple[str, ...], str, str, str, str]] = [
    ("ayush", ("3003", "3004"), "line", r"AYURVED|UNANI|SIDDHA|HOMOEOPATH|HOMEOPATH|BIO-?CHEMIC",
     "ayush", "Ayurvedic / Unani / Siddha / Homoeopathic medicaments (Ministry of Ayush)"),
    ("coir", ("44", "53", "56", "57", "63", "94"), "line", r"\bCOIR\b",
     "msme", "Coir fibre, yarn, mats, boards - Coir Board (Ministry of MSME)"),
    ("fish-processed", ("0306", "0307", "0308"), "hs6", r"\b(?:frozen|dried|salted|smoked|brine|cooked)\b",
     "mofpi", "Frozen / dried / salted / smoked crustaceans and molluscs - fish processing (AoB MoFPI)"),
]

# Generic catch-all residual: 'Other' lines of n.e.c. subheadings in these multi-owner chapters.
GENERIC_RESIDUAL_CHAPTERS = frozenset({"25", "26", "27", "28", "29", "30", "33", "38", "39", "40", "44", "68",
                                       "69", "70", "73", "74", "76", "81", "82", "83", "84", "85", "87", "90",
                                       "96"})
_NEC = re.compile(r"n\.e\.c|n\.e\.s|not elsewhere|not specified|elsewhere included", re.I)
_GENERIC_LINE = {"OTHER", "OTHERS"}

# prefix (2/4/6/8 digits) -> secondary ministries (added when different from the primary)
SECONDARY_RULES: dict[str, tuple[str, ...]] = {
    "0303": ("dofish",), "0304": ("dofish",), "0305": ("dofish",), "0309": ("dofish",),
    "0402": ("dahd",), "0403": ("dahd",), "0404": ("dahd",), "0405": ("dahd",), "0406": ("dahd",),
    "0408": ("dahd",),
    "0710": ("dafw",), "0711": ("dafw",), "0712": ("dafw",),
    "0811": ("dafw",), "0812": ("dafw",), "0813": ("dafw",), "0814": ("dafw",),
    "1211": ("dafw",),
    "2523": ("mom",), "2612": ("mom",),
    "3002": ("dop",),
    "3825": ("dcpc",), "3826": ("mnre",),
    "4420": ("dpiit",), "4602": ("dpiit",), "6702": ("dpiit",), "6913": ("dpiit",), "7019": ("dpiit",),
    "7117": ("dpiit",), "8306": ("dpiit",), "9601": ("dpiit",), "9602": ("dpiit",),
    "7302": ("mor",),
    **{h: ("mos",) for h in ("7310", "7311", "7315", "7316", "7317", "7318", "7319", "7320", "7321", "7322",
                            "7323", "7324", "7325", "7326")},
    "5501": ("dcpc",), "5503": ("dcpc",),
    "2207": ("mopng",),
    "8517": ("meity",), "851713": ("dot",), "851714": ("dot",),
    "850231": ("mhi",), "854142": ("meity",), "854143": ("meity",),
    "854470": ("mhi",),
    "9018": ("mohfw",), "9019": ("mohfw",), "9020": ("mohfw",), "9021": ("mohfw",), "9022": ("mohfw",),
}
TEXT_RULE_SECONDARY: dict[str, tuple[str, ...]] = {"ayush": ("dop",), "coir": ("mot",),
                                                   "fish-processed": ("dofish",)}

# ============================================================================ classification

@dataclass
class Assignment:
    """Result of classifying one 8-digit line."""
    ministry_id: str
    rule: str
    confidence: float | None
    source: str = "rule"
    secondary: tuple[str, ...] = field(default_factory=tuple)

    @property
    def status(self) -> str:
        return "residual" if self.ministry_id == RESIDUAL else "accepted"


_TEXT_RULES = [(rid, scope, fld, re.compile(rx, re.I), mid, note) for rid, scope, fld, rx, mid, note in TEXT_RULES]


def _secondaries(hsn8: str, primary: str, extra: tuple[str, ...] = ()) -> tuple[str, ...]:
    out: list[str] = []
    for prefix in (hsn8[:2], hsn8[:4], hsn8[:6], hsn8):
        for mid in SECONDARY_RULES.get(prefix, ()):
            if mid not in out:
                out.append(mid)
    for mid in extra:
        if mid not in out:
            out.append(mid)
    return tuple(m for m in out if m != primary and primary != RESIDUAL)


def is_generic_line(line_text: str) -> bool:
    """True when the line's own text (last hierarchy segment) is just 'Other' / 'Others'."""
    return own_label(line_text or "").strip().upper().rstrip(":.;, ") in _GENERIC_LINE


def classify(hsn8: str, line_text: str = "", hs6_description: str = "") -> Assignment:
    """Assign one 8-digit line to its owner following the precedence documented in the module docstring."""
    hs2, hs4, hs6 = hsn8[:2], hsn8[:4], hsn8[:6]
    if hsn8 in LINE_RULES:
        mid = LINE_RULES[hsn8][0]
        return Assignment(mid, f"l{hsn8}->{mid}", CONF_LINE, secondary=_secondaries(hsn8, mid))
    for rid, scope, fld, rx, mid, _note in _TEXT_RULES:
        if hsn8.startswith(scope) and rx.search(line_text if fld == "line" else hs6_description):
            return Assignment(mid, f"t:{rid}->{mid}", CONF_TEXT,
                              secondary=_secondaries(hsn8, mid, TEXT_RULE_SECONDARY.get(rid, ())))
    if hs6 in SUBHEADING_RULES:
        mid = SUBHEADING_RULES[hs6][0]
        return Assignment(mid, f"s{hs6}->{mid}", None if mid == RESIDUAL else CONF_SUBHEADING,
                          secondary=_secondaries(hsn8, mid))
    if hs2 in GENERIC_RESIDUAL_CHAPTERS and _NEC.search(hs6_description or "") and is_generic_line(line_text):
        return Assignment(RESIDUAL, "g:other-nec->residual", None)
    if hs4 in HEADING_RULES:
        mid = HEADING_RULES[hs4][0]
        return Assignment(mid, f"h{hs4}->{mid}", None if mid == RESIDUAL else CONF_HEADING,
                          secondary=_secondaries(hsn8, mid))
    mid = CHAPTER_RULES.get(hs2, (RESIDUAL, ""))[0]
    return Assignment(mid, f"ch{hs2}->{mid}", None if mid == RESIDUAL else CONF_CHAPTER,
                      secondary=_secondaries(hsn8, mid))


# ============================================================================ sectors

def load_sector_index() -> tuple[list[dict], dict[str, str], dict[str, str]]:
    """Return (sectors, chapter->sector, heading->sector) from ``curated/sectors.json``."""
    data = json.loads(SECTORS_JSON.read_text(encoding="utf-8"))
    sectors = data["sectors"]
    by_chapter = {ch: s["id"] for s in sectors for ch in s.get("chapters", [])}
    return sectors, by_chapter, dict(data.get("heading_overrides", {}))


def sector_for(code: str, by_chapter: dict[str, str], by_heading: dict[str, str]) -> str | None:
    """Sector of an HS code (heading override wins over the chapter)."""
    return by_heading.get(code[:4]) or by_chapter.get(code[:2])


# ============================================================================ step

def run(conn: sqlite3.Connection) -> dict:
    """Load ministries/sectors, write the provisional rule mapping, rebuild FTS.

    The official Guidebook step runs immediately after and overwrites every product's owner.
    """
    mdata = json.loads(MINISTRIES_JSON.read_text(encoding="utf-8"))
    ministries = mdata["ministries"]
    conn.executemany(
        "INSERT OR REPLACE INTO ministries(id, short_name, name, parent_ministry, kind, website, color) "
        "VALUES (?,?,?,?,?,?,?)",
        [(m["id"], m["short_name"], m["name"], m.get("parent_ministry"), m["kind"], m.get("website"),
          m.get("color")) for m in ministries])
    known = {m["id"] for m in ministries}
    referenced = ({v[0] for t in (CHAPTER_RULES, HEADING_RULES, SUBHEADING_RULES, LINE_RULES) for v in t.values()}
                  | {r[4] for r in TEXT_RULES}
                  | {s for v in SECONDARY_RULES.values() for s in v})
    unknown = referenced - known
    if unknown:
        raise ValueError(f"mapping rules reference unknown ministry ids: {sorted(unknown)}")

    sectors, by_chapter, by_heading = load_sector_index()
    conn.executemany(
        "INSERT OR REPLACE INTO sectors(id, name, description, color, icon, chapters) VALUES (?,?,?,?,?,?)",
        [(s["id"], s["name"], s.get("description"), s.get("color"), s.get("icon"),
          json.dumps(s.get("chapters", []))) for s in sectors])

    hs6_desc = dict(conn.execute("SELECT code, description FROM hs_nodes WHERE level = 6"))
    products = conn.execute("SELECT hsn8, line_description, is_current FROM products ORDER BY hsn8").fetchall()
    updates, pm_rows = [], []
    dist: Counter = Counter()
    by_source: Counter = Counter()
    for hsn8, line_text, is_current in products:
        a = classify(hsn8, line_text or "", hs6_desc.get(hsn8[:6], ""))
        updates.append((sector_for(hsn8, by_chapter, by_heading), a.ministry_id, a.status, a.source,
                        a.confidence, a.rule, hsn8))
        if a.ministry_id != RESIDUAL:
            pm_rows.append((hsn8, a.ministry_id, "primary"))
            pm_rows.extend((hsn8, s, "secondary") for s in a.secondary)
        if is_current:
            dist[a.ministry_id] += 1
            by_source[a.source] += 1
    conn.executemany(
        "UPDATE products SET sector_id=?, ministry_id=?, mapping_status=?, mapping_source=?, mapping_confidence=?,"
        " mapping_rule=? WHERE hsn8=?", updates)
    conn.executemany("INSERT OR IGNORE INTO product_ministries(hsn8, ministry_id, role) VALUES (?,?,?)", pm_rows)

    # Product figures come from BACI (trade) and WITS (tariffs); no baseline is published.
    conn.execute("DELETE FROM meta WHERE key = 'guidebook_baseline'")
    n_fts = rebuild_fts(conn)

    missing_owner = sorted(known - set(dist) - {RESIDUAL})
    n_current = sum(dist.values())
    return {
        "ministries": len(ministries),
        "sectors": len(sectors),
        "products_mapped": len(updates),
        "product_ministries": len(pm_rows),
        "products_fts": n_fts,
        "current_lines": n_current,
        "residual_current": dist.get(RESIDUAL, 0),
        "residual_share": round(dist.get(RESIDUAL, 0) / n_current, 4) if n_current else None,
        "ministries_with_codes": len([m for m in dist if m != RESIDUAL]),
        "ministries_without_codes": missing_owner,
        "by_source": dict(by_source),
        "distribution": dict(dist.most_common()),
    }


def describe_rules() -> list[dict]:
    """Flatten the rule table (for documentation / the About page)."""
    rows = []
    for level, table, conf in (("chapter", CHAPTER_RULES, CONF_CHAPTER), ("heading", HEADING_RULES, CONF_HEADING),
                               ("subheading", SUBHEADING_RULES, CONF_SUBHEADING), ("line", LINE_RULES, CONF_LINE)):
        for code, (mid, note) in sorted(table.items()):
            rows.append({"level": level, "code": code, "ministry_id": mid, "confidence": conf, "note": note})
    for rid, scope, fld, rx, mid, note in TEXT_RULES:
        rows.append({"level": "text", "code": ",".join(scope), "ministry_id": mid, "confidence": CONF_TEXT,
                     "note": f"{note} [{fld} ~ /{rx}/]"})
    return rows
