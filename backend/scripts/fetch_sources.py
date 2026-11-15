"""Download the public source datasets the Atlas is built on.

Every file lands in backend/data/raw/ and is recorded in raw/manifest.json with its
source URL, fetch time and row count, so the Data Hub can show provenance.

Sources
-------
* HS nomenclature (WCO structure, via UN Comtrade / datahub.io)          -> hs_nomenclature.csv
* GST portal HSN master (India's 8-digit codes)                          -> gst_hsn_master.xlsx
* CEPII BACI world trade, served by the OEC tesseract API                -> oec_*.csv.gz
* World Bank WITS / UNCTAD TRAINS India MFN applied tariffs              -> wits_india_mfn_<year>.csv

Usage:  python scripts/fetch_sources.py [dataset ...]   (no args = everything missing)
        python scripts/fetch_sources.py --force oec_world_hs6_hs22
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"
MANIFEST = RAW / "manifest.json"
UA = {"User-Agent": "IndiaManufacturingAtlas/1.0 (research; contact: platform admin)"}
OEC = "https://api-v2.oec.world/tesseract/data.jsonrecords"
PAGE = 100_000
LATEST_YEAR = 2024
INDIA = "asind"


def _manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {}


def _record(name: str, **meta) -> None:
    m = _manifest()
    m[name] = {"fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **meta}
    MANIFEST.write_text(json.dumps(m, indent=2), encoding="utf-8")


def _get(url: str, params: dict | None = None, timeout: int = 180, tries: int = 5) -> requests.Response:
    last = None
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=timeout)
            if r.status_code == 200:
                return r
            last = RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
        except requests.RequestException as e:  # network hiccup -> retry
            last = e
        time.sleep(2 ** attempt)
    raise RuntimeError(f"GET failed after {tries} tries: {url} {params} :: {last}")


def oec_query(cube: str, drilldowns: str, cuts: dict | None = None) -> tuple[list[str], list[dict]]:
    """Fetch every page of an OEC tesseract query. Returns (columns, rows)."""
    rows: list[dict] = []
    cols: list[str] = []
    offset = 0
    while True:
        params = {"cube": cube, "drilldowns": drilldowns, "measures": "Trade Value",
                  "limit": f"{PAGE},{offset}", **(cuts or {})}
        j = _get(OEC, params).json()
        if j.get("error"):
            raise RuntimeError(j)
        cols = j.get("columns", cols)
        batch = j.get("data", [])
        rows.extend(batch)
        total = j.get("page", {}).get("total", len(rows))
        print(f"    {cube} {drilldowns} {cuts or ''}: {len(rows)}/{total}")
        offset += PAGE
        if not batch or len(rows) >= total:
            return cols, rows


def write_csv_gz(path: Path, header: list[str], rows: list[list]) -> None:
    with gzip.open(path, "wt", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def _hs6(hs_id) -> str:
    """OEC HS6 ID = section number prefix + 6-digit code (e.g. 7401110 -> 401110)."""
    return str(hs_id)[-6:]


# --------------------------------------------------------------------------- datasets

def ds_oec_trade_by_year(name: str, cube: str, cuts: dict | None, years_note: str) -> None:
    cols, rows = oec_query(cube, "HS6,Year", cuts)
    out = [[_hs6(r["HS6 ID"]), r["HS6"], r["Year"], round(r["Trade Value"], 2)] for r in rows]
    write_csv_gz(RAW / f"{name}.csv.gz", ["hs6", "hs6_name", "year", "value_usd"], out)
    _record(name, source="CEPII BACI via OEC API", url=OEC, cube=cube, cuts=cuts or {}, rows=len(out),
            years=years_note, licence="BACI: Etalab Open Licence 2.0")


def ds_oec_country_totals(name: str, cube: str, side: str) -> None:
    cols, rows = oec_query(cube, f"{side} Country,Year")
    out = [[r[f"{side} Country ID"], r[f"{side} Country"], r["Year"], round(r["Trade Value"], 2)] for r in rows]
    write_csv_gz(RAW / f"{name}.csv.gz", ["country_id", "country", "year", "value_usd"], out)
    _record(name, source="CEPII BACI via OEC API", url=OEC, cube=cube, side=side, rows=len(out))


def ds_oec_partner(name: str, cube: str, drill_side: str, cuts: dict) -> None:
    cols, rows = oec_query(cube, f"HS6,{drill_side} Country", cuts)
    out = [[_hs6(r["HS6 ID"]), r[f"{drill_side} Country ID"], r[f"{drill_side} Country"], round(r["Trade Value"], 2)]
           for r in rows]
    write_csv_gz(RAW / f"{name}.csv.gz", ["hs6", "country_id", "country", "value_usd"], out)
    _record(name, source="CEPII BACI via OEC API", url=OEC, cube=cube, cuts=cuts, rows=len(out))


def ds_wits_tariffs(name: str, year: int) -> None:
    url = (f"https://wits.worldbank.org/API/V1/SDMX/V21/datasource/TRN/reporter/356/partner/000/"
           f"product/all/year/{year}/datatype/reported?format=JSON")
    j = _get(url, timeout=300).json()
    st = j["structure"]
    series_dims = st["dimensions"]["series"]
    prods = next(d for d in series_dims if d["id"] == "PRODUCTCODE")["values"]
    obs_attrs = st.get("attributes", {}).get("observation", [])
    attr_names = [a["id"] for a in obs_attrs]
    series = j["dataSets"][0]["series"]
    # WITS' series keys do not follow the declared keyPosition, so locate the product
    # index as the key part that actually varies (every other dimension has one value).
    parts = [k.split(":") for k in series]
    prod_pos = max(range(len(parts[0])), key=lambda i: len({p[i] for p in parts}))
    out = []
    for key, s in series.items():
        idx = int(key.split(":")[prod_pos])
        p = prods[idx]
        for _, ob in s["observations"].items():
            rec = {"hs6": p["id"], "name": p["name"], "value": ob[0]}
            for k, aidx in zip(attr_names, ob[1:]):
                vals = obs_attrs[attr_names.index(k)].get("values", [])
                rec[k] = vals[aidx]["name"] if isinstance(aidx, int) and aidx < len(vals) else aidx
            out.append(rec)
    header = ["hs6", "name", "value"] + attr_names
    with open(RAW / f"{name}.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(out)
    _record(name, source="World Bank WITS - UNCTAD TRAINS (India MFN applied, reported)", url=url,
            rows=len(out), attributes=attr_names)


DATASETS = {
    # world trade per product (sum over all reporters) - RCA denominators and world market size
    "oec_world_hs6_hs22": lambda: ds_oec_trade_by_year("oec_world_hs6_hs22", "trade_i_baci_a_22", None, "2022-2024"),
    "oec_world_hs6_hs17": lambda: ds_oec_trade_by_year("oec_world_hs6_hs17", "trade_i_baci_a_17", None, "2018-2024"),
    # India's exports / imports per product per year
    "oec_india_exp_hs6_hs22": lambda: ds_oec_trade_by_year("oec_india_exp_hs6_hs22", "trade_i_baci_a_22", {"Exporter Country": INDIA}, "2022-2024"),
    "oec_india_imp_hs6_hs22": lambda: ds_oec_trade_by_year("oec_india_imp_hs6_hs22", "trade_i_baci_a_22", {"Importer Country": INDIA}, "2022-2024"),
    "oec_india_exp_hs6_hs17": lambda: ds_oec_trade_by_year("oec_india_exp_hs6_hs17", "trade_i_baci_a_17", {"Exporter Country": INDIA}, "2018-2024"),
    "oec_india_imp_hs6_hs17": lambda: ds_oec_trade_by_year("oec_india_imp_hs6_hs17", "trade_i_baci_a_17", {"Importer Country": INDIA}, "2018-2024"),
    # every country's total exports/imports per year (RCA: X_i and X_w)
    "oec_country_exp_totals_hs22": lambda: ds_oec_country_totals("oec_country_exp_totals_hs22", "trade_i_baci_a_22", "Exporter"),
    "oec_country_imp_totals_hs22": lambda: ds_oec_country_totals("oec_country_imp_totals_hs22", "trade_i_baci_a_22", "Importer"),
    "oec_country_exp_totals_hs17": lambda: ds_oec_country_totals("oec_country_exp_totals_hs17", "trade_i_baci_a_17", "Exporter"),
    # partner detail, latest year: India's destinations and suppliers per product
    "oec_india_exp_partners_2024": lambda: ds_oec_partner("oec_india_exp_partners_2024", "trade_i_baci_a_22", "Importer", {"Year": str(LATEST_YEAR), "Exporter Country": INDIA}),
    "oec_india_imp_partners_2024": lambda: ds_oec_partner("oec_india_imp_partners_2024", "trade_i_baci_a_22", "Exporter", {"Year": str(LATEST_YEAR), "Importer Country": INDIA}),
    # global structure, latest year: every exporter / importer per product (top suppliers, India's rank, markets, HHI)
    "oec_world_exporters_2024": lambda: ds_oec_partner("oec_world_exporters_2024", "trade_i_baci_a_22", "Exporter", {"Year": str(LATEST_YEAR)}),
    "oec_world_importers_2024": lambda: ds_oec_partner("oec_world_importers_2024", "trade_i_baci_a_22", "Importer", {"Year": str(LATEST_YEAR)}),
    # India applied MFN tariffs (HS6 averages of national tariff lines)
    "wits_india_mfn_2022": lambda: ds_wits_tariffs("wits_india_mfn_2022", 2022),
}


def _exists(name: str) -> bool:
    return (RAW / f"{name}.csv.gz").exists() or (RAW / f"{name}.csv").exists()


def main(argv: list[str]) -> int:
    force = "--force" in argv
    names = [a for a in argv if not a.startswith("--")] or list(DATASETS)
    RAW.mkdir(parents=True, exist_ok=True)
    failed = []
    for n in names:
        if n not in DATASETS:
            print(f"unknown dataset {n}; choose from {list(DATASETS)}")
            return 2
        if _exists(n) and not force:
            print(f"= {n} (cached)")
            continue
        print(f"> {n}")
        t = time.time()
        try:
            DATASETS[n]()
            print(f"  done in {time.time() - t:.0f}s")
        except Exception as e:  # keep going; report at the end
            print(f"  FAILED: {e}")
            failed.append(n)
    if failed:
        print("FAILED:", failed)
        return 1
    print("all sources present")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
